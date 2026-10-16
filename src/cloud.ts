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
import { REGIONS, regionUrl } from "./regions.ts";

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
  /** Ответы `/info` по адресу сервиса: у каждого региона свои тарифы и KDF. */
  private infos = new Map<string, Info>();

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

  /** Адрес из ссылки приглашения — адрес региона или свой адрес сервиса. Чужой
   *  сервер выдал бы токен своего vault'а и пароль к нему: заметки этого vault'а
   *  Obsidian ушли бы туда зашифрованными известным ему ключом. */
  trusted(server: string): boolean {
    const n = norm(server);
    return n !== "" && [this.s.serviceUrl, ...REGIONS.map(regionUrl)].some((u) => u !== "" && norm(u) === n);
  }

  private api(server = this.server()): CloudApi {
    return new CloudApi(server, this.http, this.s.session);
  }

  /** Аккаунт или vault этого устройства изменились: перерисовать настройки. */
  private changed(): void {
    this.plugin.accountChanged();
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

  /** Тарифы и KDF региона: последний ответ, если он был. */
  info(region = this.s.region): Info | null {
    return this.infos.get(this.server(region)) ?? null;
  }

  async loadInfo(region = this.s.region): Promise<Info> {
    const server = this.server(region);
    const info = await this.api(server).info();
    this.infos.set(server, info);
    return info;
  }

  /** Регистрация: возвращает фразу восстановления — её нужно показать один раз. */
  async register(region: string, email: string, password: string): Promise<string[]> {
    const server = this.server(region);
    const info = this.info(region) ?? (await this.loadInfo(region));
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
    if (!accountKey) throw new CloudError(0, "bad_key", "the password does not open the account key");
    await this.signedIn(region, r.session, r.account, accountKey);
    return r.account;
  }

  /** Забытый пароль: фраза открывает ключ аккаунта, сервер принимает новый пароль. */
  async recover(region: string, email: string, phrase: string, newPassword: string): Promise<AccountView> {
    const api = new CloudApi(this.server(region), this.http);
    const start = await api.recoverStart(email);
    const opened = await openRecovery(phrase, fromB64(start.recovery_wrapped));
    if (!opened?.accountKey) throw new CloudError(0, "bad_recovery", "the phrase does not fit this account");
    const info = this.info(region) ?? (await this.loadInfo(region));
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
    this.changed();
  }

  /** Сессия, email и ключ аккаунта — забыть (выход, другой аккаунт). */
  private async signedOut(): Promise<void> {
    this.s.session = "";
    this.account = null;
    this.rememberAccountKey(null);
    await this.plugin.saveSettings();
    this.changed();
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

  /** Выход: сессия закрывается, ключ аккаунта забывается. Синк vault'а этого
   *  устройства идёт дальше на ключе vault'а, который запомнило ядро. */
  async logout(): Promise<void> {
    if (this.s.session) await this.api().logout().catch(() => undefined);
    await this.signedOut();
  }

  /** Удалить аккаунт со всеми данными на сервере. Пароль подтверждает удаление. */
  async deleteAccount(password: string): Promise<void> {
    const keys = await this.keysFor(password);
    await this.api().deleteAccount(keys.authKey);
    // Устройства удалены вместе с аккаунтом: отзывать нечего.
    await this.forgetDevice({ revoke: false });
    this.s.email = "";
    await this.keepWrap("", "", "");
    await this.signedOut();
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
    if (!this.s.salt || !this.s.kdf) throw new CloudError(0, "no_account", "no account data on this device");
    return passwordKeys(password, fromB64(this.s.salt), parseKdf(this.s.kdf));
  }

  // ---------- vault этого устройства ----------

  /** Новый vault аккаунта: это устройство подключается к нему первым, шифрование
   *  включается до первой отправки (requireEncryption). */
  async createVault(label: string): Promise<void> {
    const key = this.needAccountKey();
    // Лимит устройств — до создания: иначе vault остался бы в аккаунте без устройств.
    const a = (await this.refreshAccount()) ?? this.account;
    if (a && a.tariff.devices > 0 && a.usage.devices >= a.tariff.devices) {
      throw new CloudError(409, "device_limit", "device limit reached");
    }
    const v = await this.api().createVault(label);
    let d;
    try {
      d = await this.api().addDevice(v.name, this.s.deviceName);
    } catch (e) {
      // Vault уже создан: в списке он должен появиться, чтобы подключиться к нему, а не создавать ещё один.
      await this.refreshAccount().catch(() => undefined);
      throw e;
    }
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
    if (!this.trusted(server)) throw new CloudError(0, "untrusted_server", server);
    const r = await new CloudApi(server.trim().replace(/\/+$/, ""), this.http).redeem(code, this.s.deviceName);
    // Vault другого аккаунта: сессия и ключ прежнего к нему не подходят (ключ vault'а
    // вывелся бы не тот, смена пароля пошла бы с чужой солью).
    if (this.s.wrappedKey && (r.salt !== this.s.salt || r.wrapped_key !== this.s.wrappedKey)) {
      this.s.email = "";
      await this.signedOut();
    }
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
    this.changed();
  }

  /** Ключ vault'а нужен ядру: из пароля аккаунта, а без пароля — из ключа аккаунта
   *  на устройстве. Неверный пароль или нет ни того, ни другого — `false`. */
  async unlock(password?: string): Promise<boolean> {
    if (!this.s.vault) return false;
    let key = password === undefined ? this.accountKey() : null;
    if (password !== undefined) {
      const keys = await this.keysFor(password);
      key = await unwrapAccountKey(keys.wrapKey, fromB64(this.s.wrappedKey));
      if (!key) return false;
      this.rememberAccountKey(key);
    }
    if (!key) return false;
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

  /** Отключить это устройство: токен отзывается, ключи забываются, синк стоит.
   *  Не удалось отозвать (нет связи) — ошибка, а без `revoke` — только здесь. */
  async forgetDevice(o: { revoke?: boolean } = {}): Promise<void> {
    const runner = this.plugin.runner;
    if (runner && o.revoke !== false) {
      const r = await runner.command({ type: "devices" });
      if (r.type === "error") throw new CloudError(0, r.code, r.message);
      const me = r.type === "devices" ? r.devices.find((d) => d.current) : undefined;
      if (me) {
        const x = await runner.command({ type: "revokeDevice", id: me.id });
        if (x.type === "error") throw new CloudError(0, x.code, x.message);
      }
    }
    this.plugin.app.saveLocalStorage(VAULT_KEY, null);
    this.s.token = "";
    this.s.vault = "";
    this.s.vaultLabel = "";
    await this.plugin.saveSettings({ restart: true });
    this.changed();
  }

  async revokeDevice(id: number): Promise<void> {
    await this.api().revokeDevice(id);
    await this.refreshAccount();
    this.changed();
  }

  private needAccountKey(): Uint8Array<ArrayBuffer> {
    const k = this.accountKey();
    if (!k) throw new CloudError(0, "no_account_key", "sign in on this device");
    return k;
  }
}

/** Адрес для сравнения: без пробелов, «/» на конце и регистра. */
function norm(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}
