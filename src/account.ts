// Ключи аккаунта. Сервер не видит ни пароля, ни ключей:
//
//   главный = Argon2id(пароль, соль аккаунта)          — WASM ядра selfsync
//   ключ входа   = HKDF(главный, "auth")  → на сервер (там хранится его sha256)
//   ключ обёртки = HKDF(главный, "wrap")  → AES-GCM над ключом аккаунта
//   ключ аккаунта — случайные 32 байта; на сервере лежит только обёрнутым
//     паролем (wrapped_key) и фразой восстановления (recovery_wrapped)
//   пароль vault'а для ядра = HKDF(ключ аккаунта, имя vault'а) в base64url
//
// Фраза восстановления — 24 слова BIP39 (как у vault'а в selfsync): из её энтропии
// HKDF даёт ключ обёртки и доказательство знания фразы (recovery_auth).

import { argon2id, phraseDecode, phraseEncode } from "../core/plugin/pkg/selfsync_wasm.js";

const LABEL = "selfsync-cloud/v1";
const NONCE = 12;

export interface Kdf {
  m: number;
  t: number;
  p: number;
}

/** Пределы параметров KDF с сервера. Ниже — ключ входа (он уходит на сервер)
 *  дёшево перебирается до пароля, а с ним открывается ключ аккаунта; выше —
 *  телефон не вытянет. Нижний предел — параметры сервиса по умолчанию. */
export const KDF_MIN: Kdf = { m: 64 * 1024, t: 3, p: 1 };
export const KDF_MAX: Kdf = { m: 256 * 1024, t: 10, p: 4 };

/** Сервер прислал KDF вне пределов: пароль с ним не используется. */
export class KdfError extends Error {
  readonly code = "bad_kdf";
}

/** Параметры KDF из JSON сервера (`{"alg":"argon2id","m":…,"t":…,"p":…}`). */
export function parseKdf(raw: string): Kdf {
  const v = JSON.parse(raw) as { alg?: string; m?: number; t?: number; p?: number };
  if (v.alg !== "argon2id" || !v.m || !v.t || !v.p) throw new KdfError(`kdf: ${raw}`);
  const k = { m: v.m, t: v.t, p: v.p };
  for (const f of ["m", "t", "p"] as const) {
    if (!Number.isInteger(k[f]) || k[f] < KDF_MIN[f] || k[f] > KDF_MAX[f]) throw new KdfError(`kdf: ${raw}`);
  }
  return k;
}

export function kdfJson(k: Kdf): string {
  return JSON.stringify({ alg: "argon2id", m: k.m, t: k.t, p: k.p });
}

function subtle(): SubtleCrypto {
  return window.crypto.subtle;
}

export function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  return window.crypto.getRandomValues(new Uint8Array(n));
}

async function hkdf(ikm: Uint8Array<ArrayBuffer>, info: string): Promise<Uint8Array<ArrayBuffer>> {
  const key = await subtle().importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(`${LABEL}/${info}`) },
    key,
    256,
  );
  return new Uint8Array(bits);
}

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** nonce ‖ AES-GCM(ключ, данные) с привязкой к назначению (`aad`). */
async function seal(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer>> {
  const nonce = randomBytes(NONCE);
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: new TextEncoder().encode(`${LABEL}/${aad}`) },
    await aesKey(key),
    data,
  );
  const out = new Uint8Array(NONCE + ct.byteLength);
  out.set(nonce);
  out.set(new Uint8Array(ct), NONCE);
  return out;
}

/** Раскрыть [`seal`]; чужой ключ или подмена — `null`. */
async function open(key: Uint8Array<ArrayBuffer>, sealed: Uint8Array<ArrayBuffer>, aad: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (sealed.length <= NONCE) return null;
  try {
    const pt = await subtle().decrypt(
      { name: "AES-GCM", iv: sealed.slice(0, NONCE), additionalData: new TextEncoder().encode(`${LABEL}/${aad}`) },
      await aesKey(key),
      sealed.slice(NONCE),
    );
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}

/** Ключи из пароля: ключ входа (на сервер) и ключ обёртки (остаётся здесь). */
export interface PasswordKeys {
  authKey: Uint8Array<ArrayBuffer>;
  wrapKey: Uint8Array<ArrayBuffer>;
}

export async function passwordKeys(password: string, salt: Uint8Array, kdf: Kdf): Promise<PasswordKeys> {
  const master = new Uint8Array(argon2id(password, salt, kdf.m, kdf.t, kdf.p));
  return { authKey: await hkdf(master, "auth"), wrapKey: await hkdf(master, "wrap") };
}

/** Новые учётные данные для пароля: соль, ключ входа и обёрнутый ключ аккаунта. */
export interface Credentials {
  salt: Uint8Array<ArrayBuffer>;
  kdf: Kdf;
  authKey: Uint8Array<ArrayBuffer>;
  wrappedKey: Uint8Array<ArrayBuffer>;
}

export async function credentials(password: string, accountKey: Uint8Array<ArrayBuffer>, kdf: Kdf): Promise<Credentials> {
  const salt = randomBytes(16);
  const k = await passwordKeys(password, salt, kdf);
  return { salt, kdf, authKey: k.authKey, wrappedKey: await seal(k.wrapKey, accountKey, "account-key") };
}

/** Ключ аккаунта из обёртки паролем; неверный пароль — `null`. */
export async function unwrapAccountKey(wrapKey: Uint8Array<ArrayBuffer>, wrapped: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  const k = await open(wrapKey, wrapped, "account-key");
  return k?.length === 32 ? k : null;
}

/** Фраза восстановления: слова и то, что из неё уходит на сервер. */
export interface Recovery {
  words: string[];
  /** Ключ аккаунта, обёрнутый ключом фразы. */
  wrapped: Uint8Array<ArrayBuffer>;
  /** Доказательство знания фразы (на сервере — его sha256). */
  auth: Uint8Array<ArrayBuffer>;
}

export async function newRecovery(accountKey: Uint8Array<ArrayBuffer>): Promise<Recovery> {
  const entropy = randomBytes(32);
  return {
    words: phraseEncode(entropy),
    wrapped: await seal(await hkdf(entropy, "recovery-wrap"), accountKey, "account-key"),
    auth: await hkdf(entropy, "recovery-auth"),
  };
}

/** По фразе: доказательство для сервера и ключ аккаунта из `recovery_wrapped`.
 *  Неверная фраза (не BIP39) — `null`; фраза не от этого аккаунта — ключ `null`. */
export async function openRecovery(
  phrase: string,
  wrapped: Uint8Array<ArrayBuffer>,
): Promise<{ auth: Uint8Array<ArrayBuffer>; accountKey: Uint8Array<ArrayBuffer> | null } | null> {
  const raw = phraseDecode(phrase);
  if (!raw) return null;
  const entropy = new Uint8Array(raw);
  const k = await open(await hkdf(entropy, "recovery-wrap"), wrapped, "account-key");
  return { auth: await hkdf(entropy, "recovery-auth"), accountKey: k?.length === 32 ? k : null };
}

/** Пароль vault'а для ядра: свой у каждого vault'а, выводится из ключа аккаунта. */
export async function vaultPassword(accountKey: Uint8Array<ArrayBuffer>, vault: string): Promise<string> {
  return toB64(await hkdf(accountKey, `vault/${vault}`));
}

export function toB64(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64(s: string): Uint8Array<ArrayBuffer> {
  const std = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(std + "=".repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0));
}
