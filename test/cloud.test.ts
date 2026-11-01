// Облачная часть без сервера: поддельный плагин (настройки, localStorage, ядро) и
// поддельный HTTP с ответами по маршруту. Проверяет то, что сквозной тест не видит:
// чужие адреса, ответы сервера, которым нельзя верить, и что остаётся на устройстве.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";

import { initWasm } from "../core/plugin/src/engine.ts";
import { credentials, fromB64, kdfJson, keyAuth, newRecovery, randomBytes, recoveryAuth, recoveryEntropy, toB64, vaultPassword } from "../src/account.ts";
import type { Transport } from "../src/api.ts";
import { Cloud, type Invite } from "../src/cloud.ts";
import * as handoff from "../src/handoff.ts";
import type SelfsyncCloudPlugin from "../src/main.ts";
import { errorText, setLanguage } from "../src/i18n.ts";
import { regionUrl } from "../src/regions.ts";

const ACCOUNT_KEY = "selfsync-cloud-account-key";
const PHRASE_WORDS = "selfsync-cloud-phrase";
const KDF = { m: 65536, t: 3, p: 1 };
const PASSWORD = "correct horse battery staple";

before(() => {
  (globalThis as Record<string, unknown>).window ??= globalThis;
  initWasm(readFileSync(new URL("../core/plugin/pkg/selfsync_wasm_bg.wasm", import.meta.url)));
});

type Route = (body: Record<string, unknown>, auth: string | undefined) => { status?: number; json: unknown };

type FakeSettings = Record<string, string | number | boolean>;

interface Fake {
  cloud: Cloud;
  settings: FakeSettings;
  storage: Map<string, string>;
  /** Тела запросов к серверу, в порядке `calls`. */
  bodies: Record<string, unknown>[];
  /** Запросы к серверу: «МЕТОД путь». */
  calls: string[];
  /** Что получило ядро. */
  sent: { type: string; password?: string }[];
  restarts: number;
  /** Сколько раз перерисовывались бы настройки. */
  changes: number;
}

type Command = (c: { type: string }) => Promise<Record<string, unknown>>;

function fake(settings: FakeSettings = {}, routes: Record<string, Route> = {}, command?: Command): Fake {
  const storage = new Map<string, string>();
  const calls: string[] = [];
  const sent: Fake["sent"] = [];
  const f = {
    settings: {
      region: "cis",
      serviceUrl: "",
      email: "",
      accountId: 0,
      session: "",
      vaultLabel: "",
      kdf: "",
      salt: "",
      wrappedKey: "",
      hasPassword: false,
      pendingVault: "",
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
      vault: { getName: () => "My vault" },
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
    bodies.push(req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {});
    const route = routes[key];
    if (!route) return Promise.resolve({ status: 404, text: JSON.stringify({ code: "not_found", message: key }) });
    const r = route(req.body ? (JSON.parse(req.body) as Record<string, unknown>) : {}, req.headers.authorization);
    return Promise.resolve({ status: r.status ?? 200, text: JSON.stringify(r.json) });
  };
  const bodies: Record<string, unknown>[] = [];
  return Object.assign(f, { bodies, cloud: new Cloud(plugin as unknown as SelfsyncCloudPlugin, http) });
}

/** Ответ `/account` аккаунта без email. */
function anonAccount(extra: Record<string, unknown> = {}) {
  return {
    id: 7,
    email: null,
    created_at: 1,
    tariff: { id: 1, title: "Free", vaults: 1, devices: 3, bytes_hard: 0, bytes_soft: 0, max_file: 0, code: "free", price: "", status: "active" },
    usage: { bytes: 0, vaults: 0, devices: 0 },
    vaults: [],
    devices: [],
    sessions: [],
    has_password: false,
    has_key_auth: true,
    phrase_version: 1,
    phrase_confirmed: false,
    terms_version: "",
    recovery_wrapped: "",
    kdf: null,
    salt: null,
    wrapped_key: null,
    ...extra,
  };
}

test("ссылка входа: только адрес региона или свой адрес сервиса", async () => {
  const f = fake({ serviceUrl: "https://test.example:8443/" });
  const c = f.cloud;
  assert.ok(c.trusted(regionUrl("cis")));
  assert.ok(c.trusted(`${regionUrl("eu").toUpperCase()}/`));
  assert.ok(c.trusted("https://test.example:8443"));
  assert.ok(!c.trusted("https://evil.example"));
  assert.ok(!c.trusted(`${regionUrl("cis")}.evil.example`));
  assert.ok(!c.trusted(""));
  // Чужой сервер: ни запроса, ни подключения.
  await assert.rejects(c.redeemAccount("https://evil.example", "ABCD1234"), (e: { code?: string }) => e.code === "untrusted_server");
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

/** Учётные данные аккаунта в настройках устройства: как после входа. */
async function wrapped(key: Uint8Array<ArrayBuffer>): Promise<Record<string, string>> {
  const c = await credentials(PASSWORD, key, KDF);
  return { kdf: kdfJson(KDF), salt: toB64(c.salt), wrappedKey: toB64(c.wrappedKey) };
}

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
      "client_outdated",
    ];
    for (const code of codes) {
      const text = errorText(Object.assign(new Error("https://x.example"), { code }));
      assert.ok(!/[а-яё]/i.test(text) && !text.startsWith("Error:") && !text.includes("{"), `${code}: ${text}`);
    }
  } finally {
    setLanguage("ru");
  }
});

test("«Начать»: аккаунт без email, ключ и фраза рождаются здесь, слова ждут отметки", async () => {
  const f = fake(
    {},
    {
      "GET /info": () => ({ json: { region: "cis", registration_open: true, kdf: kdfJson(KDF), tariffs: [], terms_version: "2026-10" } }),
      "POST /accounts": (b) => ({ status: 201, json: { session: "cs_new", account: anonAccount({ recovery_wrapped: b.recovery_wrapped }) } }),
      "GET /account": () => ({ json: anonAccount() }),
      "POST /vaults": () => ({ status: 201, json: { name: "c-new", label: "My vault", created_at: 1 } }),
      "POST /vaults/c-new/devices": () => ({ status: 201, json: { token: "ns_t", device_id: 3, vault: "c-new", label: "My vault" } }),
    },
  );
  await f.cloud.start("cis", "My vault");
  const created = f.bodies[f.calls.indexOf("POST /accounts")];
  assert.ok(created);
  assert.equal(created.terms_version, "2026-10");
  assert.equal(created.device_name, "test");
  // Ни пароля, ни ключа в запросе: только обёртки и доказательства.
  assert.deepEqual(Object.keys(created).sort(), ["device_name", "key_auth", "recovery_auth", "recovery_wrapped", "terms_version"]);
  const key = f.cloud.accountKey();
  assert.ok(key && key.length === 32);
  assert.equal(created.key_auth, toB64(await keyAuth(key)));
  assert.equal(f.settings.session, "cs_new");
  assert.equal(f.settings.accountId, 7);
  assert.equal(f.settings.hasPassword, false);
  assert.equal(f.settings.vault, "c-new");
  // Шифрование включено паролем vault'а из ключа аккаунта.
  assert.equal(f.sent[0]?.type, "enableEncryption");
  assert.equal(f.sent[0]?.password, await vaultPassword(key, "c-new"));
  // Слова фразы — на устройстве, доказательство в запросе соответствует им.
  const words = f.cloud.pendingPhrase();
  assert.ok(words && words.length === 24);
  const entropy = recoveryEntropy(words.join(" "));
  assert.ok(entropy);
  assert.equal(created.recovery_auth, toB64(await recoveryAuth(entropy)));
  assert.equal(f.cloud.phraseStatus(), "pending-here");
  // В настройках плагина (data.json) фразы нет — только в localStorage.
  assert.ok(!Object.values(f.settings).some((v) => typeof v === "string" && v.includes(words.join(" "))));
  assert.equal(f.storage.get(PHRASE_WORDS), JSON.stringify({ version: 1, words }));
});

test("отметка «записал» стирает слова; новая фраза на другом устройстве делает старые слова негодными", async () => {
  let confirmed = false;
  const f = fake(
    { session: "cs_a", accountId: 7 },
    {
      "POST /account/recovery/confirm": () => {
        confirmed = true;
        return { status: 204, json: null };
      },
      "GET /account": () => ({ json: anonAccount({ phrase_confirmed: confirmed }) }),
    },
  );
  f.storage.set(PHRASE_WORDS, JSON.stringify({ version: 1, words: Array.from({ length: 24 }, () => "abandon") }));
  await f.cloud.refreshAccount();
  assert.equal(f.cloud.phraseStatus(), "pending-here");
  await f.cloud.confirmPhrase();
  assert.equal(f.storage.has(PHRASE_WORDS), false);
  assert.equal(f.cloud.phraseStatus(), "confirmed");
  // Фразу заменили на другом устройстве (версия 2): слова версии 1 бесполезны.
  const g = fake({ session: "cs_a", accountId: 7 }, { "GET /account": () => ({ json: anonAccount({ phrase_version: 2 }) }) });
  g.storage.set(PHRASE_WORDS, JSON.stringify({ version: 1, words: Array.from({ length: 24 }, () => "abandon") }));
  await g.cloud.refreshAccount();
  assert.equal(g.cloud.phraseStatus(), "pending-elsewhere");
  assert.equal(g.storage.has(PHRASE_WORDS), false);
});

test("новая фраза: подтверждается ключом аккаунта, прежняя обёртка заменяется", async () => {
  const key = randomBytes(32);
  let body: Record<string, unknown> = {};
  const f = fake(
    { session: "cs_a", accountId: 7 },
    {
      "POST /account/recovery": (b) => {
        body = b;
        return { status: 204, json: null };
      },
      "GET /account": () => ({ json: anonAccount({ phrase_version: 2 }) }),
    },
  );
  f.storage.set(ACCOUNT_KEY, toB64(key));
  const words = await f.cloud.newPhrase();
  assert.equal(words.length, 24);
  assert.equal(body.key_auth, toB64(await keyAuth(key)));
  assert.ok(typeof body.recovery_wrapped === "string" && typeof body.recovery_auth === "string");
  assert.equal(f.cloud.phraseStatus(), "pending-here");
  assert.deepEqual(f.cloud.pendingPhrase(), words);
});

test("вход фразой: доказательство находит аккаунт, фраза открывает ключ; чужая обёртка — отказ", async () => {
  const key = randomBytes(32);
  const r = await newRecovery(key);
  const other = await newRecovery(randomBytes(32));
  const f = fake(
    {},
    {
      "POST /login/phrase": (b) => {
        assert.equal(b.recovery_auth, toB64(r.auth));
        return { json: { session: "cs_p", account: anonAccount({ recovery_wrapped: toB64(r.wrapped) }) } };
      },
    },
  );
  await f.cloud.loginPhrase("cis", r.words.join(" "));
  assert.deepEqual(f.cloud.accountKey(), key);
  assert.equal(f.settings.session, "cs_p");
  assert.equal(f.settings.hasPassword, false);
  // Не фраза — без запроса.
  const g = fake({});
  await assert.rejects(g.cloud.loginPhrase("cis", "not a phrase at all"), (e: { code?: string }) => e.code === "bad_recovery");
  assert.deepEqual(g.calls, []);
  // Сервер подсунул чужую обёртку: ключа нет, вход не засчитан.
  const h = fake({}, { "POST /login/phrase": () => ({ json: { session: "cs_x", account: anonAccount({ recovery_wrapped: toB64(other.wrapped) }) } }) });
  await assert.rejects(h.cloud.loginPhrase("cis", r.words.join(" ")), (e: { code?: string }) => e.code === "bad_recovery");
  assert.equal(h.settings.session, "");
  assert.equal(h.cloud.accountKey(), null);
});

test("код аккаунта без обмена: сессия есть, vault ждёт пароль или фразу", async () => {
  const routes = {
    "POST /account/redeem": () => ({ status: 201, json: { session: "cs_r", account: anonAccount(), vault: "c-v", password: null } }),
  };
  // Сессия есть, vault отложен; пароля у аккаунта нет — только фраза.
  const g = fake({}, routes);
  const r2 = await g.cloud.redeemAccount(regionUrl("eu"), "ABCD-EFGH-IJKL-MNOP");
  assert.deepEqual(r2, { handoff: null, password: false, vault: "c-v" });
  assert.equal(g.settings.region, "eu", "регион — по адресу из ссылки");
  assert.equal(g.settings.session, "cs_r");
  assert.equal(g.settings.vault, "");
  assert.equal(g.settings.pendingVault, "c-v");
  assert.equal(g.cloud.accountKey(), null);
  assert.equal(await g.cloud.unlock(), false);
  assert.equal(await g.cloud.unlock("any password"), false, "обёртки паролем нет");
  // Чужой сервер — ни запроса.
  const h = fake({});
  await assert.rejects(h.cloud.redeemAccount("https://evil.example", "CODE"), (e: { code?: string }) => e.code === "untrusted_server");
  assert.deepEqual(h.calls, []);
});

test("код аккаунта с паролем: пароль открывает ключ и подключает отложенный vault", async () => {
  const key = randomBytes(32);
  const w = await wrapped(key);
  const f = fake(
    {},
    {
      "POST /account/redeem": () => ({
        status: 201,
        json: { session: "cs_r", account: anonAccount({ has_password: true, kdf: w.kdf, salt: w.salt, wrapped_key: w.wrappedKey }), vault: "c-v", password: { kdf: w.kdf, salt: w.salt, wrapped_key: w.wrappedKey } },
      }),
      "POST /vaults/c-v/devices": () => ({ status: 201, json: { token: "ns_v", device_id: 5, vault: "c-v", label: "Notes" } }),
    },
  );
  const r = await f.cloud.redeemAccount(regionUrl("cis"), "ABCDEFGHIJKLMNOP");
  assert.deepEqual(r, { handoff: null, password: true, vault: "c-v" });
  assert.equal(f.settings.hasPassword, true);
  assert.equal(await f.cloud.unlock("wrong password here"), false);
  assert.equal(await f.cloud.unlock(PASSWORD), true);
  assert.equal(f.settings.vault, "c-v");
  assert.equal(f.settings.pendingVault, "");
  assert.equal(f.sent[0]?.password, await vaultPassword(key, "c-v"));
});

test("ссылка QR аккаунта несёт секрет обмена и vault, но не ключ; без ключа — кода нет", async () => {
  const key = randomBytes(32);
  const f = fake({ session: "cs_a", vault: "c-1", server: regionUrl("cis") }, { "POST /account/codes": () => ({ status: 201, json: { code: "ABCDEFGHIJKLMNOP", expires_at: 1 } }) });
  // Сервер выдаёт коды только с обменом: без ключа — отказ до запроса.
  await assert.rejects(f.cloud.accountCode(""), (e: { code?: string }) => e.code === "no_account_key");
  assert.deepEqual(f.calls, []);
  f.storage.set(ACCOUNT_KEY, toB64(key));
  const full = await f.cloud.accountCode("");
  const q2 = new URL(full.uri.replace("obsidian://", "https://x/")).searchParams;
  assert.equal(q2.has("k"), false, "ключ аккаунта в ссылку не идёт");
  assert.equal(fromB64(q2.get("m") ?? "").length, 16);
  assert.equal(q2.get("v"), "c-1");
  assert.equal(q2.get("c"), "ABCDEFGHIJKLMNOP");
  // На сервер — только обязательство открытого ключа обмена, секрет QR туда не идёт.
  assert.equal(f.bodies[0]?.commit, toB64(await handoff.commitOf(full.handoff.pair.pub)));
  assert.ok(!JSON.stringify(f.bodies).includes(q2.get("m") ?? "-"));
  assert.ok(!JSON.stringify(f.bodies).includes(toB64(key)));
  // Без сессии код создаёт токен устройства.
  const g = fake({ token: "ns_dev", vault: "c-1", server: regionUrl("cis") }, {
    "POST /account/codes": (_b, auth) => {
      assert.equal(auth, "Bearer ns_dev");
      return { status: 201, json: { code: "ABCDEFGHIJKLMNOP", expires_at: 1 } };
    },
  });
  g.storage.set(ACCOUNT_KEY, toB64(key));
  await g.cloud.accountCode("");
});

test("удаление аккаунта без пароля подтверждается ключом аккаунта", async () => {
  const key = randomBytes(32);
  let body: Record<string, unknown> = {};
  const f = fake(
    { session: "cs_a", accountId: 7 },
    {
      "DELETE /account": (b) => {
        body = b;
        return { status: 204, json: null };
      },
    },
  );
  f.storage.set(ACCOUNT_KEY, toB64(key));
  f.storage.set(PHRASE_WORDS, JSON.stringify({ version: 1, words: [] }));
  await f.cloud.deleteAccount();
  assert.deepEqual(body, { key_auth: toB64(await keyAuth(key)) });
  assert.equal(f.settings.session, "");
  assert.equal(f.settings.accountId, 0);
  assert.equal(f.storage.has(ACCOUNT_KEY), false);
  assert.equal(f.storage.has(PHRASE_WORDS), false);
});

test("email и пароль позже: обёртка ключа паролем и доказательство ключа", async () => {
  const key = randomBytes(32);
  let body: Record<string, unknown> = {};
  const f = fake(
    { session: "cs_a", accountId: 7 },
    {
      "GET /info": () => ({ json: { region: "cis", registration_open: true, kdf: kdfJson(KDF), tariffs: [] } }),
      "POST /account/email": (b) => {
        body = b;
        return { status: 204, json: null };
      },
      "GET /account": () => ({ json: anonAccount({ email: "me@example.com", has_password: true }) }),
    },
  );
  f.storage.set(ACCOUNT_KEY, toB64(key));
  await f.cloud.setEmailPassword(" Me@Example.com ", PASSWORD);
  assert.equal(body.email, " Me@Example.com ");
  assert.equal(body.key_auth, toB64(await keyAuth(key)));
  assert.equal(f.settings.hasPassword, true);
  assert.equal(f.settings.email, "me@example.com");
  // Теперь пароль открывает тот же ключ.
  f.storage.delete(ACCOUNT_KEY);
  f.settings.vault = "c-1";
  assert.equal(await f.cloud.unlock(PASSWORD), true);
  assert.deepEqual(f.cloud.accountKey(), key);
});


/** Обмен ключом на сервере: те же правила, что у `/account/handoff` (каждое поле
 *  пишется один раз, ключ источника — после ключа нового устройства, обёртка —
 *  после ключа источника, отдаётся новому устройству один раз). `tamper` —
 *  нечестный сервер: подменяет то, что отдаёт сторонам. */
function handoffServer(tamper: { toJoiner?: (pk: string) => string; toOwner?: (pk: string) => string } = {}) {
  const st: { commit?: string; joinerPk?: string; mac?: string | null; ownerPk?: string; wrapped?: string; taken?: boolean } = {};
  const owner: Record<string, Route> = {
    "POST /account/codes": (b: Record<string, unknown>) => {
      st.commit = b.commit as string | undefined;
      return { status: 201, json: { code: "ABCDEFGHIJKLMNOP", expires_at: Date.now() + 600_000 } };
    },
    "POST /account/handoff": (b: Record<string, unknown>) => {
      if (st.taken || !st.commit) return { status: 404, json: { code: "code_invalid" } };
      if (b.pk && st.joinerPk && !st.ownerPk) st.ownerPk = b.pk as string;
      if (b.wrapped && st.ownerPk && !st.wrapped) st.wrapped = b.wrapped as string;
      const pk = st.joinerPk ? (tamper.toOwner?.(st.joinerPk) ?? st.joinerPk) : null;
      return { json: { name: "phone", pk, mac: st.joinerPk ? (st.mac ?? null) : null, delivered: st.wrapped !== undefined } };
    },
  };
  const joiner: Record<string, Route> = {
    "POST /account/redeem": (b: Record<string, unknown>) => {
      if (st.commit && b.pk) {
        st.joinerPk = b.pk as string;
        st.mac = (b.mac as string | undefined) ?? null;
      }
      const offer = st.commit && b.pk ? { commit: st.commit } : null;
      return { status: 201, json: { session: "cs_j", account: anonAccount(), vault: "c-v", password: null, handoff: offer } };
    },
    "GET /account/handoff": () => {
      if (st.taken || !st.joinerPk) return { status: 404, json: { code: "no_handoff" } };
      const pk = st.ownerPk ? (tamper.toJoiner?.(st.ownerPk) ?? st.ownerPk) : null;
      if (st.wrapped) st.taken = true;
      return { json: { pk, wrapped: st.wrapped ?? null } };
    },
    "POST /vaults/c-v/devices": () => ({ status: 201, json: { token: "ns_j", device_id: 9, vault: "c-v", label: "Notes" } }),
  };
  return { st, owner, joiner };
}

/** Источник с ключом аккаунта и новое устройство на одном поддельном сервере. */
async function pairOfDevices(tamper?: Parameters<typeof handoffServer>[0]) {
  const key = randomBytes(32);
  const srv = handoffServer(tamper);
  const src = fake({ session: "cs_a", vault: "c-v", server: regionUrl("cis") }, srv.owner);
  src.storage.set(ACCOUNT_KEY, toB64(key));
  const dst = fake({}, srv.joiner);
  return { key, srv, src, dst };
}

function linkOf(inv: Invite): URLSearchParams {
  return new URL(inv.uri.replace("obsidian://", "https://x/")).searchParams;
}

test("обмен по QR: MAC сошёлся — ключ приходит без сверки цифр, на сервер ключ не уходит", async () => {
  const { key, srv, src, dst } = await pairOfDevices();
  const inv = await src.cloud.accountCode("");
  const q = linkOf(inv);
  assert.ok(inv.handoff);
  // Новое устройство ещё не вошло.
  assert.deepEqual(await src.cloud.ownerStep(inv.handoff), { state: "waiting" });
  const r = await dst.cloud.redeemAccount(q.get("s") ?? "", inv.code, { secret: q.get("m") ?? undefined, vault: q.get("v") ?? undefined });
  assert.ok(r.handoff?.qr, "код из QR — с MAC");
  assert.equal(dst.settings.pendingVault, "c-v");
  assert.deepEqual(await dst.cloud.joinerStep(r.handoff), { state: "waiting" });
  assert.deepEqual(await src.cloud.ownerStep(inv.handoff), { state: "delivered", name: "phone" });
  assert.deepEqual(await dst.cloud.joinerStep(r.handoff), { state: "done", vault: true });
  assert.deepEqual(dst.cloud.accountKey(), key);
  assert.equal(dst.settings.vault, "c-v");
  assert.equal(dst.settings.pendingVault, "");
  assert.equal(dst.sent[0]?.password, await vaultPassword(key, "c-v"));
  // Обёртку забрали — обмена больше нет.
  assert.deepEqual(await dst.cloud.joinerStep(r.handoff), { state: "gone" });
  assert.deepEqual(await src.cloud.ownerStep(inv.handoff), { state: "expired" });
  // Ни ключа аккаунта, ни секрета QR в запросах обеих сторон.
  const all = JSON.stringify([...src.bodies, ...dst.bodies]);
  assert.ok(!all.includes(toB64(key)));
  assert.ok(!all.includes(q.get("m") ?? "-"));
  assert.ok(srv.st.wrapped);
});

test("обмен по коду вручную: те же цифры на обоих экранах, ключ уходит только после подтверждения", async () => {
  const { key, srv, src, dst } = await pairOfDevices();
  const inv = await src.cloud.accountCode("");
  assert.ok(inv.handoff);
  const r = await dst.cloud.redeemAccount(regionUrl("cis"), formatted(inv.code));
  assert.ok(r.handoff && !r.handoff.qr);
  assert.equal(dst.bodies[0]?.mac, undefined);
  const o = await src.cloud.ownerStep(inv.handoff);
  assert.equal(o.state, "confirm");
  const j = await dst.cloud.joinerStep(r.handoff);
  assert.equal(j.state, "compare");
  assert.equal(o.state === "confirm" && j.state === "compare" && o.sas === j.sas, true, "цифры совпадают");
  assert.equal(srv.st.wrapped, undefined, "до подтверждения обёртки нет");
  assert.deepEqual(await src.cloud.ownerStep(inv.handoff, true), { state: "delivered", name: "phone" });
  assert.deepEqual(await dst.cloud.joinerStep(r.handoff), { state: "done", vault: true });
  assert.deepEqual(dst.cloud.accountKey(), key);
});

test("сервер подменил ключ источника: обязательство не сходится, ключ не принят", async () => {
  const eve = await handoff.newPair();
  const { src, dst } = await pairOfDevices({ toJoiner: () => toB64(eve.pub) });
  const inv = await src.cloud.accountCode("");
  const q = linkOf(inv);
  assert.ok(inv.handoff);
  const r = await dst.cloud.redeemAccount(regionUrl("cis"), inv.code, { secret: q.get("m") ?? undefined });
  assert.ok(r.handoff);
  await src.cloud.ownerStep(inv.handoff);
  assert.deepEqual(await dst.cloud.joinerStep(r.handoff), { state: "mismatch" });
  assert.equal(dst.cloud.accountKey(), null);
  assert.equal(dst.settings.vault, "");
});

test("сервер подменил ключ нового устройства: по QR MAC не сходится, обёртки нет", async () => {
  const eve = await handoff.newPair();
  const { srv, src, dst } = await pairOfDevices({ toOwner: () => toB64(eve.pub) });
  const inv = await src.cloud.accountCode("");
  const q = linkOf(inv);
  assert.ok(inv.handoff);
  await dst.cloud.redeemAccount(regionUrl("cis"), inv.code, { secret: q.get("m") ?? undefined });
  assert.deepEqual(await src.cloud.ownerStep(inv.handoff), { state: "mismatch", name: "phone" });
  assert.equal(srv.st.wrapped, undefined);
  assert.equal(srv.st.ownerPk, undefined, "свой ключ не раскрыт");
});

test("сервер сменил ключ нового устройства после показа цифр: подтверждение не передаёт ключ", async () => {
  const eve = await handoff.newPair();
  let swap = false;
  const { srv, src, dst } = await pairOfDevices({ toOwner: (pk) => (swap ? toB64(eve.pub) : pk) });
  const inv = await src.cloud.accountCode("");
  assert.ok(inv.handoff);
  await dst.cloud.redeemAccount(regionUrl("cis"), inv.code);
  assert.equal((await src.cloud.ownerStep(inv.handoff)).state, "confirm");
  swap = true;
  assert.deepEqual(await src.cloud.ownerStep(inv.handoff, true), { state: "mismatch", name: "phone" });
  assert.equal(srv.st.wrapped, undefined);
});

test("старый источник без обмена: новое устройство ждёт пароль или фразу", async () => {
  const f = fake({}, { "POST /account/redeem": () => ({ status: 201, json: { session: "cs_r", account: anonAccount(), vault: "c-v", password: null } }) });
  const r = await f.cloud.redeemAccount(regionUrl("cis"), "ABCDEFGHIJKLMNOP", { secret: toB64(randomBytes(16)) });
  assert.equal(r.handoff, null);
  assert.ok(f.bodies[0]?.pk, "свой ключ обмена предложен");
  assert.ok(f.bodies[0]?.mac);
  assert.equal(f.settings.pendingVault, "c-v");
});

function formatted(code: string): string {
  return code.replace(/(.{4})(?=.)/g, "$1-");
}


test("ключ получен, а vault не подключился: ключ остаётся, vault выбрать заново", async () => {
  const { key, srv, src, dst } = await pairOfDevices();
  srv.joiner["POST /vaults/c-v/devices"] = () => ({ status: 409, json: { code: "device_limit" } });
  const inv = await src.cloud.accountCode("");
  const q = linkOf(inv);
  assert.ok(inv.handoff);
  const r = await dst.cloud.redeemAccount(regionUrl("cis"), inv.code, { secret: q.get("m") ?? undefined, vault: "c-v" });
  assert.ok(r.handoff);
  await src.cloud.ownerStep(inv.handoff);
  const done = await dst.cloud.joinerStep(r.handoff);
  assert.equal(done.state === "done" && done.vault, false);
  assert.equal(done.state === "done" && (done.error as { code?: string }).code, "device_limit");
  assert.deepEqual(dst.cloud.accountKey(), key);
  assert.equal(dst.settings.pendingVault, "c-v");
});
