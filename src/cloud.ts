// Облачная часть плагина без окон: аккаунт, vault'ы, коды устройств, фраза,
// разблокировка. Окна (ui.ts) и настройки (settings.ts) только вызывают эти
// методы, поэтому весь путь проверяется тестами против настоящего сервера.
//
// Аккаунт (C7) создаётся без email: ключ аккаунта и фраза восстановления
// рождаются на устройстве, сервер получает обёртку ключа фразой и доказательство
// владения ключом. Email и пароль — необязательная надстройка.

import {
  credentials,
  fromB64,
  kdfJson,
  keyAuth,
  newRecovery,
  openRecovery,
  openRecoveryWrapped,
  parseKdf,
  passwordKeys,
  randomBytes,
  recoveryAuth,
  recoveryEntropy,
  toB64,
  unwrapAccountKey,
  vaultPassword,
} from "./account.ts";
import { type AccountView, CloudApi, CloudError, type Confirm, type Info, type RecoveryOut, type Transport } from "./api.ts";
import * as handoff from "./handoff.ts";
import type SelfsyncCloudPlugin from "./main.ts";
import { REGIONS, regionUrl } from "./regions.ts";

/** Ключ аккаунта на устройстве (как запомненный ключ vault'а в открытом плагине). */
const ACCOUNT_KEY = "selfsync-cloud-account-key";
/** Слова фразы, которые пользователь ещё не отметил записанными (JSON: версия и слова). */
const PHRASE_WORDS = "selfsync-cloud-phrase";
/** Запомненный ключ vault'а открытого плагина: при смене vault'а — забыть. */
const VAULT_KEY = "selfsync-master-key";

/** Схема ссылки входа в аккаунт (QR): `obsidian://selfsync-cloud-login?s=…&c=…&m=…&v=…`.
 *  `m` — секрет обмена ключом (на сервер не уходит). Ссылки плагина 0.2.x несли
 *  вместо него сам ключ аккаунта (`k`): они больше не принимаются. */
export const LOGIN_ACTION = "selfsync-cloud-login";

export interface Invite {
  code: string;
  expiresAt: number;
  /** Ссылка для QR: адрес сервиса, код и секрет обмена (на сервер не уходит). */
  uri: string;
  /** Обмен ключом со стороны источника (`ownerStep`). */
  handoff: OwnerHandoff;
}

/** Источник обмена ключом: своя пара, секрет QR и куда опрашивать. */
export interface OwnerHandoff {
  code: string;
  server: string;
  /** Токен устройства, если код создан без сессии. */
  token?: string;
  pair: handoff.Pair;
  secret: Uint8Array<ArrayBuffer>;
  /** Обёртка для нового устройства, как только известен его ключ: одна на обмен. */
  wrapped?: Uint8Array<ArrayBuffer>;
  /** Ключ нового устройства, под который сделана обёртка. */
  joiner?: Uint8Array<ArrayBuffer>;
}

/** Где обмен у источника. */
export type OwnerStep =
  /** Новое устройство ещё не вошло по коду. */
  | { state: "waiting" }
  /** Подтвердить передачу здесь: по коду вручную — сверив цифры (`sas`) на обоих
   *  устройствах, по QR (MAC сошёлся, `sas` — `null`) — одним нажатием. */
  | { state: "confirm"; name: string; sas: string | null }
  /** Ключ передан. */
  | { state: "delivered"; name: string }
  /** Код из QR, а MAC не сошёлся: ключ подменён, не передавать. */
  | { state: "mismatch"; name: string }
  /** Код истёк или уже использован. */
  | { state: "expired" };

/** Новое устройство в обмене ключом. */
export interface JoinerHandoff {
  commit: Uint8Array<ArrayBuffer>;
  pair: handoff.Pair;
  /** MAC секретом из QR; нет — код вручную, источник сверит цифры. */
  mac?: Uint8Array<ArrayBuffer>;
  /** Код из QR (с MAC): источнику не нужно сверять цифры. */
  qr: boolean;
  /** Свой ключ уже отдан серверу (`PUT /account/handoff`). */
  sent: boolean;
}

/** Где обмен у нового устройства. */
export type JoinerStep =
  /** Источник ещё не раскрыл ключ. */
  | { state: "waiting" }
  /** Ключ источника сошёлся с обязательством: эти цифры должны быть и там. */
  | { state: "compare"; sas: string }
  /** Ключ аккаунта открыт; `vault` — подключён ли vault (иначе выбрать), `error` —
   *  почему не подключился. */
  | { state: "done"; vault: boolean; error?: unknown }
  /** Ключ источника не тот, что в обязательстве, или обёртка не открылась. */
  | { state: "mismatch" }
  /** Обмена больше нет: истёк или обёртку уже забрали. */
  | { state: "gone" };

/** Что известно о фразе восстановления этого аккаунта на этом устройстве. */
export type PhraseStatus =
  /** Пользователь отметил, что записал фразу. */
  | "confirmed"
  /** Слова ещё здесь: показать и отметить. */
  | "pending-here"
  /** Фраза не записана, а слова на другом устройстве: создать новую здесь. */
  | "pending-elsewhere"
  /** Аккаунт не загружен. */
  | "unknown";

/** Итог обмена кода аккаунта: как дальше открыть ключ. */
export interface RedeemOutcome {
  /** Источник передаст ключ обменом (`joinerStep`); `null` — нет. */
  handoff: JoinerHandoff | null;
  /** У аккаунта есть пароль: им можно открыть ключ. Иначе — только фразой. */
  password: boolean;
  /** Vault, к которому подключиться, когда ключ откроется. */
  vault: string | null;
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

  /** Адрес из ссылки — адрес региона или свой адрес сервиса. Чужой сервер выдал бы
   *  сессию своего аккаунта: заметки этого vault'а Obsidian ушли бы туда. */
  trusted(server: string): boolean {
    const n = norm(server);
    return n !== "" && [this.s.serviceUrl, ...REGIONS.map(regionUrl)].some((u) => u !== "" && norm(u) === n);
  }

  /** Регион по адресу сервиса (ссылка QR); чужой адрес — текущий регион. */
  private regionOf(server: string): string {
    return REGIONS.find((r) => norm(regionUrl(r)) === norm(server)) ?? this.s.region;
  }

  private api(server = this.server()): CloudApi {
    return new CloudApi(server, this.http, this.s.session);
  }

  /** Аккаунт или vault этого устройства изменились: перерисовать настройки. */
  private changed(): void {
    this.plugin.accountChanged();
  }

  // ---------- ключ аккаунта и фраза ----------

  accountKey(): Uint8Array<ArrayBuffer> | null {
    const v = this.plugin.app.loadLocalStorage(ACCOUNT_KEY) as string | null;
    return v ? fromB64(v) : null;
  }

  private rememberAccountKey(k: Uint8Array | null): void {
    this.plugin.app.saveLocalStorage(ACCOUNT_KEY, k ? toB64(k) : null);
  }

  /** Слова фразы, ещё не отмеченные записанными, если они на этом устройстве. */
  pendingPhrase(): string[] | null {
    const raw = this.plugin.app.loadLocalStorage(PHRASE_WORDS) as string | null;
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { version?: number; words?: string[] };
      // Фразу заменили на другом устройстве: эти слова больше не открывают аккаунт.
      if (this.account && typeof v.version === "number" && v.version < this.account.phrase_version) {
        this.keepPhrase(null);
        return null;
      }
      return Array.isArray(v.words) && v.words.length === 24 ? v.words : null;
    } catch {
      return null;
    }
  }

  private keepPhrase(words: string[] | null, version = this.account?.phrase_version ?? 1): void {
    this.plugin.app.saveLocalStorage(PHRASE_WORDS, words ? JSON.stringify({ version, words }) : null);
  }

  phraseStatus(): PhraseStatus {
    if (this.account?.phrase_confirmed) {
      // Отметили на другом устройстве (или здесь до перезапуска): слова больше не нужны.
      if (this.pendingPhrase()) this.keepPhrase(null);
      return "confirmed";
    }
    if (this.pendingPhrase()) return "pending-here";
    return this.account ? "pending-elsewhere" : "unknown";
  }

  /** Пользователь записал фразу: сервер перестаёт напоминать, слова стираются. */
  async confirmPhrase(): Promise<void> {
    await this.api().confirmPhrase();
    this.keepPhrase(null);
    if (this.account) this.account.phrase_confirmed = true;
    await this.refreshAccount().catch(() => undefined);
    this.changed();
  }

  /** Новая фраза: прежняя перестаёт действовать. Слова остаются здесь до отметки. */
  async newPhrase(): Promise<string[]> {
    const key = this.needAccountKey();
    const r = await newRecovery(key);
    await this.api().setRecovery(recoveryOut(r), await this.proof());
    const version = (this.account?.phrase_version ?? 1) + 1;
    if (this.account) {
      this.account.phrase_version = version;
      this.account.phrase_confirmed = false;
    }
    this.keepPhrase(r.words, version);
    await this.refreshAccount().catch(() => undefined);
    this.changed();
    return r.words;
  }

  /** Обёртка ключа аккаунта паролем — чтобы открыть его без сессии (устройство
   *  по коду, перезапуск без сохранённого ключа). Пусто — пароля нет. */
  private async keepWrap(kdf: string | null, salt: string | null, wrapped: string | null): Promise<void> {
    this.s.kdf = kdf ?? "";
    this.s.salt = salt ?? "";
    this.s.wrappedKey = wrapped ?? "";
    this.s.hasPassword = !!wrapped;
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

  /** Начать: аккаунт без email и первый vault. Фраза остаётся на устройстве
   *  до отметки «записал» (`pendingPhrase`). */
  async start(region: string, label: string): Promise<void> {
    const server = this.server(region);
    const info = this.info(region) ?? (await this.loadInfo(region));
    const accountKey = randomBytes(32);
    const recovery = await newRecovery(accountKey);
    const r = await new CloudApi(server, this.http).createAccount(recoveryOut(recovery), await keyAuth(accountKey), this.s.deviceName, info.terms_version ?? "");
    await this.signedIn(region, r.session, r.account, accountKey);
    this.keepPhrase(recovery.words, r.account.phrase_version);
    await this.createVault(label);
  }

  /** Регистрация с email и паролем (как в 0.1.x): возвращает фразу — показать один раз. */
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
    const accountKey = r.account.wrapped_key ? await unwrapAccountKey(keys.wrapKey, fromB64(r.account.wrapped_key)) : null;
    if (!accountKey) throw new CloudError(0, "bad_key", "the password does not open the account key");
    await this.signedIn(region, r.session, r.account, accountKey);
    return r.account;
  }

  /** Вход фразой без email: доказательство находит аккаунт, фраза открывает ключ. */
  async loginPhrase(region: string, phrase: string): Promise<AccountView> {
    const entropy = recoveryEntropy(phrase);
    if (!entropy) throw new CloudError(0, "bad_recovery", "not a recovery phrase");
    const api = new CloudApi(this.server(region), this.http);
    const r = await api.loginPhrase(await recoveryAuth(entropy), this.s.deviceName);
    const key = await openRecoveryWrapped(entropy, fromB64(r.account.recovery_wrapped));
    if (!key) throw new CloudError(0, "bad_recovery", "the phrase does not open the account key");
    await this.signedIn(region, r.session, r.account, key);
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

  /** Сессия получена. Ключ — если устройство его знает (иначе откроет пароль или фраза). */
  private async signedIn(region: string, session: string, account: AccountView, accountKey: Uint8Array | null): Promise<void> {
    // Прежняя сессия этого устройства больше не нужна (вход по коду, затем фразой):
    // закрыть, чтобы не копилась в списке входов. Без связи — пусть истечёт.
    if (this.s.session && this.s.session !== session) {
      void new CloudApi(this.server(this.s.region), this.http, this.s.session).logout().catch(() => undefined);
    }
    // Другой аккаунт: слова и ключ прежнего к этому не относятся.
    if (this.s.accountId && this.s.accountId !== account.id) this.keepPhrase(null);
    this.s.region = region;
    this.s.accountId = account.id;
    this.s.email = account.email ?? "";
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
      this.s.hasPassword = this.account.has_password;
      this.s.accountId = this.account.id;
      this.s.email = this.account.email ?? "";
      await this.learnDeviceId().catch(() => undefined);
    } catch (e) {
      // Сессию закрыли (смена пароля, блокировка, выход на другом устройстве, срок).
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

  /** Номер этого устройства — у ядра (подключённые до того, как он запоминался). */
  private async learnDeviceId(): Promise<void> {
    const runner = this.plugin.runner;
    if (this.s.deviceId || !this.s.token || !runner) return;
    const r = await runner.command({ type: "devices" });
    const me = r.type === "devices" ? r.devices.find((d) => d.current) : undefined;
    if (!me) return;
    this.s.deviceId = me.id;
    await this.plugin.saveSettings();
  }

  /** Выход: сессия закрывается, ключ аккаунта забывается. Синк vault'а этого
   *  устройства идёт дальше на ключе vault'а, который запомнило ядро. */
  async logout(): Promise<void> {
    if (this.s.session) await this.api().logout().catch(() => undefined);
    await this.signedOut();
  }

  /** Закрыть все сессии, кроме этой. */
  async logoutAll(): Promise<void> {
    await this.api().logoutAll();
    await this.refreshAccount();
    this.changed();
  }

  async revokeSession(id: number): Promise<void> {
    await this.api().revokeSession(id);
    await this.refreshAccount();
    this.changed();
  }

  /** Подтверждение необратимого действия: пароль, если он дан, иначе ключ аккаунта. */
  private async proof(password?: string): Promise<Confirm> {
    if (password !== undefined) {
      const keys = await this.keysFor(password);
      return { auth_key: toB64(keys.authKey) };
    }
    const key = this.needAccountKey();
    return { key_auth: toB64(await keyAuth(key)) };
  }

  /** Удалить аккаунт со всеми данными на сервере. Подтверждение — пароль, а без
   *  пароля ключ аккаунта с этого устройства. */
  async deleteAccount(password?: string): Promise<void> {
    await this.api().deleteAccount(await this.proof(password));
    // Устройства удалены вместе с аккаунтом: отзывать нечего.
    await this.forgetDevice({ revoke: false });
    this.s.email = "";
    this.s.accountId = 0;
    this.keepPhrase(null);
    await this.keepWrap(null, null, null);
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

  /** Email и пароль аккаунту без них: вход вводом и подтверждение паролем. */
  async setEmailPassword(email: string, password: string): Promise<void> {
    const key = this.needAccountKey();
    const info = this.info() ?? (await this.loadInfo());
    const cred = await credentials(password, key, parseKdf(info.kdf));
    await this.api().setEmail(email, cred, await keyAuth(key));
    this.s.email = email.trim().toLowerCase();
    await this.keepWrap(kdfJson(cred.kdf), toB64(cred.salt), toB64(cred.wrappedKey));
    await this.refreshAccount().catch(() => undefined);
    this.changed();
  }

  private async keysFor(password: string) {
    if (!this.s.salt || !this.s.kdf) throw new CloudError(0, "no_password", "the account has no password");
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
    await this.connect(this.server(), d.token, d.vault, d.label, d.device_id);
    this.plugin.runner?.send({ type: "enableEncryption", password: await vaultPassword(key, d.vault), remember: true, recovery: false });
  }

  /** Подключить устройство к существующему vault'у аккаунта. */
  async connectVault(name: string): Promise<void> {
    const key = this.needAccountKey();
    const d = await this.api().addDevice(name, this.s.deviceName);
    this.s.pendingVault = "";
    await this.connect(this.server(), d.token, d.vault, d.label, d.device_id);
    this.plugin.runner?.send({ type: "password", password: await vaultPassword(key, d.vault), remember: true });
  }

  /** Код аккаунта с другого устройства: сессия сразу, ключ — обменом с
   *  источником (`handoff`, затем `joinerStep`), иначе его откроет пароль или
   *  фраза. `secret` — из ссылки QR: источник узнает свой QR и передаст ключ без
   *  сверки цифр. Vault запоминается (`pendingVault`) до ключа. */
  async redeemAccount(server: string, code: string, o: { secret?: string; vault?: string } = {}): Promise<RedeemOutcome> {
    if (!this.trusted(server)) throw new CloudError(0, "untrusted_server", server);
    const srv = server.trim().replace(/\/+$/, "");
    const r = await new CloudApi(srv, this.http).redeemAccountCode(code, this.s.deviceName);
    await this.signedIn(this.regionOf(srv), r.session, r.account, null);
    const vault = o.vault || r.vault;
    if (vault) {
      this.s.pendingVault = vault;
      await this.plugin.saveSettings();
    }
    // Свой ключ обмена — только после обязательства источника: иначе нечестный
    // сервер, придержав ответ, подобрал бы ключ источника под цифры. Секрет не той
    // длины — как код без QR: тогда сверка цифр.
    const commit = r.handoff?.commit ? fromB64(r.handoff.commit) : null;
    let offer: JoinerHandoff | null = null;
    if (commit?.length === 32) {
      const pair = await handoff.newPair();
      const secret = o.secret ? fromB64(o.secret) : null;
      const mac = secret?.length === handoff.SECRET_LEN ? await handoff.macOf(secret, pair.pub) : undefined;
      offer = { commit, pair, mac, qr: mac !== undefined, sent: false };
      // Не вышло (нет связи) — `joinerStep` отправит ещё раз; обмена нет — без него.
      if ((await this.joinHandoff(offer).catch(() => true)) === false) offer = null;
    }
    return { handoff: offer, password: r.password !== null, vault };
  }

  /** Отдать свой ключ обмена серверу. `false` — обмена у кода нет. */
  private async joinHandoff(h: JoinerHandoff): Promise<boolean> {
    if (h.sent) return true;
    try {
      await this.api().handoffJoin(h.pair.pub, h.mac);
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return false;
      throw e;
    }
    h.sent = true;
    return true;
  }

  /** Шаг нового устройства в обмене: опрос сессией из кода. Ключ открылся —
   *  запомнить и подключить отложенный vault. */
  async joinerStep(h: JoinerHandoff): Promise<JoinerStep> {
    if (!(await this.joinHandoff(h))) return { state: "gone" };
    let r;
    try {
      r = await this.api().handoffJoiner();
    } catch (e) {
      if (e instanceof CloudError && e.status === 404) return { state: "gone" };
      throw e;
    }
    if (!r.pk) return { state: "waiting" };
    const a = fromB64(r.pk);
    // Сервер мог подменить ключ источника: обязательство из кода это ловит.
    if (!(await handoff.commitOk(h.commit, a)) || !(await handoff.validPub(a))) return { state: "mismatch" };
    if (!r.wrapped) return { state: "compare", sas: await handoff.sas(a, h.pair.pub) };
    const key = await handoff.open(h.pair, a, fromB64(r.wrapped));
    if (!key) return { state: "mismatch" };
    this.rememberAccountKey(key);
    // Обёртку сервер отдал один раз: ключ уже здесь, даже если vault не подключился
    // (лимит устройств, нет связи) — тогда выбрать vault заново.
    try {
      const pending = this.s.pendingVault;
      if (pending) await this.connectVault(pending);
      else await this.unlock();
    } catch (error) {
      this.changed();
      return { state: "done", vault: false, error };
    }
    this.changed();
    return { state: "done", vault: this.s.vault !== "" };
  }

  /** Шаг источника в обмене: опрос; ключ нового устройства пришёл — ждать
   *  `confirmed`: по QR (MAC сошёлся) — согласие одним нажатием, по коду вручную —
   *  раскрыть свой ключ и сверить цифры. Ключ уходит только после согласия. */
  async ownerStep(h: OwnerHandoff, confirmed = false): Promise<OwnerStep> {
    const api = new CloudApi(h.server, this.http, this.s.session);
    const call = async (o: { pk?: Uint8Array; wrapped?: Uint8Array } = {}) => {
      try {
        return await api.handoffOwner(h.code, o, h.token);
      } catch (e) {
        if (e instanceof CloudError && e.status === 404) return null;
        throw e;
      }
    };
    const r = await call();
    if (!r) return { state: "expired" };
    if (r.delivered) return { state: "delivered", name: r.name };
    if (!r.pk) return { state: "waiting" };
    const b = fromB64(r.pk);
    if (!(await handoff.validPub(b))) return { state: "mismatch", name: r.name };
    // Ключ нового устройства пишется один раз: другой в следующем ответе — подмена.
    if (h.joiner && !sameBytes(h.joiner, b)) return { state: "mismatch", name: r.name };
    h.joiner = b;
    const viaQr = !!r.mac;
    if (viaQr && !(await handoff.macOk(h.secret, b, fromB64(r.mac ?? "")))) return { state: "mismatch", name: r.name };
    if (!confirmed) {
      if (viaQr) return { state: "confirm", name: r.name, sas: null };
      await call({ pk: h.pair.pub });
      return { state: "confirm", name: r.name, sas: await handoff.sas(h.pair.pub, b) };
    }
    const key = this.needAccountKey();
    h.wrapped ??= (await handoff.seal(h.pair, b, key)) ?? undefined;
    if (!h.wrapped) return { state: "mismatch", name: r.name };
    const d = await call({ pk: h.pair.pub, wrapped: h.wrapped });
    if (!d) return { state: "expired" };
    return d.delivered ? { state: "delivered", name: d.name } : { state: "waiting" };
  }

  private async connect(server: string, token: string, vault: string, label: string, deviceId: number): Promise<void> {
    // Индекс и ключ прежнего vault'а этому не подходят.
    await this.plugin.forgetVault(server.replace(/\/+$/, ""), vault);
    this.s.server = server.replace(/\/+$/, "");
    this.s.token = token;
    this.s.vault = vault;
    this.s.vaultLabel = label;
    this.s.deviceId = deviceId;
    await this.plugin.saveSettings({ restart: true });
    this.changed();
  }

  /** Ключ vault'а нужен ядру: из ключа аккаунта на устройстве, а без него — из
   *  пароля аккаунта. Неверный пароль или нет ни того, ни другого — `false`.
   *  Если ключ открылся, а vault ещё не подключён (`pendingVault`), подключает. */
  async unlock(password?: string): Promise<boolean> {
    let key = password === undefined ? this.accountKey() : null;
    if (password !== undefined) {
      if (!this.s.wrappedKey) return false;
      const keys = await this.keysFor(password);
      key = await unwrapAccountKey(keys.wrapKey, fromB64(this.s.wrappedKey));
      if (!key) return false;
      this.rememberAccountKey(key);
    }
    if (!key) return false;
    if (!this.s.vault) {
      if (this.s.pendingVault) await this.connectVault(this.s.pendingVault);
      return true;
    }
    this.plugin.runner?.send({ type: "password", password: await vaultPassword(key, this.s.vault), remember: true });
    return true;
  }

  /** Код для нового устройства этого аккаунта. Сессией — или токеном устройства,
   *  если сессии нет. Код с обязательством обмена, в ссылке секрет обмена; сам
   *  ключ ни в ссылку, ни на сервер не идёт. Без ключа на устройстве — отказ. */
  async accountCode(name: string): Promise<Invite> {
    // Сервер выдаёт коды только с обменом: без ключа здесь передавать нечего.
    this.needAccountKey();
    const server = this.s.server || this.server();
    const pair = await handoff.newPair();
    const token = this.s.session ? undefined : this.s.token;
    const r = await this.api(server).accountCode(name, token ? "" : this.s.vault, token, await handoff.commitOf(pair.pub));
    const h = { code: r.code, server, token, pair, secret: randomBytes(handoff.SECRET_LEN) };
    const q = new URLSearchParams({ s: server, c: r.code, m: toB64(h.secret) });
    if (this.s.vault) q.set("v", this.s.vault);
    return { code: r.code, expiresAt: r.expires_at, uri: `obsidian://${LOGIN_ACTION}?${q.toString()}`, handoff: h };
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
    this.s.deviceId = 0;
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

function recoveryOut(r: { wrapped: Uint8Array; auth: Uint8Array }): RecoveryOut {
  return { recovery_wrapped: toB64(r.wrapped), recovery_auth: toB64(r.auth) };
}

function sameBytes(x: Uint8Array, y: Uint8Array): boolean {
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/** Адрес для сравнения: без пробелов, «/» на конце и регистра. */
function norm(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}
