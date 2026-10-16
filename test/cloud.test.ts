// Облачная часть без сервера: поддельный плагин (настройки, localStorage, ядро) и
// поддельный HTTP с ответами по маршруту. Проверяет то, что сквозной тест не видит:
// чужие адреса, ответы сервера, которым нельзя верить, и что остаётся на устройстве.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { initWasm } from "../core/plugin/src/engine.ts";
import { kdfJson, randomBytes, toB64 } from "../src/account.ts";
import type { Transport } from "../src/api.ts";
import { Cloud } from "../src/cloud.ts";
import type SelfsyncCloudPlugin from "../src/main.ts";
import { regionUrl } from "../src/regions.ts";

const ACCOUNT_KEY = "selfsync-cloud-account-key";

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
}

function fake(settings: Record<string, string> = {}, routes: Record<string, Route> = {}): Fake {
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
  };
  const plugin = {
    settings: f.settings,
    app: {
      loadLocalStorage: (k: string) => storage.get(k) ?? null,
      saveLocalStorage: (k: string, v: string | null) => (v === null ? storage.delete(k) : storage.set(k, v)),
    },
    runner: {
      send: (e: { type: string }) => sent.push(e),
      command: () => Promise.resolve({ type: "devices", devices: [] }),
    },
    saveSettings: (o: { restart?: boolean } = {}) => {
      if (o.restart) f.restarts++;
      return Promise.resolve();
    },
    forgetVault: () => Promise.resolve(),
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
  return { ...f, cloud: new Cloud(plugin as unknown as SelfsyncCloudPlugin, http) };
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
