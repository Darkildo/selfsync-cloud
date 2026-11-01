// Передача ключа аккаунта новому устройству обменом ECDH мимо сервера
// (docs/cloud-api.md сервера, «Передача ключа по коду»). Сервер видит только
// открытые ключи, обязательство, MAC и обёртку:
//
//   источник:  пара a/A, commit = sha256(A) — в код; секрет m (16 байт) — в QR
//   новое:     пара b/B, mac = HMAC-SHA256(m, B) — если код из QR
//   оба:       цифры = u32be(sha256(метка ‖ " sas" ‖ A ‖ B)[0..4]) mod 10⁶
//   ключ:      k = HKDF-SHA256(x(ECDH), salt = A ‖ B, info = метка ‖ " key")
//   обёртка:   nonce(12) ‖ AES-256-GCM(k, ключ аккаунта), без AAD
//
// Точки P-256 — несжатые SEC1 (65 байт), общий секрет ECDH — координата x
// (32 байта). Метка — параметр: тот же обмен у открытого selfsync будет со
// своей меткой. Модуль ничего не знает о сервере и плагине — только WebCrypto.

/** Метка обмена Selfsync Cloud. */
export const HANDOFF_LABEL = "selfsync-cloud/handoff/v1";
/** Секрет QR, байт. */
export const SECRET_LEN = 16;
const NONCE = 12;
const CURVE = { name: "ECDH", namedCurve: "P-256" } as const;

function subtle(): SubtleCrypto {
  return window.crypto.subtle;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const text = (s: string) => new TextEncoder().encode(s);

/** Пара обмена: закрытый ключ не покидает WebCrypto, открытый — 65 байт. */
export interface Pair {
  priv: CryptoKey;
  pub: Uint8Array<ArrayBuffer>;
}

export async function newPair(): Promise<Pair> {
  const k = await subtle().generateKey(CURVE, false, ["deriveBits"]);
  return { priv: k.privateKey, pub: new Uint8Array(await subtle().exportKey("raw", k.publicKey)) };
}

/** Пара из JWK (векторы тестов). */
export async function pairFromJwk(jwk: JsonWebKey): Promise<Pair> {
  const priv = await subtle().importKey("jwk", jwk, CURVE, false, ["deriveBits"]);
  const pub = await subtle().importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, CURVE, true, []);
  return { priv, pub: new Uint8Array(await subtle().exportKey("raw", pub)) };
}

/** Открытый ключ другой стороны; не точка кривой или не 65 байт — `null`. */
async function peer(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey | null> {
  if (raw.length !== 65 || raw[0] !== 4) return null;
  try {
    return await subtle().importKey("raw", raw, CURVE, false, []);
  } catch {
    return null;
  }
}

export async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().digest("SHA-256", data));
}

/** Обязательство источника: его открытый ключ до того, как он раскрыт. */
export function commitOf(pub: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return sha256(pub);
}

/** Раскрытый ключ источника совпадает с обязательством из кода. */
export async function commitOk(commit: Uint8Array<ArrayBuffer>, pub: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return equal(await commitOf(pub), commit);
}

async function hmacKey(secret: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  return subtle().importKey("raw", secret, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** MAC нового устройства секретом из QR: источник узнаёт свой QR без сверки цифр. */
export async function macOf(secret: Uint8Array<ArrayBuffer>, pub: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await subtle().sign("HMAC", await hmacKey(secret), pub));
}

export async function macOk(secret: Uint8Array<ArrayBuffer>, pub: Uint8Array<ArrayBuffer>, mac: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return mac.length === 32 && subtle().verify("HMAC", await hmacKey(secret), mac, pub);
}

/** Шесть цифр сверки: одинаковые на обоих устройствах, если сервер не подменил ключи. */
export async function sas(a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>, label = HANDOFF_LABEL): Promise<string> {
  const h = await sha256(concat(text(`${label} sas`), a, b));
  const n = new DataView(h.buffer).getUint32(0, false) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** Ключ обёртки из ECDH: `own` — своя пара, `other` — открытый ключ другой
 *  стороны, `a`/`b` — открытые ключи источника и нового устройства. */
async function wrapKey(own: Pair, other: Uint8Array<ArrayBuffer>, a: Uint8Array<ArrayBuffer>, b: Uint8Array<ArrayBuffer>, label: string): Promise<CryptoKey | null> {
  const p = await peer(other);
  if (!p) return null;
  const shared = new Uint8Array(await subtle().deriveBits({ name: "ECDH", public: p }, own.priv, 256));
  const ikm = await subtle().importKey("raw", shared, "HKDF", false, ["deriveKey"]);
  return subtle().deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: concat(a, b), info: text(`${label} key`) },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Источник: ключ аккаунта для нового устройства с ключом `b`. Не точка — `null`. */
export async function seal(
  own: Pair,
  b: Uint8Array<ArrayBuffer>,
  accountKey: Uint8Array<ArrayBuffer>,
  o: { label?: string; nonce?: Uint8Array<ArrayBuffer> } = {},
): Promise<Uint8Array<ArrayBuffer> | null> {
  const k = await wrapKey(own, b, own.pub, b, o.label ?? HANDOFF_LABEL);
  if (!k) return null;
  const nonce = o.nonce ?? window.crypto.getRandomValues(new Uint8Array(NONCE));
  const ct = await subtle().encrypt({ name: "AES-GCM", iv: nonce }, k, accountKey);
  return concat(nonce, new Uint8Array(ct));
}

/** Новое устройство: ключ аккаунта от источника с ключом `a`. Подмена или
 *  чужой ключ — `null`. */
export async function open(
  own: Pair,
  a: Uint8Array<ArrayBuffer>,
  wrapped: Uint8Array<ArrayBuffer>,
  label = HANDOFF_LABEL,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (wrapped.length <= NONCE) return null;
  const k = await wrapKey(own, a, a, own.pub, label);
  if (!k) return null;
  try {
    const pt = new Uint8Array(await subtle().decrypt({ name: "AES-GCM", iv: wrapped.slice(0, NONCE) }, k, wrapped.slice(NONCE)));
    return pt.length === 32 ? pt : null;
  } catch {
    return null;
  }
}

/** Открытый ключ годится для обмена (точка P-256). */
export async function validPub(raw: Uint8Array<ArrayBuffer>): Promise<boolean> {
  return (await peer(raw)) !== null;
}

function equal(x: Uint8Array, y: Uint8Array): boolean {
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return d === 0;
}
