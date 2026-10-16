// Плагин Selfsync Cloud: открытый плагин selfsync (подмодуль core/) целиком — синк,
// окна истории, конфликтов и корзины, — плюс аккаунт облака вместо ссылок
// подключения. Шифрование обязательно: без ключа ядро ничего не отправляет.

import { moment, Notice, requestUrl } from "obsidian";

import SelfsyncPlugin from "../core/plugin/src/main.ts";
import type { Settings } from "../core/plugin/src/settings.ts";
import type { EngineConfig } from "../core/plugin/src/types.ts";
import { protocolVersion } from "../core/plugin/pkg/selfsync_wasm.js";
import type { Transport } from "./api.ts";
import { Cloud, INVITE_ACTION } from "./cloud.ts";
import { setLanguage, t } from "./i18n.ts";
import { defaultRegion } from "./regions.ts";
import { CloudSettingTab } from "./settings.ts";
import { CodeModal, InviteModal, StartModal, UnlockModal } from "./ui.ts";

export interface CloudSettings extends Settings {
  /** Регион аккаунта: `cis` (СНГ) или `eu` (Europe). */
  region: string;
  /** Свой адрес сервиса вместо адреса региона (проверка сервера). */
  serviceUrl: string;
  email: string;
  /** Сессия аккаунта (`cs_…`): экраны аккаунта. Синк идёт по токену устройства. */
  session: string;
  vaultLabel: string;
  /** Соль, параметры KDF и обёртка ключа аккаунта паролем: открыть ключ без сессии. */
  kdf: string;
  salt: string;
  wrappedKey: string;
}

const CLOUD_DEFAULTS = {
  region: "",
  serviceUrl: "",
  email: "",
  session: "",
  vaultLabel: "",
  kdf: "",
  salt: "",
  wrappedKey: "",
};

/** HTTP через Obsidian: без CORS, на мобильных тоже. */
const obsidianTransport: Transport = async (req) => {
  const r = await requestUrl({ url: req.url, method: req.method, headers: req.headers, body: req.body, throw: false });
  return { status: r.status, text: new TextDecoder().decode(r.arrayBuffer) };
};

export default class SelfsyncCloudPlugin extends SelfsyncPlugin {
  declare settings: CloudSettings;
  cloud: Cloud = new Cloud(this, obsidianTransport);

  override async onload(): Promise<void> {
    setLanguage(moment.locale());
    await super.onload();
  }

  override async loadSettings(): Promise<void> {
    await super.loadSettings();
    this.settings = { ...CLOUD_DEFAULTS, ...this.settings };
    if (!this.settings.region) this.settings.region = defaultRegion(moment.locale());
  }

  protected override createSettingTab(): CloudSettingTab {
    return new CloudSettingTab(this.app, this);
  }

  protected override registerConnect(): void {
    this.addCommand({ id: "account", name: t("cmd.account"), callback: () => this.openConnect() });
    this.addCommand({
      id: "invite",
      name: t("cmd.invite"),
      checkCallback: (checking) => {
        if (!this.runner || !this.settings.vault) return false;
        if (!checking) new InviteModal(this.app, this).open();
        return true;
      },
    });
    // QR приглашения: адрес сервиса, код и пароль vault'а (он только в ссылке).
    // Ссылку может прислать кто угодно: чужой адрес сервиса не принимается.
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

  /** Ключ vault'а выводится из ключа аккаунта: пароль спрашивается, только если
   *  ключа аккаунта на устройстве нет. */
  override askPassword(): void {
    void this.cloud.unlock().then((ok) => {
      if (!ok) new UnlockModal(this.app, this).open();
    });
  }

  /** Забытый пароль — восстановление аккаунта, а не фраза vault'а. */
  override recover(): void {
    new StartModal(this.app, this, "recover").open();
  }

  /** Версия ядра, с которым собран плагин: тег подмодуля и протокол из WASM. */
  core(): { version: string; protocol: number } {
    return { version: __CORE_VERSION__, protocol: protocolVersion() };
  }
}
