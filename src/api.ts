// Клиент `/cloud/v1` сервера Selfsync Cloud (docs/cloud-api.md в репозитории сервера).
// JSON, двоичные поля — base64url. Ошибка сервера — `CloudError` с кодом.

import { type Credentials, kdfJson, toB64 } from "./account.ts";

/** HTTP без CORS: в Obsidian — requestUrl, в тестах — fetch. */
export type Transport = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; text: string }>;

export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface TariffView {
  id: number;
  code: string;
  title: string;
  price: string;
  status: "active" | "soon";
  vaults: number;
  bytes_soft: number;
  bytes_hard: number;
  devices: number;
  max_file: number;
}

export interface Info {
  region: string;
  registration_open: boolean;
  kdf: string;
  tariffs: TariffView[];
  /** Версия оферты: уходит обратно при создании аккаунта. Старый сервер не шлёт. */
  terms_version?: string;
}

export interface VaultView {
  name: string;
  label: string;
  created_at: number;
  used_bytes: number;
}

export interface DeviceView {
  id: number;
  vault: string;
  name: string;
  created_at: number;
  last_seen: number;
  read_only: boolean;
  client: string;
}

export interface SessionView {
  id: number;
  name: string;
  client: string;
  created_at: number;
  last_seen: number;
  current: boolean;
}

export interface AccountView {
  id: number;
  /** `null` — аккаунт без email (C7). */
  email: string | null;
  created_at: number;
  tariff: TariffView;
  usage: { bytes: number; vaults: number; devices: number };
  vaults: VaultView[];
  devices: DeviceView[];
  sessions: SessionView[];
  has_password: boolean;
  has_key_auth: boolean;
  phrase_version: number;
  phrase_confirmed: boolean;
  terms_version: string;
  recovery_wrapped: string;
  /** Обёртка ключа паролем; `null`, если пароля нет. */
  kdf: string | null;
  salt: string | null;
  wrapped_key: string | null;
}

/** Обёртка ключа аккаунта паролем. */
export interface PasswordWrap {
  kdf: string;
  salt: string;
  wrapped_key: string;
}

export interface CodeRedeemed {
  session: string;
  account: AccountView;
  /** Vault устройства, создавшего код; `null` — выбрать самому. */
  vault: string | null;
  password: PasswordWrap | null;
}

/** Подтверждение необратимого действия: что есть у устройства. */
export interface Confirm {
  auth_key?: string;
  key_auth?: string;
  recovery_auth?: string;
}

/** Обёртки ключа фразой и доказательство знания фразы (как в `/register`). */
export interface RecoveryOut {
  recovery_wrapped: string;
  recovery_auth: string;
}

export interface Signed {
  session: string;
  account: AccountView;
}

export interface DeviceToken {
  token: string;
  device_id: number;
  vault: string;
  label: string;
}

export interface Redeemed extends DeviceToken {
  kdf: string | null;
  salt: string | null;
  wrapped_key: string | null;
}

function credJson(c: Credentials): Record<string, string> {
  return { auth_key: toB64(c.authKey), kdf: kdfJson(c.kdf), salt: toB64(c.salt), wrapped_key: toB64(c.wrappedKey) };
}

export class CloudApi {
  constructor(
    readonly server: string,
    private http: Transport,
    private session = "",
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const bearer = token ?? this.session;
    if (bearer) headers.authorization = `Bearer ${bearer}`;
    const r = await this.http({
      url: `${this.server}/cloud/v1${path}`,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let v: unknown = null;
    try {
      v = r.text ? JSON.parse(r.text) : null;
    } catch {
      // не JSON: прокси или не тот адрес
    }
    if (r.status >= 200 && r.status < 300) return v as T;
    const e = (v ?? {}) as { code?: string; message?: string };
    throw new CloudError(r.status, e.code ?? `http_${r.status}`, e.message ?? r.text.slice(0, 200));
  }

  info(): Promise<Info> {
    return this.call("GET", "/info");
  }

  prelogin(email: string): Promise<{ kdf: string; salt: string }> {
    return this.call("POST", "/prelogin", { email });
  }

  register(email: string, cred: Credentials, recoveryWrapped: Uint8Array, recoveryAuth: Uint8Array, deviceName: string): Promise<Signed> {
    return this.call("POST", "/register", {
      email,
      ...credJson(cred),
      recovery_wrapped: toB64(recoveryWrapped),
      recovery_auth: toB64(recoveryAuth),
      device_name: deviceName,
    });
  }

  login(email: string, authKey: Uint8Array, deviceName: string): Promise<Signed> {
    return this.call("POST", "/login", { email, auth_key: toB64(authKey), device_name: deviceName });
  }

  logout(): Promise<void> {
    return this.call("POST", "/logout");
  }

  recoverStart(email: string): Promise<{ recovery_wrapped: string }> {
    return this.call("POST", "/recover/start", { email });
  }

  recover(email: string, recoveryAuth: Uint8Array, cred: Credentials, deviceName: string): Promise<Signed> {
    return this.call("POST", "/recover", { email, recovery_auth: toB64(recoveryAuth), new: credJson(cred), device_name: deviceName });
  }

  /** Аккаунт без email (C7): фраза, доказательство ключа, оферта. */
  createAccount(recovery: RecoveryOut, keyAuth: Uint8Array, deviceName: string, termsVersion: string): Promise<Signed> {
    return this.call("POST", "/accounts", { ...recovery, key_auth: toB64(keyAuth), device_name: deviceName, terms_version: termsVersion });
  }

  /** Вход фразой без email: пароль не меняется. */
  loginPhrase(recoveryAuth: Uint8Array, deviceName: string): Promise<Signed> {
    return this.call("POST", "/login/phrase", { recovery_auth: toB64(recoveryAuth), device_name: deviceName });
  }

  account(): Promise<AccountView> {
    return this.call("GET", "/account");
  }

  deleteAccount(confirm: Confirm): Promise<void> {
    return this.call("DELETE", "/account", confirm);
  }

  /** Email и пароль аккаунту, у которого их не было. */
  setEmail(email: string, cred: Credentials, keyAuth: Uint8Array): Promise<void> {
    return this.call("POST", "/account/email", { email, ...credJson(cred), key_auth: toB64(keyAuth) });
  }

  /** Новая фраза восстановления; прежняя перестаёт действовать. */
  setRecovery(recovery: RecoveryOut, confirm: Confirm): Promise<void> {
    return this.call("POST", "/account/recovery", { ...recovery, ...confirm });
  }

  confirmPhrase(): Promise<void> {
    return this.call("POST", "/account/recovery/confirm");
  }

  /** Код аккаунта для нового устройства: сессией (с vault'ом по желанию) или токеном устройства. */
  accountCode(name: string, vault: string, deviceToken?: string): Promise<{ code: string; expires_at: number }> {
    return this.call("POST", "/account/codes", { name, vault }, deviceToken);
  }

  redeemAccountCode(code: string, deviceName: string): Promise<CodeRedeemed> {
    return this.call("POST", "/account/redeem", { code: code.replace(/[\s-]/g, ""), device_name: deviceName });
  }

  revokeSession(id: number): Promise<void> {
    return this.call("DELETE", `/sessions/${id}`);
  }

  logoutAll(): Promise<void> {
    return this.call("POST", "/logout/all");
  }

  changePassword(authKey: Uint8Array, cred: Credentials): Promise<void> {
    return this.call("POST", "/account/password", { auth_key: toB64(authKey), new: credJson(cred) });
  }

  createVault(label: string): Promise<{ name: string; label: string; created_at: number }> {
    return this.call("POST", "/vaults", { label });
  }

  renameVault(name: string, label: string): Promise<void> {
    return this.call("PATCH", `/vaults/${encodeURIComponent(name)}`, { label });
  }

  deleteVault(name: string, authKey: Uint8Array): Promise<void> {
    return this.call("DELETE", `/vaults/${encodeURIComponent(name)}`, { auth_key: toB64(authKey) });
  }

  addDevice(vault: string, name: string): Promise<DeviceToken> {
    return this.call("POST", `/vaults/${encodeURIComponent(vault)}/devices`, { name });
  }

  revokeDevice(id: number): Promise<void> {
    return this.call("DELETE", `/devices/${id}`);
  }

  /** Приглашение в vault: сессией владельца или токеном устройства этого vault'а. */
  invite(vault: string, name: string, deviceToken?: string): Promise<{ code: string; expires_at: number }> {
    return this.call("POST", `/vaults/${encodeURIComponent(vault)}/invites`, { name }, deviceToken);
  }

  redeem(code: string, name: string): Promise<Redeemed> {
    return this.call("POST", "/invites/redeem", { code: code.replace(/[\s-]/g, ""), name });
  }
}
