// Облачная часть плагина без окон: аккаунт, vault'ы, приглашения, разблокировка.
// Окна (ui.ts) и настройки (settings.ts) только вызывают эти методы, поэтому
// весь путь проверяется тестами против настоящего сервера.

import {
  credentials,
  fromB64,
  kdfJson,
  newRecovery,
  openRecovery,
  parseKdf,
  passwordKeys,
  randomBytes,
  toB64,
  unwrapAccountKey,
  vaultPassword,
} from "./account.ts";
import { type AccountView, CloudApi, CloudError, type Info, type Transport } from "./api.ts";
import type SelfsyncCloudPlugin from "./main.ts";
import { regionUrl } from "./regions.ts";

/** Ключ аккаунта на устройстве (как запомненный ключ vault'а в открытом плагине). */
const ACCOUNT_KEY = "selfsync-cloud-account-key";
/** Запомненный ключ vault'а открытого плагина: при смене vault'а — забыть. */
const VAULT_KEY = "selfsync-master-key";

/** Схема ссылки приглашения (QR): `obsidian://selfsync-cloud-invite?s=…&c=…&k=…`. */
export const INVITE_ACTION = "selfsync-cloud-invite";

export interface Invite {
  code: string;
  expiresAt: number;
  /** Ссылка для QR: адрес сервиса, код и пароль vault'а (на сервер не уходит). */
  uri: string;
}

export class Cloud {
  /** Последний ответ `/account` (для настроек). */
  account: AccountView | null = null;
  info: Info | null = null;

  constructor(
    private plugin: SelfsyncCloudPlugin,
    private http: Transport,
  ) {}

  private get s() {
    return this.plugin.settings;
  }

  /** Адрес сервиса: свой (для проверки) или региона. */
  server(region = this.s.region): string {
    return (this.s.serviceUrl || regionUrl(region)).replace(/\/+$/, "");
  }

  private api(server = this.server()): CloudApi {
    return new CloudApi(server, this.http, this.s.session);
  }

  // ---------- ключ аккаунта ----------

  accountKey(): Uint8Array<ArrayBuffer> | null {
    const v = this.plugin.app.loadLocalStorage(ACCOUNT_KEY) as string | null;
    return v ? fromB64(v) : null;
  }

  private rememberAccountKey(k: Uint8Array | null): void {
    this.plugin.app.saveLocalStorage(ACCOUNT_KEY, k ? toB64(k) : null);
  }

  /** Обёртка ключа аккаунта паролем — чтобы открыть его без сессии (устройство
   *  по коду приглашения, перезапуск без сохранённого ключа). */
  private async keepWrap(kdf: string, salt: string, wrapped: string): Promise<void> {
    this.s.kdf = kdf;
    this.s.salt = salt;
    this.s.wrappedKey = wrapped;
    await this.plugin.saveSettings();
  }

  // ---------- аккаунт ----------

  async loadInfo(region = this.s.region): Promise<Info> {
    this.info = await this.api(this.server(region)).info();
    return this.info;
  }

  /** Регистрация: возвращает фразу восстановления — её нужно показать один раз. */
  async register(region: string, email: string, password: string): Promise<string[]> {
    const server = this.server(region);
    const info = this.info ?? (await this.api(server).info());
    const accountKey = randomBytes(32);
    const cred = await credentials(password, accountKey, parseKdf(info.kdf));
    const recovery = await newRecovery(accountKey);
    const r = await new CloudApi(server, this.http).register(email, cred, recovery.wrapped, recovery.auth, this.s.deviceName);
    await this.signedIn(region, r.session, r.account, accountKey);
    return recovery.words;
  }

  async login(region: string, email: string, password: string): Promise<AccountView> {
    const api = new CloudApi(this.server(region), this.http);
    const pre = await api.prelogin(email);
    const keys = await passwordKeys(password, fromB64(pre.salt), parseKdf(pre.kdf));
    const r = await api.login(email, keys.authKey, this.s.deviceName);
    const accountKey = await unwrapAccountKey(keys.wrapKey, fromB64(r.account.wrapped_key));
    if (!accountKey) throw new CloudError(0, "bad_key", "ключ аккаунта не открылся этим паролем");
    await this.signedIn(region, r.session, r.account, accountKey);
    return r.account;
  }

  /** Забытый пароль: фраза открывает ключ аккаунта, сервер принимает новый пароль. */
  async recover(region: string, email: string, phrase: string, newPassword: string): Promise<AccountView> {
    const api = new CloudApi(this.server(region), this.http);
    const start = await api.recoverStart(email);
    const opened = await openRecovery(phrase, fromB64(start.recovery_wrapped));
    if (!opened?.accountKey) throw new CloudError(0, "bad_recovery", "фраза не подходит к этому аккаунту");
    const info = this.info ?? (await api.info());
    const cred = await credentials(newPassword, opened.accountKey, parseKdf(info.kdf));
    const r = await api.recover(email, opened.auth, cred, this.s.deviceName);
    await this.signedIn(region, r.session, r.account, opened.accountKey);
    return r.account;
  }

  private async signedIn(region: string, session: string, account: AccountView, accountKey: Uint8Array): Promise<void> {
    this.s.region = region;
    this.s.email = account.email;
    this.s.session = session;
    this.account = account;
    this.rememberAccountKey(accountKey);
    await this.keepWrap(account.kdf, account.salt, account.wrapped_key);
  }

  async refreshAccount(): Promise<AccountView | null> {
    if (!this.s.session) return null;
    try {
      this.account = await this.api().account();
    } catch (e) {
      // Сессию закрыли (смена пароля, блокировка, выход на другом устройстве).
      if (e instanceof CloudError && (e.status === 401 || e.status === 403)) {
        this.s.session = "";
        await this.plugin.saveSettings();
        this.account = null;
        return null;
      }
      throw e;
    }
    return this.account;
  }

  async logout(): Promise<void> {
    if (this.s.session) await this.api().logout().catch(() => undefined);
    this.s.session = "";
    this.account = null;
    await this.plugin.saveSettings();
  }

  /** Удалить аккаунт со всеми данными на сервере. Пароль подтверждает удаление. */
  async deleteAccount(password: string): Promise<void> {
    const keys = await this.keysFor(password);
    await this.api().deleteAccount(keys.authKey);
    await this.forgetDevice();
    this.s.session = "";
    this.s.email = "";
    this.account = null;
    this.rememberAccountKey(null);
    await this.keepWrap("", "", "");
  }

  /** Смена пароля: тот же ключ аккаунта под новым паролем. Другие сессии
   *  закрываются, устройства продолжают синхронизироваться. */
  async changePassword(oldPassword: string, newPassword: string): Promise<boolean> {
    const old = await this.keysFor(oldPassword);
    const key = await unwrapAccountKey(old.wrapKey, fromB64(this.s.wrappedKey));
    if (!key) return false;
    const cred = await credentials(newPassword, key, parseKdf(this.s.kdf));
    await this.api().changePassword(old.authKey, cred);
    this.rememberAccountKey(key);
    await this.keepWrap(kdfJson(cred.kdf), toB64(cred.salt), toB64(cred.wrappedKey));
    return true;
  }

  private async keysFor(password: string) {
    if (!this.s.salt || !this.s.kdf) throw new CloudError(0, "no_account", "нет данных аккаунта на устройстве");
    return passwordKeys(password, fromB64(this.s.salt), parseKdf(this.s.kdf));
  }

  // ---------- vault этого устройства ----------

  /** Новый vault аккаунта: это устройство подключается к нему первым, шифрование
   *  включается до первой отправки (requireEncryption). */
  async createVault(label: string): Promise<void> {
    const key = this.needAccountKey();
    const v = await this.api().createVault(label);
    const d = await this.api().addDevice(v.name, this.s.deviceName);
    await this.connect(this.server(), d.token, d.vault, d.label);
    this.plugin.runner?.send({ type: "enableEncryption", password: await vaultPassword(key, d.vault), remember: true, recovery: false });
  }

  /** Подключить устройство к существующему vault'у аккаунта. */
  async connectVault(name: string): Promise<void> {
    const key = this.needAccountKey();
    const d = await this.api().addDevice(name, this.s.deviceName);
    await this.connect(this.server(), d.token, d.vault, d.label);
    this.plugin.runner?.send({ type: "password", password: await vaultPassword(key, d.vault), remember: true });
  }

  /** Приглашение: по QR (`vaultPw` из ссылки) устройство открывает vault сразу,
   *  по коду — после ввода пароля аккаунта (`unlock`). */
  async redeem(server: string, code: string, vaultPw?: string): Promise<void> {
    const r = await new CloudApi(server.replace(/\/+$/, ""), this.http).redeem(code, this.s.deviceName);
    await this.keepWrap(r.kdf, r.salt, r.wrapped_key);
    await this.connect(server, r.token, r.vault, r.label);
    if (vaultPw) this.plugin.runner?.send({ type: "password", password: vaultPw, remember: true });
  }

  private async connect(server: string, token: string, vault: string, label: string): Promise<void> {
    // Индекс и ключ прежнего vault'а этому не подходят.
    await this.plugin.forgetVault(server.replace(/\/+$/, ""), vault);
    this.s.server = server.replace(/\/+$/, "");
    this.s.token = token;
    this.s.vault = vault;
    this.s.vaultLabel = label;
    await this.plugin.saveSettings({ restart: true });
  }

  /** Ключ vault'а нужен ядру: из ключа аккаунта, а если его нет — из пароля.
   *  Неверный пароль — `false`. */
  async unlock(password?: string): Promise<boolean> {
    let key = this.accountKey();
    if (!key && password !== undefined) {
      const keys = await this.keysFor(password);
      key = await unwrapAccountKey(keys.wrapKey, fromB64(this.s.wrappedKey));
      if (!key) return false;
      this.rememberAccountKey(key);
    }
    if (!key || !this.s.vault) return false;
    this.plugin.runner?.send({ type: "password", password: await vaultPassword(key, this.s.vault), remember: true });
    return true;
  }

  /** Приглашение другого устройства в vault этого устройства. */
  async invite(name: string): Promise<Invite> {
    const key = this.needAccountKey();
    const r = await this.api(this.s.server).invite(this.s.vault, name, this.s.token);
    const q = new URLSearchParams({ s: this.s.server, c: r.code, k: await vaultPassword(key, this.s.vault) });
    return { code: r.code, expiresAt: r.expires_at, uri: `obsidian://${INVITE_ACTION}?${q.toString()}` };
  }

  /** Отключить это устройство: токен отзывается, ключи забываются, синк стоит. */
  async forgetDevice(): Promise<void> {
    const runner = this.plugin.runner;
    if (runner) {
      const r = await runner.command({ type: "devices" });
      const me = r.type === "devices" ? r.devices.find((d) => d.current) : undefined;
      if (me) await runner.command({ type: "revokeDevice", id: me.id });
    }
    this.plugin.app.saveLocalStorage(VAULT_KEY, null);
    this.s.token = "";
    this.s.vault = "";
    this.s.vaultLabel = "";
    await this.plugin.saveSettings({ restart: true });
  }

  async revokeDevice(id: number): Promise<void> {
    await this.api().revokeDevice(id);
    await this.refreshAccount();
  }

  private needAccountKey(): Uint8Array<ArrayBuffer> {
    const k = this.accountKey();
    if (!k) throw new CloudError(0, "no_account_key", "войдите в аккаунт на этом устройстве");
    return k;
  }
}
