// Обмен ключом аккаунта (src/handoff.ts): векторы — для сверки с другими
// реализациями того же обмена (сервер их не считает, открытый selfsync — со своей
// меткой), и что ловится, если сервер подменяет открытые ключи.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { fromB64, randomBytes, toB64 } from "../src/account.ts";
import * as h from "../src/handoff.ts";

before(() => {
  (globalThis as Record<string, unknown>).window ??= globalThis;
});

/** Пары a (источник) и b (новое устройство), секрет QR 01..10, ключ аккаунта
 *  a0..bf, nonce c0..cb. Проверены независимо через node:crypto (ECDH, hkdfSync). */
const V = {
  a: { d: "b1nPQufRu9dgN2uxP0T6nt_-HeJDuXAjOkBOGHwpOIU", x: "RBIhkT1WhqCmVA7mqOhR18_AMZjYOdOv3fyaIyXO8Hg", y: "0fkKV87572zUB_2Yx2O1CH8WdA9zTxFNzeWQj05N6JY" },
  b: { d: "GqS5AJoFlobSXf6PrLNdQ-7fWaO5IRB8DbbAcJ4aRaU", x: "MaGV_k5keyk8UhpOnZPl3rUFfY6jMX_8iC9g7uS4wQE", y: "S6wDeFHwg86yxmigwDE1LLaRMiwUS9Kci4-lXlZEnJo" },
  A: "BEQSIZE9VoagplQO5qjoUdfPwDGY2DnTr938miMlzvB40fkKV87572zUB_2Yx2O1CH8WdA9zTxFNzeWQj05N6JY",
  B: "BDGhlf5OZHspPFIaTp2T5d61BX2OozF__IgvYO7kuMEBS6wDeFHwg86yxmigwDE1LLaRMiwUS9Kci4-lXlZEnJo",
  commit: "U6MFYdhi2AZLIl7ypuyeAVJzcKw2QqM6-_L3lMhBmz0",
  mac: "BJKsZAx3MIqtNsRi25RfxrWqzDaT-MT_EDWkZtG__LY",
  sas: "483043",
  wrapped: "wMHCw8TFxsfIycrLQCCPL19b5QsqAsLdyiwGvNukYHJy1z1sHBzp2La6jgz6BtVfq2m_U29e89usFgtu",
};
const seq = (n: number, from: number) => new Uint8Array(n).map((_, i) => from + i);
const jwk = (k: { d: string; x: string; y: string }): JsonWebKey => ({ kty: "EC", crv: "P-256", ...k });

test("векторы: ключи, обязательство, MAC, цифры и обёртка", async () => {
  const a = await h.pairFromJwk(jwk(V.a));
  const b = await h.pairFromJwk(jwk(V.b));
  assert.equal(toB64(a.pub), V.A);
  assert.equal(toB64(b.pub), V.B);
  assert.equal(toB64(await h.commitOf(a.pub)), V.commit);
  assert.equal(toB64(await h.macOf(seq(16, 1), b.pub)), V.mac);
  assert.equal(await h.sas(a.pub, b.pub), V.sas);
  const wrapped = await h.seal(a, b.pub, seq(32, 0xa0), { nonce: seq(12, 0xc0) });
  assert.equal(wrapped && toB64(wrapped), V.wrapped);
  assert.deepEqual(await h.open(b, a.pub, fromB64(V.wrapped)), seq(32, 0xa0));
});

test("обмен: обе стороны видят одни цифры, ключ открывается только у нового устройства", async () => {
  const a = await h.newPair();
  const b = await h.newPair();
  assert.equal(a.pub.length, 65);
  assert.equal(await h.sas(a.pub, b.pub), await h.sas(a.pub, b.pub));
  assert.match(await h.sas(a.pub, b.pub), /^\d{6}$/);
  const key = randomBytes(32);
  const wrapped = await h.seal(a, b.pub, key);
  assert.ok(wrapped);
  assert.deepEqual(await h.open(b, a.pub, wrapped), key);
  // Посторонний с открытыми ключами (сервер) обёртку не открывает.
  const eve = await h.newPair();
  assert.equal(await h.open(eve, a.pub, wrapped), null);
  // Подмена байта обёртки — отказ.
  const bad = wrapped.slice();
  bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 1;
  assert.equal(await h.open(b, a.pub, bad), null);
  assert.equal(await h.open(b, a.pub, wrapped.slice(0, 12)), null);
});

test("сервер подменил ключ источника: обязательство не сходится", async () => {
  const a = await h.newPair();
  const commit = await h.commitOf(a.pub);
  assert.equal(await h.commitOk(commit, a.pub), true);
  const fake = await h.newPair();
  assert.equal(await h.commitOk(commit, fake.pub), false);
});

test("сервер подменил ключ нового устройства: MAC не сходится, цифры у сторон разные", async () => {
  const a = await h.newPair();
  const b = await h.newPair();
  const eve = await h.newPair();
  const secret = randomBytes(h.SECRET_LEN);
  const mac = await h.macOf(secret, b.pub);
  assert.equal(await h.macOk(secret, b.pub, mac), true);
  // Ключ сервера с MAC настоящего устройства — отказ; MAC без секрета не подделать.
  assert.equal(await h.macOk(secret, eve.pub, mac), false);
  assert.equal(await h.macOk(randomBytes(h.SECRET_LEN), b.pub, mac), false);
  assert.equal(await h.macOk(secret, b.pub, mac.slice(0, 16)), false);
  // Без MAC (код вручную) подмену видят люди: источник считает цифры с ключом сервера.
  assert.notEqual(await h.sas(a.pub, eve.pub), await h.sas(a.pub, b.pub));
});

test("не точка кривой — не ключ обмена", async () => {
  const b = await h.newPair();
  assert.equal(await h.validPub(b.pub), true);
  const off = b.pub.slice();
  off[64] = (off[64] ?? 0) ^ 1;
  assert.equal(await h.validPub(off), false);
  assert.equal(await h.validPub(b.pub.slice(0, 33)), false);
  assert.equal(await h.validPub(new Uint8Array(65)), false);
  const a = await h.newPair();
  assert.equal(await h.seal(a, off, randomBytes(32)), null);
});

test("метка разделяет обмены: другая метка — другие цифры и обёртка не открывается", async () => {
  const a = await h.newPair();
  const b = await h.newPair();
  const label = "selfsync/join-handoff/v1";
  assert.notEqual(await h.sas(a.pub, b.pub, label), await h.sas(a.pub, b.pub));
  const wrapped = await h.seal(a, b.pub, randomBytes(32), { label });
  assert.ok(wrapped);
  assert.equal(await h.open(b, a.pub, wrapped), null);
  assert.ok(await h.open(b, a.pub, wrapped, label));
});

/** Векторы открытого selfsync: spec/vectors/handoff.json, коммит e45aed6 (ветка
 *  feat/key-handoff), сделаны его генератором scripts/handoff-vectors.mjs. Копия —
 *  test/vectors/handoff.json; случаи с меткой selfsync-cloud/handoff/v1 — наши. */
test("векторы открытого selfsync (e45aed6): обе метки совпадают побайтно, отпечаток h тоже", async () => {
  const raw = readFileSync(new URL("vectors/handoff.json", import.meta.url), "utf8");
  const cases = (JSON.parse(raw) as { cases: Record<string, string>[] }).cases;
  assert.ok(cases.some((c) => c.prefix === h.HANDOFF_LABEL));
  const hex = (s = "") => Uint8Array.from(s.match(/../g) ?? [], (x) => parseInt(x, 16));
  const pair = (secret = "", pub = "") => {
    const p = hex(pub);
    return h.pairFromJwk({ kty: "EC", crv: "P-256", d: toB64(hex(secret)), x: toB64(p.slice(1, 33)), y: toB64(p.slice(33)) });
  };
  for (const c of cases) {
    const a = await pair(c.a_secret, c.a_public);
    const b = await pair(c.b_secret, c.b_public);
    assert.deepEqual(a.pub, hex(c.a_public), String(c.prefix));
    assert.deepEqual(await h.commitOf(a.pub), hex(c.commit));
    assert.ok(c.h, "в векторе есть отпечаток");
    assert.equal(toB64(h.pinOf(hex(c.commit))), c.h);
    assert.ok(h.pinOk(hex(c.commit), fromB64(c.h ?? "")));
    assert.deepEqual(await h.macOf(hex(c.link_secret), b.pub), hex(c.mac));
    assert.equal(await h.sas(a.pub, b.pub, c.prefix), c.sas);
    assert.deepEqual(await h.seal(a, b.pub, hex(c.payload), { label: c.prefix, nonce: hex(c.nonce) }), hex(c.wrapped));
    assert.deepEqual(await h.open(b, a.pub, hex(c.wrapped), c.prefix), hex(c.payload));
  }
});
