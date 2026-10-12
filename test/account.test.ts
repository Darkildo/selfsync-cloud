// Ключи аккаунта: обёртка паролем и фразой, пароли vault'ов, base64url.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { initWasm } from "../core/plugin/src/engine.ts";
import {
  credentials,
  fromB64,
  type Kdf,
  kdfJson,
  newRecovery,
  openRecovery,
  parseKdf,
  passwordKeys,
  randomBytes,
  toB64,
  unwrapAccountKey,
  vaultPassword,
} from "../src/account.ts";

const KDF: Kdf = { m: 64, t: 1, p: 1 };

before(() => {
  (globalThis as Record<string, unknown>).window ??= globalThis;
  initWasm(readFileSync(new URL("../core/plugin/pkg/selfsync_wasm_bg.wasm", import.meta.url)));
});

test("пароль открывает ключ аккаунта, другой пароль — нет", async () => {
  const key = randomBytes(32);
  const c = await credentials("correct horse battery", key, KDF);
  assert.equal(c.salt.length, 16);
  assert.equal(c.wrappedKey.length, 12 + 32 + 16);
  const right = await passwordKeys("correct horse battery", c.salt, KDF);
  assert.deepEqual(right.authKey, c.authKey);
  assert.deepEqual(await unwrapAccountKey(right.wrapKey, c.wrappedKey), key);
  const wrong = await passwordKeys("correct horse batterY", c.salt, KDF);
  assert.notDeepEqual(wrong.authKey, c.authKey);
  assert.equal(await unwrapAccountKey(wrong.wrapKey, c.wrappedKey), null);
  // Ключ входа и ключ обёртки разные: сервер, зная первый, не откроет ключ аккаунта.
  assert.notDeepEqual(right.authKey, right.wrapKey);
  assert.equal(await unwrapAccountKey(right.authKey, c.wrappedKey), null);
});

test("соль своя у каждой обёртки, подмена байта ломает обёртку", async () => {
  const key = randomBytes(32);
  const a = await credentials("same password here", key, KDF);
  const b = await credentials("same password here", key, KDF);
  assert.notDeepEqual(a.salt, b.salt);
  assert.notDeepEqual(a.authKey, b.authKey);
  const k = await passwordKeys("same password here", a.salt, KDF);
  const tampered = a.wrappedKey.slice();
  tampered[20] = (tampered[20] ?? 0) ^ 1;
  assert.equal(await unwrapAccountKey(k.wrapKey, tampered), null);
});

test("фраза восстановления: 24 слова открывают ключ и дают доказательство", async () => {
  const key = randomBytes(32);
  const r = await newRecovery(key);
  assert.equal(r.words.length, 24);
  const opened = await openRecovery(r.words.join(" "), r.wrapped);
  assert.ok(opened);
  assert.deepEqual(opened.accountKey, key);
  assert.deepEqual(opened.auth, r.auth);
  // Регистр и лишние пробелы не важны (как у фразы vault'а).
  const loose = await openRecovery(`  ${r.words.join("   ").toUpperCase()} `, r.wrapped);
  assert.deepEqual(loose?.accountKey, key);
  // Чужая фраза: формат верный, ключ не открывается.
  const other = await newRecovery(key);
  const foreign = await openRecovery(other.words.join(" "), r.wrapped);
  assert.equal(foreign?.accountKey, null);
  assert.equal(await openRecovery("not a phrase", r.wrapped), null);
});

test("пароль vault'а: свой у каждого vault'а и стабильный", async () => {
  const key = randomBytes(32);
  const a = await vaultPassword(key, "c-aaaa");
  assert.equal(a, await vaultPassword(key, "c-aaaa"));
  assert.notEqual(a, await vaultPassword(key, "c-bbbb"));
  assert.notEqual(a, await vaultPassword(randomBytes(32), "c-aaaa"));
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
});

test("base64url и параметры KDF", () => {
  for (const n of [0, 1, 2, 3, 31, 32, 33]) {
    const b = randomBytes(n);
    assert.deepEqual(fromB64(toB64(b)), b);
  }
  assert.ok(!toB64(new Uint8Array([251, 255])).match(/[+/=]/));
  assert.deepEqual(parseKdf(kdfJson(KDF)), KDF);
  assert.deepEqual(parseKdf('{"alg":"argon2id","m":65536,"t":3,"p":1}'), { m: 65536, t: 3, p: 1 });
  assert.throws(() => parseKdf('{"alg":"scrypt","m":1,"t":1,"p":1}'));
});
