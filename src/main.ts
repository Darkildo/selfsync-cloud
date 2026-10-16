// Плагин Selfsync Cloud: открытый плагин selfsync (core/) целиком — синк, окна
// истории, конфликтов и корзины, — плюс аккаунт облака вместо ссылок
// подключения. Шифрование обязательно: без ключа ядро ничего не отправляет.

import { moment, Notice, requestUrl } from "obsidian";

import SelfsyncPlugin from "../core/plugin/src/main.ts";
import type { Settings } from "../core/plugin/src/settings.ts";
import type { EngineConfig } from "../core/plugin/src/types.ts";
import { protocolVersion } from "../core/plugin/pkg/selfsync_wasm.js";
import type { Transport } from "./api.ts";
import { Cloud, INVITE_ACTION, LOGIN_ACTION } from "./cloud.ts";
import { errorText, setLanguage, t } from "./i18n.ts";
import { defaultRegion } from "./regions.ts";
import { CloudSettingTab } from "./settings.ts";
import { CodeModal, InviteModal, LoginCodeModal, PhraseModal, RecoverModal, StartModal, UnlockModal } from "./ui.ts";
import { confirm } from "../core/plugin/src/ui/confirm.ts";

export interface CloudSettings extends Settings {
  /** Регион аккаунта: `cis` (СНГ) или `eu` (Europe). */
  region: string;
  /** Свой адрес сервиса вместо адреса региона (проверка сервера). */
  serviceUrl: string;
  /** Email аккаунта; пусто — аккаунт без email. */
  email: string;
  /** Номер аккаунта (0 — неизвестен): отличить «другой аккаунт» при входе. */
  accountId: number;
  /** Сессия аккаунта (`cs_…`): экраны аккаунта. Синк идёт по токену устройства. */
  session: string;
  vaultLabel: string;
  /** Номер этого устройства в аккаунте (0 — неизвестен): отметка в списке устройств. */
  deviceId: number;
  /** Соль, параметры KDF и обёртка ключа аккаунта паролем: открыть ключ без сессии.
   *  Пусто — у аккаунта нет пароля, ключ открывает только QR или фраза. */
  kdf: string;
  salt: string;
  wrappedKey: string;
  hasPassword: boolean;
  /** Vault из кода аккаунта, к которому подключиться, когда откроется ключ. */
  pendingVault: string;
}

const CLOUD_DEFAULTS = {
  region: "",
  serviceUrl: "",
  email: "",
  accountId: 0,
  session: "",
  vaultLabel: "",
  deviceId: 0,
  kdf: "",
  salt: "",
  wrappedKey: "",
  hasPassword: false,
  pendingVault: "",
};

/** Ответа сервиса нет дольше — «не ответил»: окно не висит «в работе» вечно. */
const TIMEOUT_MS = 30_000;
/** Напоминание о фразе при запуске — не чаще раза в сутки. */
const REMIND_MS = 24 * 60 * 60 * 1000;
const REMIND_AT = "selfsync-cloud-phrase-reminded";

/** HTTP через Obsidian: без CORS, на мобильных тоже. */
const obsidianTransport: Transport = async (req) => {
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => reject(new Error("request timed out")), TIMEOUT_MS);
  });
  try {
    const r = await Promise.race([requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false }), timeout]);
    return { status: r.status, text: new TextDecoder().decode(r.arrayBuffer) };
  } finally {
    window.clearTimeout(timer);
  }
};

export default class SelfsyncCloudPlugin extends SelfsyncPlugin {
  declare settings: CloudSettings;
  cloud: Cloud = new Cloud(this, obsidianTransport);
  /** Ключ аккаунта с устройства уже отдан ядру в этом запуске синка. */
  private triedAccountKey = false;
  /** Строка состояния: фраза восстановления ещё не записана. */
  private phraseEl: HTMLElement | undefined;

  override async onload(): Promise<void> {
    setLanguage(moment.locale());
    await super.onload();
    this.phraseEl = this.addStatusBarItem();
    this.phraseEl.addClass("selfsync-cloud-phrase-bar", "mod-clickable");
    this.registerDomEvent(this.phraseEl, "click", () => this.showPhrase());
    this.updatePhraseBar();
  }

  override async loadSettings(): Promise<void> {
    await super.loadSettings();
    this.settings = { ...CLOUD_DEFAULTS, ...this.settings };
    // Настройки 0.1.x: пароль был у всех.
    if (this.settings.wrappedKey) this.settings.hasPassword = true;
    if (!this.settings.region) this.settings.region = defaultRegion(moment.locale());
  }

  protected override createSettingTab(): CloudSettingTab {
    return new CloudSettingTab(this.app, this);
  }

  /** Аккаунт или vault изменились (вход, подключение, выход): открытые настройки
   *  перерисовываются, данные аккаунта перечитываются, напоминание о фразе обновляется. */
  accountChanged(): void {
    (this.settingTab as CloudSettingTab | undefined)?.reload();
    this.updatePhraseBar();
  }

  override async start(): Promise<void> {
    this.triedAccountKey = false;
    await super.start();
    this.remindPhrase();
  }

  protected override registerConnect(): void {
    this.addCommand({ id: "account", name: t("cmd.account"), callback: () => this.openConnect() });
    this.addCommand({
      id: "invite",
      name: t("cmd.invite"),
      checkCallback: (checking) => {
        if (!this.settings.session && !this.settings.token) return false;
        if (!checking) new InviteModal(this.app, this).open();
        return true;
      },
    });
    this.addCommand({ id: "phrase", name: t("cmd.phrase"), checkCallback: (checking) => {
      if (!this.settings.session) return false;
      if (!checking) this.showPhrase();
      return true;
    } });
    // QR входа: адрес сервиса, код аккаунта, ключ аккаунта и vault (ключ — только в
    // ссылке). Ссылку может прислать кто угодно: чужой адрес сервиса не принимается.
    this.registerObsidianProtocolHandler(LOGIN_ACTION, (p) => {
      if (!p.s || !p.c) return;
      if (!this.cloud.trusted(p.s)) new Notice(t("code.untrusted", { server: p.s }), 0);
      else new LoginCodeModal(this.app, this, { server: p.s, code: p.c, key: p.k, vault: p.v }).open();
    });
    // Приглашение в vault от плагина 0.1.x.
    this.registerObsidianProtocolHandler(INVITE_ACTION, (p) => {
      if (!p.s || !p.c) return;
      if (!this.cloud.trusted(p.s)) new Notice(t("code.untrusted", { server: p.s }), 0);
      else new CodeModal(this.app, this, { server: p.s, code: p.c, vaultPassword: p.k }).open();
    });
  }

  protected override openConnect(): void {
    new StartModal(this.app, this).open();
  }

  override engineConfig(): EngineConfig {
    return { ...super.engineConfig(), client: `cloud/${this.manifest.version}`, requireEncryption: true };
  }

  /** Ключ vault'а выводится из ключа аккаунта: пароль спрашивается, если ключа
   *  аккаунта на устройстве нет или он уже не подошёл (ядро снова просит пароль). */
  override askPassword(): void {
    if (this.triedAccountKey) {
      new UnlockModal(this.app, this).open();
      return;
    }
    this.triedAccountKey = true;
    void this.cloud.unlock().then((ok) => {
      if (!ok) new UnlockModal(this.app, this).open();
    });
  }

  /** Забытый пароль — восстановление аккаунта, а не фраза vault'а. */
  override recover(): void {
    new RecoverModal(this.app, this).open();
  }

  /** Фраза восстановления: показать слова, которые ещё здесь, или создать новую. */
  showPhrase(): void {
    const words = this.cloud.pendingPhrase();
    if (words) {
      new PhraseModal(this.app, words, () => void this.cloud.confirmPhrase().catch((e) => new Notice(errorText(e)))).open();
      return;
    }
    if (!this.cloud.accountKey()) {
      new Notice(t("phrase.needKey"));
      return;
    }
    void confirm(this.app, t("phrase.newConfirm"), t("phrase.new")).then(async (ok) => {
      if (!ok) return;
      try {
        const fresh = await this.cloud.newPhrase();
        new PhraseModal(this.app, fresh, () => void this.cloud.confirmPhrase().catch((e) => new Notice(errorText(e)))).open();
      } catch (e) {
        new Notice(errorText(e));
      }
    });
  }

  private updatePhraseBar(): void {
    const el = this.phraseEl;
    if (!el) return;
    const status = this.cloud.phraseStatus();
    const pending = status === "pending-here" || status === "pending-elsewhere";
    el.setText(pending ? t("phrase.bar") : "");
    el.setAttribute("aria-label", pending ? t("phrase.reminder") : "");
    el.hidden = !pending;
  }

  /** Раз в сутки при запуске: фраза ещё не записана. */
  private remindPhrase(): void {
    const status = this.cloud.phraseStatus();
    if (status !== "pending-here" && status !== "pending-elsewhere") return;
    const last = Number(this.app.loadLocalStorage(REMIND_AT) ?? 0);
    if (Date.now() - last < REMIND_MS) return;
    this.app.saveLocalStorage(REMIND_AT, String(Date.now()));
    const n = new Notice(t("phrase.reminder"), 0);
    n.messageEl.onClickEvent(() => this.showPhrase());
  }

  /** Версия ядра, с которым собран плагин: тег подмодуля и протокол из WASM. */
  core(): { version: string; protocol: number } {
    return { version: __CORE_VERSION__, protocol: protocolVersion() };
  }
}
