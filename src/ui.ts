// Окна облака: вход и регистрация (с тарифами и фразой восстановления),
// восстановление по фразе, выбор vault'а, приглашение устройства (QR и код),
// подключение по коду, пароль аккаунта.

import { type App, Modal, Notice, Setting } from "obsidian";

import { passwordStrength, qrModules } from "../core/plugin/pkg/selfsync_wasm.js";
import { formatBytes } from "../core/plugin/src/i18n.ts";
import { qrSvg } from "../core/plugin/src/ui/join.ts";
import { phraseError } from "../core/plugin/src/ui/recovery.ts";
import { errorText, t } from "./i18n.ts";
import type SelfsyncCloudPlugin from "./main.ts";
import { REGIONS } from "./regions.ts";
import { tariffLimits } from "./settings.ts";

/** Порог стойкости пароля, бит (как у пароля шифрования в selfsync). */
const WEAK_BITS = 50;

/** Пароль аккаунта слишком простой: он же защищает ключ шифрования. */
function weak(password: string): boolean {
  return password.length < 10 || passwordStrength(password) < WEAK_BITS;
}

/** Код приглашения группами по четыре: проще продиктовать и ввести. */
export function formatCode(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

abstract class Form extends Modal {
  protected error!: HTMLElement;
  private busy = false;

  protected header(title: string, desc?: string): void {
    this.setTitle(title);
    if (desc) this.contentEl.createEl("p", { text: desc });
  }

  protected footer(submit: string): void {
    this.error = this.contentEl.createEl("p", { cls: "mod-warning" });
    new Setting(this.contentEl).addButton((b) => b.setButtonText(submit).setCta().onClick(() => void this.run()));
  }

  protected text(name: string, value: string, set: (v: string) => void, secret = false, desc?: string): void {
    const s = new Setting(this.contentEl).setName(name);
    if (desc) s.setDesc(desc);
    s.addText((x) => {
      if (secret) x.inputEl.type = "password";
      x.setValue(value).onChange(set);
      x.inputEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") void this.run();
      });
    });
  }

  protected region(get: () => string, set: (v: string) => void): void {
    new Setting(this.contentEl).setName(t("region.name")).addDropdown((d) => {
      for (const r of REGIONS) d.addOption(r, r === "cis" ? t("region.cis") : t("region.eu"));
      d.setValue(get()).onChange(set);
    });
  }

  /** Отправка: ошибка остаётся в окне, успех закрывает его. */
  private async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error.setText(t("auth.working"));
    try {
      const err = await this.submit();
      if (err) this.error.setText(err);
      else this.close();
    } catch (e) {
      this.error.setText(errorText(e));
    } finally {
      this.busy = false;
    }
  }

  /** `null` — готово, строка — ошибка для показа. */
  protected abstract submit(): Promise<string | null>;

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Первый шаг: регистрация, вход, код приглашения или восстановление. */
export class StartModal extends Modal {
  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
    private mode: "start" | "recover" = "start",
  ) {
    super(app);
  }

  override onOpen(): void {
    if (this.mode === "recover") {
      this.close();
      new RecoverModal(this.app, this.plugin).open();
      return;
    }
    this.setTitle(t("start.title"));
    this.contentEl.createEl("p", { text: t("account.intro") });
    const go = (m: Modal) => {
      this.close();
      m.open();
    };
    new Setting(this.contentEl)
      .addButton((b) => b.setButtonText(t("account.register")).setCta().onClick(() => go(new AuthModal(this.app, this.plugin, "register"))))
      .addButton((b) => b.setButtonText(t("account.login")).onClick(() => go(new AuthModal(this.app, this.plugin, "login"))))
      .addButton((b) => b.setButtonText(t("account.haveCode")).onClick(() => go(new CodeModal(this.app, this.plugin))));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Регистрация и вход. После них — фраза (регистрация) и выбор vault'а. */
export class AuthModal extends Form {
  private email: string;
  private password = "";
  private confirm = "";
  private regionId: string;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
    private mode: "register" | "login",
  ) {
    super(app);
    this.email = plugin.settings.email;
    this.regionId = plugin.settings.region;
  }

  override onOpen(): void {
    const reg = this.mode === "register";
    this.header(reg ? t("auth.registerTitle") : t("auth.loginTitle"));
    this.region(
      () => this.regionId,
      (v) => {
        this.regionId = v;
        if (reg) void this.showTariffs();
      },
    );
    this.text(t("auth.email"), this.email, (v) => (this.email = v.trim()));
    const hint = reg ? t("auth.passwordDesc") : undefined;
    this.text(t("auth.password"), "", (v) => (this.password = v), true, hint);
    if (reg) {
      this.text(t("auth.confirm"), "", (v) => (this.confirm = v), true);
      this.tariffs = this.contentEl.createDiv();
      void this.showTariffs();
    } else {
      this.contentEl.createEl("a", { text: t("auth.forgot"), href: "#" }).addEventListener("click", (e) => {
        e.preventDefault();
        this.close();
        new RecoverModal(this.app, this.plugin, this.email, this.regionId).open();
      });
    }
    this.footer(reg ? t("account.register") : t("account.login"));
  }

  private tariffs: HTMLElement | undefined;
  /** Номер последнего запроса тарифов: ответ по прежнему региону не рисуется. */
  private tariffsSeq = 0;

  /** Тарифы региона: недоступные — затемнены с пометкой «скоро». */
  private async showTariffs(): Promise<void> {
    const el = this.tariffs;
    if (!el) return;
    const seq = ++this.tariffsSeq;
    el.empty();
    if (!this.plugin.cloud.server(this.regionId)) {
      el.createEl("p", { text: t("account.notOpen"), cls: "mod-warning" });
      return;
    }
    try {
      const info = await this.plugin.cloud.loadInfo(this.regionId);
      if (seq !== this.tariffsSeq) return;
      el.empty();
      if (!info.registration_open) el.createEl("p", { text: t("auth.closed"), cls: "mod-warning" });
      for (const x of info.tariffs) {
        const s = new Setting(el).setName([x.title, x.price, x.status === "soon" ? `· ${t("tariff.soon")}` : ""].filter(Boolean).join(" ")).setDesc(tariffLimits(x));
        if (x.status === "soon") s.settingEl.addClass("selfsync-cloud-soon");
      }
    } catch (e) {
      if (seq !== this.tariffsSeq) return;
      el.empty();
      el.createEl("p", { text: errorText(e), cls: "mod-warning" });
    }
  }

  protected async submit(): Promise<string | null> {
    const cloud = this.plugin.cloud;
    if (!cloud.server(this.regionId)) return t("account.notOpen");
    // Устройство уже синхронизирует vault — выбирать нечего.
    const pick = () => {
      if (!this.plugin.settings.vault) new VaultModal(this.app, this.plugin).open();
    };
    if (this.mode === "login") {
      await cloud.login(this.regionId, this.email, this.password);
      pick();
      return null;
    }
    if (this.password !== this.confirm) return t("auth.mismatch");
    if (weak(this.password)) return t("auth.weak");
    const words = await cloud.register(this.regionId, this.email, this.password);
    new PhraseModal(this.app, words, pick).open();
    return null;
  }
}

/** Фраза восстановления: показывается один раз, закрыть — только записав. */
export class PhraseModal extends Modal {
  private written = false;
  private done = false;

  constructor(
    app: App,
    private words: string[],
    private then: () => void,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("phrase.title"));
    const { contentEl } = this;
    contentEl.createEl("p", { text: t("phrase.desc") });
    const list = contentEl.createEl("ol", { cls: "selfsync-cloud-phrase" });
    for (const w of this.words) list.createEl("li", { text: w });
    new Setting(contentEl).addButton((b) => b.setButtonText(t("phrase.copy")).onClick(() => void navigator.clipboard.writeText(this.words.join(" "))));
    new Setting(contentEl).setName(t("phrase.written")).addToggle((x) => x.onChange((v) => (this.written = v)));
    new Setting(contentEl).addButton((b) =>
      b
        .setButtonText(t("phrase.done"))
        .setCta()
        .onClick(() => {
          if (!this.written) return;
          this.done = true;
          this.close();
          this.then();
        }),
    );
  }

  override onClose(): void {
    // Слова не держим в DOM дольше нужного.
    this.contentEl.empty();
    if (this.done) return;
    // Esc и клик мимо окна тоже закрывают его, а фраза больше нигде не покажется.
    if (this.written) this.then();
    else new PhraseModal(this.app, this.words, this.then).open();
  }
}

/** Забытый пароль: email, фраза и новый пароль. */
export class RecoverModal extends Form {
  private phrase = "";
  private password = "";

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
    private email = plugin.settings.email,
    private regionId = plugin.settings.region,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.header(t("recover.title"), t("recover.desc"));
    this.region(
      () => this.regionId,
      (v) => (this.regionId = v),
    );
    this.text(t("auth.email"), this.email, (v) => (this.email = v.trim()));
    new Setting(this.contentEl).setName(t("recover.phrase")).addTextArea((x) => {
      x.inputEl.rows = 4;
      x.onChange((v) => (this.phrase = v));
    });
    this.text(t("auth.password"), "", (v) => (this.password = v), true, t("auth.passwordDesc"));
    this.footer(t("recover.submit"));
  }

  protected async submit(): Promise<string | null> {
    const bad = phraseError(this.phrase);
    if (bad) return bad;
    if (weak(this.password)) return t("auth.weak");
    if (!this.plugin.cloud.server(this.regionId)) return t("account.notOpen");
    await this.plugin.cloud.recover(this.regionId, this.email, this.phrase, this.password);
    new Notice(t("recover.done"));
    if (this.plugin.settings.vault) await this.plugin.cloud.unlock();
    else new VaultModal(this.app, this.plugin).open();
    return null;
  }
}

/** Выбор vault'а аккаунта для этого vault'а Obsidian или создание нового. */
export class VaultModal extends Modal {
  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("vault.pickTitle"));
    this.render("");
  }

  /** Список vault'ов аккаунта; после ошибки — заново: vault мог уже создаться. */
  private render(error: string): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("p", { text: t("vault.pickDesc") });
    const cloud = this.plugin.cloud;
    const a = cloud.account;
    if (!a) return;
    contentEl.createEl("p", { text: error, cls: "mod-warning" });
    const act = async (f: () => Promise<void>) => {
      try {
        await f();
        this.close();
      } catch (e) {
        this.render(errorText(e));
      }
    };
    if (a.vaults.length === 0) contentEl.createEl("p", { text: t("vault.none") });
    for (const v of a.vaults) {
      new Setting(contentEl)
        .setName(v.label)
        .setDesc(t("vault.connectDesc", { used: formatBytes(v.used_bytes), date: new Date(v.created_at).toLocaleDateString() }))
        .addButton((b) => b.setButtonText(t("vault.connect")).onClick(() => act(() => cloud.connectVault(v.name))));
    }
    const full = a.tariff.vaults > 0 && a.vaults.length >= a.tariff.vaults;
    let label = this.app.vault.getName();
    const create = new Setting(contentEl).setName(t("vault.create")).setDesc(full ? t("vault.limit", { n: a.tariff.vaults }) : t("vault.createDesc"));
    if (!full) {
      create.addText((x) => x.setValue(label).onChange((v) => (label = v.trim())));
      create.addButton((b) => b.setButtonText(t("vault.create")).setCta().onClick(() => act(() => cloud.createVault(label || this.app.vault.getName()))));
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Приглашение: QR (с паролем vault'а — устройство откроет vault сразу) и
 *  текстовый код (без него — спросит пароль аккаунта). */
export class InviteModal extends Modal {
  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("invite.title"));
    void this.show();
  }

  private async show(): Promise<void> {
    const { contentEl } = this;
    try {
      const inv = await this.plugin.cloud.invite("");
      contentEl.createEl("p", { text: t("invite.desc", { until: new Date(inv.expiresAt).toLocaleTimeString() }) });
      contentEl.appendChild(qrSvg(document, qrModules(inv.uri)));
      const code = formatCode(inv.code);
      new Setting(contentEl)
        .setName(t("invite.code", { code }))
        .addButton((b) => b.setButtonText(t("invite.copy")).onClick(() => void navigator.clipboard.writeText(code)));
    } catch (e) {
      contentEl.createEl("p", { text: errorText(e), cls: "mod-warning" });
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Подключение по приглашению: из QR (всё уже есть) или вводом кода. */
export class CodeModal extends Form {
  private code: string;
  private regionId: string;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
    private fromQr?: { server: string; code: string; vaultPassword?: string },
  ) {
    super(app);
    this.code = fromQr?.code ?? "";
    this.regionId = plugin.settings.region;
  }

  override onOpen(): void {
    this.header(t("code.title"), this.fromQr ? undefined : t("code.desc"));
    const s = this.plugin.settings;
    if (s.token) this.contentEl.createEl("p", { text: t("code.replaces", { label: s.vaultLabel || s.vault }), cls: "mod-warning" });
    if (!this.fromQr) {
      this.region(
        () => this.regionId,
        (v) => (this.regionId = v),
      );
      this.text(t("code.code"), "", (v) => (this.code = v));
    } else {
      this.contentEl.createEl("p", { text: t("code.from", { code: formatCode(this.code), server: this.fromQr.server }) });
    }
    this.footer(t("code.submit"));
  }

  protected async submit(): Promise<string | null> {
    const cloud = this.plugin.cloud;
    const server = this.fromQr?.server ?? cloud.server(this.regionId);
    if (!server) return t("account.notOpen");
    if (!this.fromQr) this.plugin.settings.region = this.regionId;
    await cloud.redeem(server, this.code, this.fromQr?.vaultPassword);
    // Без пароля vault'а из QR ключ откроет пароль аккаунта.
    if (!this.fromQr?.vaultPassword && !(await cloud.unlock())) new UnlockModal(this.app, this.plugin).open();
    return null;
  }
}

/** Пароль аккаунта: открыть ключ на устройстве без сохранённого ключа. */
export class UnlockModal extends Form {
  private password = "";

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.header(t("unlock.title"), t("unlock.desc"));
    this.text(t("auth.password"), "", (v) => (this.password = v), true);
    this.contentEl.createEl("a", { text: t("auth.forgot"), href: "#" }).addEventListener("click", (e) => {
      e.preventDefault();
      this.close();
      new RecoverModal(this.app, this.plugin).open();
    });
    this.footer(t("unlock.submit"));
  }

  protected async submit(): Promise<string | null> {
    return (await this.plugin.cloud.unlock(this.password)) ? null : t("unlock.wrong");
  }
}

/** Подтверждение паролем (удаление аккаунта). */
export class PasswordPromptModal extends Form {
  private password = "";

  constructor(
    app: App,
    private title: string,
    private desc: string,
    private onPassword: (password: string) => Promise<string | null>,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.header(this.title, this.desc);
    this.text(t("auth.password"), "", (v) => (this.password = v), true);
    this.footer(this.title);
  }

  protected submit(): Promise<string | null> {
    return this.onPassword(this.password);
  }
}

/** Смена пароля аккаунта: текущий, новый и он же ещё раз. */
export class ChangePasswordModal extends Form {
  private old = "";
  private next = "";
  private confirm = "";

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.header(t("account.changePassword"), t("auth.passwordDesc"));
    this.text(t("account.oldPassword"), "", (v) => (this.old = v), true);
    this.text(t("account.newPassword"), "", (v) => (this.next = v), true);
    this.text(t("auth.confirm"), "", (v) => (this.confirm = v), true);
    this.footer(t("account.changePassword"));
  }

  protected async submit(): Promise<string | null> {
    if (this.next !== this.confirm) return t("auth.mismatch");
    if (weak(this.next)) return t("auth.weak");
    if (!(await this.plugin.cloud.changePassword(this.old, this.next))) return t("unlock.wrong");
    new Notice(t("account.passwordChanged"));
    return null;
  }
}
