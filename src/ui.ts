// Окна облака: старт (аккаунт одним нажатием или вход в существующий), вход кодом,
// фразой и паролем, фраза восстановления, выбор vault'а, код для нового устройства,
// пароль аккаунта.

import { type App, Modal, Notice, Setting } from "obsidian";

import { passwordStrength, qrModules } from "../core/plugin/pkg/selfsync_wasm.js";
import { formatBytes } from "../core/plugin/src/i18n.ts";
import { qrSvg } from "../core/plugin/src/ui/join.ts";
import { phraseError } from "../core/plugin/src/ui/recovery.ts";
import { errorText, t } from "./i18n.ts";
import type SelfsyncCloudPlugin from "./main.ts";
import { REGIONS, TERMS_URL } from "./regions.ts";

/** Порог стойкости пароля, бит (как у пароля шифрования в selfsync). */
const WEAK_BITS = 50;

/** Пароль аккаунта слишком простой: он же защищает ключ шифрования. */
function weak(password: string): boolean {
  return password.length < 10 || passwordStrength(password) < WEAK_BITS;
}

/** Код группами по четыре: проще продиктовать и ввести. */
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
    new Setting(this.contentEl)
      .setName(t("region.name"))
      .setDesc(t("region.desc"))
      .addDropdown((d) => {
        for (const r of REGIONS) d.addOption(r, r === "cis" ? t("region.cis") : t("region.eu"));
        d.setValue(get()).onChange(set);
      });
  }

  /** Отправка: ошибка остаётся в окне, успех закрывает его. */
  protected async run(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.error.setText(t("auth.working"));
    // Argon2 занимает главный поток на секунды: сначала дать нарисовать «Вывожу ключи…».
    await new Promise((r) => window.requestAnimationFrame(() => window.setTimeout(r, 0)));
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

/** Первый экран: начать одним нажатием (регион явно) или войти в существующий аккаунт. */
export class StartModal extends Form {
  private regionId: string;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
    this.regionId = plugin.settings.region;
  }

  override onOpen(): void {
    this.header(t("start.title"), t("start.desc"));
    this.region(
      () => this.regionId,
      (v) => (this.regionId = v),
    );
    const terms = this.contentEl.createEl("p", { cls: "setting-item-description" });
    terms.appendText(`${t("start.terms")} `);
    if (TERMS_URL) terms.createEl("a", { text: t("start.termsLink"), href: TERMS_URL });
    else terms.appendText(t("start.termsLink"));
    this.footer(t("start.begin"));
    new Setting(this.contentEl).setName(t("start.haveAccount")).addButton((b) =>
      b.setButtonText(t("start.signIn")).onClick(() => {
        this.close();
        new ExistingModal(this.app, this.plugin).open();
      }),
    );
  }

  protected async submit(): Promise<string | null> {
    const cloud = this.plugin.cloud;
    if (!cloud.server(this.regionId)) return t("account.notOpen");
    if (this.plugin.settings.session) return t("start.alreadySignedIn");
    await cloud.start(this.regionId, this.app.vault.getName());
    new Notice(t("start.done"), 10000);
    return null;
  }
}

/** Вход в существующий аккаунт: QR с другого устройства, код, фраза или email с паролем. */
export class ExistingModal extends Modal {
  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.setTitle(t("existing.title"));
    this.contentEl.createEl("p", { text: t("existing.qr") });
    const go = (m: Modal) => {
      this.close();
      m.open();
    };
    new Setting(this.contentEl)
      .setName(t("existing.code"))
      .setDesc(t("existing.codeDesc"))
      .addButton((b) => b.setButtonText(t("existing.codeButton")).setCta().onClick(() => go(new LoginCodeModal(this.app, this.plugin))));
    new Setting(this.contentEl)
      .setName(t("existing.phrase"))
      .setDesc(t("existing.phraseDesc"))
      .addButton((b) => b.setButtonText(t("existing.phraseButton")).onClick(() => go(new PhraseLoginModal(this.app, this.plugin))));
    new Setting(this.contentEl)
      .setName(t("existing.password"))
      .setDesc(t("existing.passwordDesc"))
      .addButton((b) => b.setButtonText(t("account.login")).onClick(() => go(new LoginModal(this.app, this.plugin))));
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** После входа: подключить vault из кода или выбрать. */
function afterSignIn(app: App, plugin: SelfsyncCloudPlugin): void {
  if (plugin.settings.vault) return;
  if (plugin.settings.pendingVault) {
    void plugin.cloud.unlock().then((ok) => {
      if (!ok) new VaultModal(app, plugin).open();
    });
    return;
  }
  new VaultModal(app, plugin).open();
}

/** Вход по email и паролю — для аккаунтов, где они заданы. */
export class LoginModal extends Form {
  private email: string;
  private password = "";
  private regionId: string;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
    this.email = plugin.settings.email;
    this.regionId = plugin.settings.region;
  }

  override onOpen(): void {
    this.header(t("auth.loginTitle"));
    this.region(
      () => this.regionId,
      (v) => (this.regionId = v),
    );
    this.text(t("auth.email"), this.email, (v) => (this.email = v.trim()));
    this.text(t("auth.password"), "", (v) => (this.password = v), true);
    this.contentEl.createEl("a", { text: t("auth.forgot"), href: "#" }).addEventListener("click", (e) => {
      e.preventDefault();
      this.close();
      new RecoverModal(this.app, this.plugin, this.email, this.regionId).open();
    });
    this.footer(t("account.login"));
  }

  protected async submit(): Promise<string | null> {
    const cloud = this.plugin.cloud;
    if (!cloud.server(this.regionId)) return t("account.notOpen");
    await cloud.login(this.regionId, this.email, this.password);
    afterSignIn(this.app, this.plugin);
    return null;
  }
}

/** Фраза восстановления: показывается, закрыть — только записав. */
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
    new Setting(contentEl)
      .addButton((b) => b.setButtonText(t("phrase.later")).onClick(() => this.closeLater()))
      .addButton((b) =>
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

  /** Отложить: слова остаются на устройстве, напоминание продолжает висеть. */
  private closeLater(): void {
    this.done = true;
    this.close();
  }

  override onClose(): void {
    // Слова не держим в DOM дольше нужного.
    this.contentEl.empty();
    if (this.done) return;
    // Esc и клик мимо окна: фраза остаётся на устройстве, показать можно снова.
    if (this.written) this.then();
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
    else afterSignIn(this.app, this.plugin);
    return null;
  }
}

/** Вход фразой восстановления: без email и пароля. */
export class PhraseLoginModal extends Form {
  private phrase = "";
  private regionId: string;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
    this.regionId = plugin.settings.region;
  }

  override onOpen(): void {
    this.header(t("phraseLogin.title"), t("phraseLogin.desc"));
    this.region(
      () => this.regionId,
      (v) => (this.regionId = v),
    );
    new Setting(this.contentEl).setName(t("recover.phrase")).addTextArea((x) => {
      x.inputEl.rows = 4;
      x.onChange((v) => (this.phrase = v));
    });
    this.footer(t("account.login"));
  }

  protected async submit(): Promise<string | null> {
    const bad = phraseError(this.phrase);
    if (bad) return bad;
    const cloud = this.plugin.cloud;
    if (!cloud.server(this.regionId)) return t("account.notOpen");
    await cloud.loginPhrase(this.regionId, this.phrase);
    if (this.plugin.settings.vault) await cloud.unlock();
    else afterSignIn(this.app, this.plugin);
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

/** Код для нового устройства: QR с ключом аккаунта (устройство войдёт сразу) и
 *  текстовый код (без ключа — спросит пароль или фразу). */
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
    const cloud = this.plugin.cloud;
    const status = cloud.phraseStatus();
    if (status === "pending-here" || status === "pending-elsewhere") {
      const warn = contentEl.createEl("p", { cls: "mod-warning" });
      warn.appendText(`${t("invite.phraseFirst")} `);
      warn.createEl("a", { text: t("invite.phraseShow"), href: "#" }).addEventListener("click", (e) => {
        e.preventDefault();
        this.close();
        this.plugin.showPhrase();
      });
    }
    try {
      const inv = await cloud.accountCode("");
      const until = new Date(inv.expiresAt).toLocaleTimeString();
      const how = this.plugin.settings.hasPassword ? t("invite.codePassword") : t("invite.codePhrase");
      contentEl.createEl("p", { text: t(inv.withKey ? "invite.desc" : "invite.descNoKey", { until, how }) });
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

/** Вход кодом аккаунта: из QR (ключ в ссылке) или вводом кода. Без ключа в
 *  ссылке ключ откроет пароль аккаунта или фраза. */
export class LoginCodeModal extends Form {
  private code: string;
  private regionId: string;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
    private fromQr?: { server: string; code: string; key?: string; vault?: string },
  ) {
    super(app);
    this.code = fromQr?.code ?? "";
    this.regionId = plugin.settings.region;
  }

  override onOpen(): void {
    this.header(t("loginCode.title"), this.fromQr ? undefined : t("loginCode.desc"));
    const s = this.plugin.settings;
    if (s.token) this.contentEl.createEl("p", { text: t("code.replaces", { label: s.vaultLabel || s.vault }), cls: "mod-warning" });
    if (!this.fromQr) {
      this.region(
        () => this.regionId,
        (v) => (this.regionId = v),
      );
      this.text(t("loginCode.code"), "", (v) => (this.code = v));
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
    const r = await cloud.redeemAccount(server, this.code, { key: this.fromQr?.key, vault: this.fromQr?.vault });
    if (r.key) {
      if (!r.vault) new VaultModal(this.app, this.plugin).open();
      return null;
    }
    // Ключа в ссылке нет: пароль, если он есть у аккаунта, иначе фраза.
    if (r.password) new UnlockModal(this.app, this.plugin).open();
    else new PhraseLoginModal(this.app, this.plugin).open();
    return null;
  }
}

/** Подключение по приглашению в vault (плагин 0.1.x): из QR или вводом кода. */
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

/** Открыть ключ аккаунта на устройстве без сохранённого ключа: паролем, а у
 *  аккаунта без пароля — фразой. */
export class UnlockModal extends Form {
  private password = "";

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    const s = this.plugin.settings;
    if (!s.hasPassword) {
      this.header(t("unlock.title"), t("unlock.phraseDesc"));
      new Setting(this.contentEl).addButton((b) =>
        b
          .setButtonText(t("existing.phraseButton"))
          .setCta()
          .onClick(() => {
            this.close();
            new PhraseLoginModal(this.app, this.plugin).open();
          }),
      );
      this.error = this.contentEl.createEl("p", { cls: "mod-warning" });
      return;
    }
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

/** Подтверждение паролем (удаление аккаунта у аккаунта с паролем). */
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

/** Email и пароль аккаунту без них: вход вводом на любом устройстве. */
export class EmailPasswordModal extends Form {
  private email = "";
  private password = "";
  private confirm = "";

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.header(t("email.title"), t("email.desc"));
    this.text(t("auth.email"), "", (v) => (this.email = v.trim()));
    this.text(t("auth.password"), "", (v) => (this.password = v), true, t("auth.passwordDesc"));
    this.text(t("auth.confirm"), "", (v) => (this.confirm = v), true);
    this.footer(t("email.submit"));
  }

  protected async submit(): Promise<string | null> {
    if (this.password !== this.confirm) return t("auth.mismatch");
    if (weak(this.password)) return t("auth.weak");
    await this.plugin.cloud.setEmailPassword(this.email, this.password);
    new Notice(t("email.done"));
    return null;
  }
}
