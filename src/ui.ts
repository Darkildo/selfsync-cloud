// Окна облака: старт (аккаунт одним нажатием или вход в существующий), вход кодом,
// фразой и паролем, фраза восстановления, выбор vault'а, код для нового устройства,
// пароль аккаунта.

import { type App, Modal, Notice, Setting } from "obsidian";

import { passwordStrength, qrModules } from "../core/plugin/pkg/selfsync_wasm.js";
import { formatBytes } from "../core/plugin/src/i18n.ts";
import { qrSvg } from "../core/plugin/src/ui/join.ts";
import { phraseError } from "../core/plugin/src/ui/recovery.ts";
import type { JoinerHandoff, OwnerHandoff, OwnerStep } from "./cloud.ts";
import { errorText, formatDate, formatTime, t } from "./i18n.ts";
import type SelfsyncCloudPlugin from "./main.ts";
import { poll } from "./poll.ts";
import { REGIONS, TERMS_URL } from "./regions.ts";

/** Строка с несколькими кнопками: на телефоне они переносятся (правило ядра `.selfsync-actions`, core/plugin/styles.css). */
export function actions(s: Setting): Setting {
  s.settingEl.addClass("selfsync-actions");
  return s;
}

/** Порог стойкости пароля, бит (как у пароля шифрования в selfsync). */
const WEAK_BITS = 50;

/** Пароль аккаунта слишком простой: он же защищает ключ шифрования. */
function weak(password: string): boolean {
  return password.length < 10 || passwordStrength(password) < WEAK_BITS;
}

/** Обмен у сервера живёт 10 минут с кода и ещё 10 со входа нового устройства. */
const OWNER_MS = 21 * 60 * 1000;
const JOINER_MS = 11 * 60 * 1000;

/** Цифры сверки парами по три: «123 456». */
function sasText(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
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
      // Email, пароль и код — латиница и цифры: слева направо и в арабском интерфейсе.
      x.inputEl.dir = "ltr";
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
    actions(new Setting(contentEl))
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
      x.inputEl.dir = "ltr";
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
      x.inputEl.dir = "ltr";
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
        .setDesc(t("vault.connectDesc", { used: formatBytes(v.used_bytes), date: formatDate(v.created_at) }))
        .addButton((b) => b.setButtonText(t("vault.connect")).onClick(() => act(() => cloud.connectVault(v.name))));
    }
    const full = a.tariff.vaults > 0 && a.vaults.length >= a.tariff.vaults;
    let label = this.app.vault.getName();
    const create = actions(new Setting(contentEl)).setName(t("vault.create")).setDesc(full ? t("vault.limit", { n: a.tariff.vaults }) : t("vault.createDesc"));
    if (!full) {
      create.addText((x) => x.setValue(label).onChange((v) => (label = v.trim())));
      create.addButton((b) => b.setButtonText(t("vault.create")).setCta().onClick(() => act(() => cloud.createVault(label || this.app.vault.getName()))));
    }
  }

  override onClose(): void {
    this.contentEl.empty();
  }
}

/** Код для нового устройства: QR (устройство войдёт и получит ключ обменом сразу)
 *  и текстовый код (ключ — обменом после сверки цифр). Без ключа на этом
 *  устройстве кода нет. Пока окно открыто, идёт обмен. */
export class InviteModal extends Modal {
  private alive = false;
  /** Обмен этого окна: закрыли до передачи ключа — отменить на сервере. */
  private handoff?: OwnerHandoff;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.alive = true;
    this.plugin.modals.add(this);
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
    // Ключ новому устройству передаёт только устройство, на котором он есть.
    if (!cloud.accountKey()) {
      contentEl.createEl("p", { text: t("invite.needKey"), cls: "mod-warning" });
      return;
    }
    try {
      const inv = await cloud.accountCode("");
      const until = formatTime(inv.expiresAt);
      contentEl.createEl("p", { text: t("invite.desc", { until }) });
      contentEl.appendChild(qrSvg(document, qrModules(inv.uri)));
      const code = formatCode(inv.code);
      new Setting(contentEl)
        .setName(t("invite.code", { code }))
        .addButton((b) => b.setButtonText(t("invite.copy")).onClick(() => void navigator.clipboard.writeText(code)));
      this.handoff = inv.handoff;
      void this.watch(inv.handoff, contentEl.createDiv());
    } catch (e) {
      contentEl.createEl("p", { text: errorText(e), cls: "mod-warning" });
    }
  }

  /** Обмен ключом, пока окно открыто: ждать новое устройство, по QR передать
   *  ключ сразу, по коду вручную — после сверки цифр. */
  private async watch(h: OwnerHandoff, el: HTMLElement, confirmed = false): Promise<void> {
    const status = el.createEl("p", { text: t("handoff.ownerWaiting") });
    const got: { step?: OwnerStep } = {};
    const end = await poll(
      async () => {
        const step = await this.plugin.cloud.ownerStep(h, confirmed);
        if (step.state !== "waiting") got.step = step;
        else status.setText(t("handoff.ownerWaiting"));
        return step.state !== "waiting";
      },
      // Нет связи — пробовать дальше, пока окно открыто.
      { alive: () => this.alive, deadline: Date.now() + OWNER_MS, onError: (e) => status.setText(errorText(e)) },
    );
    if (!this.alive) return;
    const step = got.step;
    if (end === "timeout" || !step) {
      status.setText(t("handoff.expired"));
      return;
    }
    el.empty();
    if (step.state === "confirm") this.confirm(h, el, step.name, step.sas);
    else if (step.state === "delivered") el.createEl("p", { text: t("handoff.delivered", { name: step.name }) });
    else if (step.state === "sent") el.createEl("p", { text: t("handoff.sentUnconfirmed") });
    else if (step.state === "maybeSent") el.createEl("p", { text: t("handoff.maybeSent"), cls: "mod-warning" });
    else if (step.state === "mismatch") {
      el.createEl("p", { text: t("handoff.ownerMismatch", { name: step.name }), cls: "mod-warning" });
      void this.plugin.cloud.ownerCancel(h);
      this.offerClose(h, el, step.name);
    } else if (step.state === "aborted") el.createEl("p", { text: t("handoff.aborted"), cls: "mod-warning" });
    else el.createEl("p", { text: t("handoff.expired"), cls: "mod-warning" });
  }

  /** Ключ уходит только с согласия здесь: по QR — одним нажатием, по коду
   *  вручную — если цифры совпали на обоих экранах. */
  private confirm(h: OwnerHandoff, el: HTMLElement, name: string, sas: string | null): void {
    if (sas === null) {
      el.createEl("p", { text: t("handoff.confirmQr", { name }) });
    } else {
      // Код из этого QR пришёл бы с MAC: цифры здесь — ввод вручную или подмена.
      el.createEl("p", { text: t("handoff.noQrCheck", { name }), cls: "mod-warning" });
      el.createEl("p", { text: t("handoff.confirm", { name }) });
      el.createEl("p", { text: sasText(sas), cls: "selfsync-cloud-sas" });
    }
    actions(new Setting(el))
      .addButton((b) =>
        b.setButtonText(t(sas === null ? "handoff.cancel" : "handoff.noMatch")).onClick(() => {
          el.empty();
          el.createEl("p", { text: t("handoff.rejected"), cls: "mod-warning" });
          void this.plugin.cloud.ownerCancel(h);
          this.offerClose(h, el, name);
        }),
      )
      .addButton((b) =>
        b
          .setButtonText(sas === null ? t("handoff.send", { name }) : t("handoff.match"))
          .setCta()
          .onClick(() => {
            el.empty();
            void this.watch(h, el, true);
          }),
      );
  }

  /** Отказали в ключе: подключившееся устройство всё равно вошло в аккаунт —
   *  предложить закрыть его сессию. */
  private offerClose(h: OwnerHandoff, el: HTMLElement, name: string): void {
    if (h.sessionId === undefined) return;
    const row = new Setting(el);
    row.addButton((b) =>
      b.setButtonText(t("handoff.closeSession", { name })).onClick(async () => {
        b.setDisabled(true);
        try {
          const ok = await this.plugin.cloud.closeHandoffSession(h);
          row.setDesc(t(ok ? "handoff.sessionClosed" : "handoff.closeSessionHint", { name }));
        } catch (e) {
          row.setDesc(errorText(e));
          b.setDisabled(false);
        }
      }),
    );
  }

  override onClose(): void {
    this.alive = false;
    this.plugin.modals.delete(this);
    if (this.handoff) void this.plugin.cloud.ownerCancel(this.handoff);
    this.contentEl.empty();
  }
}

/** Новое устройство ждёт ключ аккаунта от источника. Цифры видны всегда; по коду
 *  вручную (в ссылке нет отпечатка обязательства) ключ применяется только после
 *  «Цифры совпадают» здесь. Не дождались или не совпали — пароль или фраза. */
export class HandoffModal extends Modal {
  private alive = false;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
    private h: JoinerHandoff,
    private password: boolean,
  ) {
    super(app);
  }

  override onOpen(): void {
    this.alive = true;
    this.plugin.modals.add(this);
    this.setTitle(t("handoff.title"));
    void this.wait();
  }

  private async wait(): Promise<void> {
    const { contentEl } = this;
    const h = this.h;
    const status = contentEl.createEl("p", { text: t(h.qr ? "handoff.waitQr" : "handoff.waitCode") });
    const digits = contentEl.createEl("p", { cls: "selfsync-cloud-sas" });
    const answer = contentEl.createDiv();
    new Setting(contentEl).addButton((b) => b.setButtonText(t("handoff.fallback")).onClick(() => this.fallback()));
    let stopped = false;
    const end = (text: string) => {
      stopped = true;
      status.setText(text);
      status.addClass("mod-warning");
      digits.setText("");
      answer.empty();
    };
    // Ответ на цифры — один раз: «совпадают» разрешает применить ключ, «не совпадают» его выбрасывает.
    const ask = () => {
      if (answer.childElementCount > 0) return;
      actions(new Setting(answer))
        .addButton((b) =>
          b.setButtonText(t("handoff.joinNoMatch")).onClick(() => {
            void this.plugin.cloud.joinerCancel(h);
            end(t("handoff.joinRejected"));
          }),
        )
        .addButton((b) =>
          b
            .setButtonText(t("handoff.joinMatch"))
            .setCta()
            .onClick(() => {
              h.confirmed = true;
              answer.empty();
              status.setText(t("handoff.waitSend"));
            }),
        );
    };
    const outcome = await poll(
      async () => {
        const step = await this.plugin.cloud.joinerStep(this.h);
        if (!this.alive || stopped) return true;
        if (step.state === "done") {
          new Notice(step.error === undefined ? t("handoff.done") : `${t("handoff.done")}. ${errorText(step.error)}`);
          this.close();
          if (!step.vault) new VaultModal(this.app, this.plugin).open();
          return true;
        }
        if (step.state === "mismatch") {
          end(t("handoff.mismatch"));
          return true;
        }
        if (step.state === "gone") {
          // Отменили там или истёк: сразу к паролю или фразе.
          new Notice(t("handoff.gone"));
          this.fallback();
          return true;
        }
        if (step.state === "compare") {
          digits.setText(sasText(step.sas));
          if (h.pinned) status.setText(t("handoff.compareQr"));
          else if (h.confirmed) status.setText(t("handoff.waitSend"));
          else {
            status.setText(t("handoff.compare"));
            ask();
          }
        }
        return false;
      },
      // Нет связи — спросить снова: сервер отдаёт обмен повторно до истечения.
      { alive: () => this.alive && !stopped, deadline: Date.now() + JOINER_MS, onError: (e) => status.setText(errorText(e)) },
    );
    if (outcome === "timeout" && this.alive && !stopped) end(t("handoff.timeout"));
  }

  /** Ключ иначе: пароль, если он есть у аккаунта, иначе фраза. */
  private fallback(): void {
    this.close();
    if (this.password) new UnlockModal(this.app, this.plugin).open();
    else new PhraseLoginModal(this.app, this.plugin).open();
  }

  override onClose(): void {
    this.alive = false;
    this.plugin.modals.delete(this);
    // Закрыли, не получив ключа (или ушли к паролю): источник увидит отказ.
    void this.plugin.cloud.joinerCancel(this.h);
    this.contentEl.empty();
  }
}

/** Вход кодом аккаунта: из QR (секрет обмена в ссылке) или вводом кода. Ключ
 *  придёт обменом с источником; без обмена его откроет пароль аккаунта или фраза. */
export class LoginCodeModal extends Form {
  private code: string;
  private regionId: string;

  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
    private fromQr?: { server: string; code: string; secret?: string; pin?: string; vault?: string },
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
    const r = await cloud.redeemAccount(server, this.code, { secret: this.fromQr?.secret, pin: this.fromQr?.pin, vault: this.fromQr?.vault });
    if (r.handoff) {
      new HandoffModal(this.app, this.plugin, r.handoff, r.password).open();
      return null;
    }
    // Обмена нет (ключа нет на источнике или он старый): пароль, если он есть у аккаунта, иначе фраза.
    if (r.password) new UnlockModal(this.app, this.plugin).open();
    else new PhraseLoginModal(this.app, this.plugin).open();
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
