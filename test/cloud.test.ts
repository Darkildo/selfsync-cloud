// Облачная часть без сервера: поддельный плагин (настройки, localStorage, ядро) и
// поддельный HTTP с ответами по маршруту. Проверяет то, что сквозной тест не видит:
// чужие адреса, ответы сервера, которым нельзя верить, и что остаётся на устройстве.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { initWasm } from "../core/plugin/src/engine.ts";
import { credentials, kdfJson, randomBytes, toB64, vaultPassword } from "../src/account.ts";
import type { Transport } from "../src/api.ts";
import { Cloud } from "../src/cloud.ts";
import type SelfsyncCloudPlugin from "../src/main.ts";
import { errorText, setLanguage } from "../src/i18n.ts";
import { regionUrl } from "../src/regions.ts";

const ACCOUNT_KEY = "selfsync-cloud-account-key";
const KDF = { m: 65536, t: 3, p: 1 };
const PASSWORD = "correct horse battery staple";

before(() => {
  (globalThis as Record<string, unknown>).window ??= globalThis;
  initWasm(readFileSync(new URL("../core/plugin/pkg/selfsync_wasm_bg.wasm", import.meta.url)));
});

type Route = (body: Record<string, unknown>, auth: string | undefined) => { status?: number; json: unknown };

interface Fake {
  cloud: Cloud;
  settings: Record<string, string>;
  storage: Map<string, string>;
  /** Запросы к серверу: «МЕТОД путь». */
  calls: string[];
  /** Что получило ядро. */
  sent: { type: string; password?: string }[];
  restarts: number;
  /** Сколько раз перерисовывались бы настройки. */
  changes: number;
}

type Command = (c: { type: string }) => Promise<Record<string, unknown>>;

function fake(settings: Record<string, string> = {}, routes: Record<string, Route> = {}, command?: Command): Fake {
  const storage = new Map<string, string>();
  const calls: string[] = [];
  const sent: Fake["sent"] = [];
  const f = {
    settings: {
      region: "cis",
      serviceUrl: "",
      email: "",
      session: "",
      vaultLabel: "",
      kdf: "",
      salt: "",
      wrappedKey: "",
      server: "",
      token: "",
      vault: "",
      deviceName: "test",
      ...settings,
    },
    storage,
    calls,
    sent,
    restarts: 0,
    changes: 0,
  };
  const plugin = {
    settings: f.settings,
    app: {
      loadLocalStorage: (k: string) => storage.get(k) ?? null,
      saveLocalStorage: (k: string, v: string | null) => (v === null ? storage.delete(k) : storage.set(k, v)),
    },
    runner: {
      send: (e: { type: string }) => sent.push(e),
      command: command ?? (() => Promise.resolve({ type: "devices", devices: [] })),
    },
    saveSettings: (o: { restart?: boolean } = {}) => {
      if (o.restart) f.restarts++;
      return Promise.resolve();
    },
    forgetVault: () => Promise.resolve(),
    accountChanged: () => {
      f.changes++;
    },
  };
  const http: Transport = (req) => {
    const path = new URL(req.url).pathname.replace(/^\/cloud\/v1/, "");
    const key = `${req.method} ${path}`;
    calls.push(key);
    const route = routes[key];
    if (!route) return Promise.resolve({ status: 404, text: JSON.stringify({ code: "not_found", message: key }) });
    const r = route(req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {}, req.headers.authorization);
    return Promise.resolve({ status: r.status ?? 200, text: JSON.stringify(r.json) });
  };
  return Object.assign(f, { cloud: new Cloud(plugin as unknown as SelfsyncCloudPlugin, http) });
}

test("ссылка приглашения: только адрес региона или свой адрес сервиса", async () => {
  const f = fake({ serviceUrl: "https://test.example:8443/" });
  const c = f.cloud;
  assert.ok(c.trusted(regionUrl("cis")));
  assert.ok(c.trusted(`${regionUrl("eu").toUpperCase()}/`));
  assert.ok(c.trusted("https://test.example:8443"));
  assert.ok(!c.trusted("https://evil.example"));
  assert.ok(!c.trusted(`${regionUrl("cis")}.evil.example`));
  assert.ok(!c.trusted(""));
  // Чужой сервер: ни запроса, ни подключения.
  await assert.rejects(c.redeem("https://evil.example", "ABCD1234", "pw"), (e: { code?: string }) => e.code === "untrusted_server");
  assert.deepEqual(f.calls, []);
  assert.equal(f.settings.token, "");
  assert.equal(f.restarts, 0);
});

test("вход: слабый KDF с сервера — отказ до отправки ключа входа", async () => {
  const f = fake({}, { "POST /prelogin": () => ({ json: { kdf: kdfJson({ m: 8, t: 1, p: 1 }), salt: toB64(randomBytes(16)) } }) });
  await assert.rejects(f.cloud.login("cis", "a@example.com", "correct horse battery staple"), (e: { code?: string }) => e.code === "bad_kdf");
  assert.deepEqual(f.calls, ["POST /prelogin"]);
});

test("выход забывает ключ аккаунта, ключ vault'а у ядра остаётся", async () => {
  const f = fake({ session: "cs_x", email: "a@example.com", vault: "c-1", token: "t" }, { "POST /logout": () => ({ json: null }) });
  f.storage.set(ACCOUNT_KEY, toB64(randomBytes(32)));
  f.storage.set("selfsync-master-key", "vault-key");
  await f.cloud.logout();
  assert.equal(f.settings.session, "");
  assert.equal(f.storage.has(ACCOUNT_KEY), false);
  assert.equal(f.storage.get("selfsync-master-key"), "vault-key");
  // Ключ vault'а снова — только из пароля аккаунта.
  assert.equal(f.cloud.accountKey(), null);
  // Сервис недоступен — выход всё равно локальный.
  const g = fake({ session: "cs_y" });
  g.storage.set(ACCOUNT_KEY, toB64(randomBytes(32)));
  await g.cloud.logout();
  assert.equal(g.storage.has(ACCOUNT_KEY), false);
});

/** Учётные данные аккаунта в настройках устройства: как после входа или приглашения. */
async function wrapped(key: Uint8Array<ArrayBuffer>): Promise<Record<string, string>> {
  const c = await credentials(PASSWORD, key, KDF);
  return { kdf: kdfJson(KDF), salt: toB64(c.salt), wrappedKey: toB64(c.wrappedKey) };
}

function redeemed(wrap: Record<string, string>) {
  return () => ({ status: 201, json: { token: "t-new", device_id: 7, vault: "c-b", label: "B", kdf: wrap.kdf, salt: wrap.salt, wrapped_key: wrap.wrappedKey } });
}

test("приглашение в vault другого аккаунта: сессия и ключ прежнего забываются", async () => {
  const keyA = randomBytes(32);
  const a = await wrapped(keyA);
  const b = await wrapped(randomBytes(32));
  const f = fake({ ...a, session: "cs_a", email: "a@example.com", vault: "c-a", token: "t-a" }, { "POST /invites/redeem": redeemed(b) });
  f.storage.set(ACCOUNT_KEY, toB64(keyA));
  await f.cloud.redeem(regionUrl("cis"), "CODE");
  assert.equal(f.settings.session, "");
  assert.equal(f.settings.email, "");
  assert.equal(f.storage.has(ACCOUNT_KEY), false);
  assert.equal(f.settings.wrappedKey, b.wrappedKey);
  assert.equal(f.settings.vault, "c-b");
  assert.equal(f.restarts, 1);
  // Ключа нет — без пароля vault не открыть, пароль спросят.
  assert.equal(await f.cloud.unlock(), false);
  assert.equal(f.sent.length, 0);

  // Тот же аккаунт: сессия остаётся.
  const g = fake({ ...a, session: "cs_a", email: "a@example.com" }, { "POST /invites/redeem": redeemed(a) });
  g.storage.set(ACCOUNT_KEY, toB64(keyA));
  await g.cloud.redeem(regionUrl("cis"), "CODE");
  assert.equal(g.settings.session, "cs_a");
  assert.equal(g.storage.get(ACCOUNT_KEY), toB64(keyA));
});

test("разблокировка паролем выводит ключ из пароля, даже если на устройстве лежит другой", async () => {
  const key = randomBytes(32);
  const f = fake({ ...(await wrapped(key)), vault: "c-1" });
  f.storage.set(ACCOUNT_KEY, toB64(randomBytes(32)));
  assert.equal(await f.cloud.unlock("wrong password here"), false);
  assert.equal(f.sent.length, 0);
  assert.equal(await f.cloud.unlock(PASSWORD), true);
  assert.equal(f.sent[0]?.password, await vaultPassword(key, "c-1"));
  assert.equal(f.storage.get(ACCOUNT_KEY), toB64(key));
});

test("новый vault: лимит устройств проверяется до создания vault'а", async () => {
  const account = {
    email: "a@example.com",
    tariff: { id: 1, vaults: 3, devices: 3 },
    usage: { bytes: 0, vaults: 1, devices: 3 },
    vaults: [],
    devices: [],
  };
  const f = fake({ session: "cs_a" }, { "GET /account": () => ({ json: account }), "POST /vaults": () => ({ status: 201, json: { name: "c-x" } }) });
  f.storage.set(ACCOUNT_KEY, toB64(randomBytes(32)));
  await assert.rejects(f.cloud.createVault("Notes"), (e: { code?: string }) => e.code === "device_limit");
  assert.deepEqual(f.calls, ["GET /account"]);
});

test("отключение без связи: ошибка и токен на месте; без отзыва — только здесь", async () => {
  const offline: Command = () => Promise.resolve({ type: "error", code: "offline", message: "no network" });
  const f = fake({ vault: "c-1", token: "t-1" }, {}, offline);
  f.storage.set("selfsync-master-key", "vault-key");
  await assert.rejects(f.cloud.forgetDevice(), (e: { code?: string }) => e.code === "offline");
  assert.equal(f.settings.token, "t-1");
  assert.equal(f.storage.get("selfsync-master-key"), "vault-key");
  await f.cloud.forgetDevice({ revoke: false });
  assert.equal(f.settings.token, "");
  assert.equal(f.storage.has("selfsync-master-key"), false);
  assert.equal(f.changes, 1);
});

test("ошибки сервиса и устройства — на языке интерфейса", () => {
  setLanguage("en");
  try {
    const codes = [
      "bad_credentials",
      "bad_key",
      "account_not_found",
      "email_taken",
      "bad_email",
      "email_domain_blocked",
      "account_blocked",
      "registration_closed",
      "rate_limited",
      "code_invalid",
      "bad_recovery",
      "bad_kdf",
      "device_limit",
      "vault_limit",
      "no_account",
      "no_account_key",
      "untrusted_server",
    ];
    for (const code of codes) {
      const text = errorText(Object.assign(new Error("https://x.example"), { code }));
      assert.ok(!/[а-яё]/i.test(text) && !text.startsWith("Error:") && !text.includes("{"), `${code}: ${text}`);
    }
  } finally {
    setLanguage("ru");
  }
});
