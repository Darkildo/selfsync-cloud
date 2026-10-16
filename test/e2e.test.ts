// Сквозной путь против настоящего сервера Selfsync Cloud (закрытый репозиторий):
// регистрация, новый vault с файлами, приглашение по QR и по коду, вход, лимит
// устройств, восстановление по фразе. Главное — открытый текст не попадает на
// сервер ни в одном файле.
//
// Нужен бинарь сервера: SELFSYNC_CLOUD_BIN или ../selfsync-cloud-server/target/debug/selfsync.
// Без него тесты пропускаются (публичный CI сервера не видит).

import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import Module from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import * as obsidian from "../core/plugin/test/obsidian-stub.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const BIN = process.env.SELFSYNC_CLOUD_BIN ?? join(ROOT, "../selfsync-cloud-server/target/debug/selfsync");
const SKIP = existsSync(BIN) ? false : `нет бинаря облачного сервера ${BIN}`;

const PASSWORD = "correct horse battery staple";
const NEW_PASSWORD = "another quite long passphrase";
const SECRET = "секретная строка 7f3a9c";

interface Status {
  state: string;
  reason?: string | null;
  encrypted: boolean;
  pending: number;
}

interface CloudPart {
  start(region: string, label: string): Promise<void>;
  loginPhrase(region: string, phrase: string): Promise<unknown>;
  pendingPhrase(): string[] | null;
  phraseStatus(): string;
  confirmPhrase(): Promise<void>;
  newPhrase(): Promise<string[]>;
  accountCode(name: string): Promise<{ code: string; uri: string }>;
  redeemAccount(server: string, code: string, o?: { key?: string; vault?: string }): Promise<{ key: boolean; password: boolean; vault: string | null }>;
  setEmailPassword(email: string, password: string): Promise<void>;
  deleteAccount(password?: string): Promise<void>;
  logoutAll(): Promise<void>;
  revokeSession(id: number): Promise<void>;
  account: { id: number; email: string | null; has_password: boolean; phrase_confirmed: boolean; sessions: { id: number; name: string; current: boolean }[] } | null;
  register(region: string, email: string, password: string): Promise<string[]>;
  login(region: string, email: string, password: string): Promise<{ vaults: { name: string }[]; devices: { id: number; name: string }[] }>;
  recover(region: string, email: string, phrase: string, password: string): Promise<unknown>;
  createVault(label: string): Promise<void>;
  connectVault(name: string): Promise<void>;
  redeem(server: string, code: string, vaultPassword?: string): Promise<void>;
  unlock(password?: string): Promise<boolean>;
  changePassword(oldPassword: string, newPassword: string): Promise<boolean>;
  invite(name: string): Promise<{ code: string; uri: string }>;
  revokeDevice(id: number): Promise<void>;
  refreshAccount(): Promise<{ id: number; devices: { id: number; name: string }[]; sessions: { id: number; name: string; current: boolean }[] } | null>;
}

interface Plugin {
  onload(): Promise<void>;
  onunload(): void;
  settings: Record<string, string>;
  cloud: CloudPart;
  runner?: { idle(): Promise<void>; send(e: unknown): void; status(): Status };
}

let server: { url: string; data: string; proc: ChildProcess } | undefined;
/** Тела всех запросов плагинов к серверу. */
const sent: Buffer[] = [];
const plugins: Plugin[] = [];

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => resolve(typeof a === "object" && a ? a.port : 0));
    });
    s.on("error", reject);
  });
}

before(async () => {
  if (SKIP) return;
  const b = spawnSync("node", ["esbuild.config.mjs", "production"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  // Весь HTTP плагинов — через заглушку requestUrl: записываем тела запросов.
  const spied = {
    ...obsidian,
    requestUrl: (p: Parameters<typeof obsidian.requestUrl>[0]) => {
      if (p.body) sent.push(Buffer.from(typeof p.body === "string" ? p.body : new Uint8Array(p.body)));
      return obsidian.requestUrl(p);
    },
  };
  const m = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
  const orig = m._load;
  m._load = function (req: string, ...rest: unknown[]) {
    if (req === "obsidian") return spied;
    return orig.call(this, req, ...rest);
  };
  const g = globalThis as Record<string, unknown>;
  g.document = { visibilityState: "visible" };
  g.window ??= globalThis;

  const data = await fsp.mkdtemp(join(tmpdir(), "selfsync-cloud-srv-"));
  const port = await freePort();
  const proc = spawn(BIN, ["--data", data, "serve", "--listen", `127.0.0.1:${port}`], {
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, SELFSYNC_LOG: "warn" },
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (await fetch(`${url}/v1/health`).then((r) => r.ok, () => false)) {
      server = { url, data, proc };
      return;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill();
  throw new Error("сервер не поднялся");
});

after(() => {
  for (const p of plugins) p.onunload();
  server?.proc.kill();
});

async function device(name: string): Promise<{ plugin: Plugin; dir: string }> {
  const dir = await fsp.mkdtemp(join(tmpdir(), `selfsync-cloud-${name}-`));
  const req = Module.createRequire(import.meta.url);
  const Main = (req(join(ROOT, "main.js")) as { default: new (app: unknown, manifest: unknown) => Plugin }).default;
  const plugin = new Main(obsidian.stubApp(dir, { serviceUrl: server?.url, deviceName: name }), { id: "selfsync-cloud", version: "0.2.0" });
  await plugin.onload();
  plugins.push(plugin);
  return { plugin, dir };
}

/** Синк до условия (ключ, файлы); иначе — ошибка с последним статусом. */
async function until(p: Plugin, what: string, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 150; i++) {
    p.runner?.send({ type: "syncNow" });
    await p.runner?.idle();
    if (ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`не дождались: ${what}; статус ${JSON.stringify(p.runner?.status())}`);
}

function read(dir: string, path: string): string | null {
  const f = join(dir, path);
  return existsSync(f) ? readFileSync(f, "utf8") : null;
}

/** Все файлы под каталогом. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test("облако: регистрация, vault, QR, код, вход, лимит, восстановление — без открытого текста на сервере", { skip: SKIP }, async () => {
  assert.ok(server);
  const email = "e2e@example.com";

  // A: регистрация и новый vault, в котором уже есть файлы.
  const a = await device("laptop");
  await fsp.writeFile(join(a.dir, "note.md"), `${SECRET}\n`);
  await fsp.mkdir(join(a.dir, "dir"));
  await fsp.writeFile(join(a.dir, "dir", "deep.md"), `${SECRET} deep\n`);
  const words = await a.plugin.cloud.register("cis", email, PASSWORD);
  assert.equal(words.length, 24);
  await a.plugin.cloud.createVault("Notes");
  const laptop = (await a.plugin.cloud.refreshAccount())?.devices.find((x) => x.name === "laptop");
  assert.equal(Number(a.plugin.settings.deviceId), laptop?.id, "номер устройства запомнен");
  await until(a.plugin, "шифрование и отправка на A", () => {
    const s = a.plugin.runner?.status();
    return s?.encrypted === true && s.pending === 0 && s.state === "idle";
  });

  // B: QR — пароль vault'а в ссылке, ключ открывается сразу.
  const inv = await a.plugin.cloud.invite("phone");
  const q = new URL(inv.uri.replace("obsidian://", "https://x/"));
  assert.equal(q.searchParams.get("c"), inv.code);
  const b = await device("phone");
  await b.plugin.cloud.redeem(q.searchParams.get("s") ?? "", inv.code, q.searchParams.get("k") ?? undefined);
  await until(b.plugin, "файлы на B", () => read(b.dir, "dir/deep.md") === `${SECRET} deep\n`);
  assert.equal(read(b.dir, "note.md"), `${SECRET}\n`);

  // C: текстовый код — нужен пароль аккаунта.
  const inv2 = await a.plugin.cloud.invite("tablet");
  const c = await device("tablet");
  await c.plugin.cloud.redeem(server.url, inv2.code.replace(/(.{4})/g, "$1-"));
  await until(c.plugin, "C просит пароль", () => c.plugin.runner?.status().state === "needPassword");
  assert.equal(read(c.dir, "note.md"), null, "без ключа ничего не скачано");
  assert.equal(await c.plugin.cloud.unlock("wrong password"), false);
  assert.equal(await c.plugin.cloud.unlock(PASSWORD), true);
  await until(c.plugin, "файлы на C", () => read(c.dir, "note.md") === `${SECRET}\n`);

  // D: вход в аккаунт. Бесплатный тариф — три устройства: четвёртое не пускают.
  const d = await device("desktop");
  const acc = await d.plugin.cloud.login("cis", email, PASSWORD);
  assert.equal(acc.vaults.length, 1);
  const vault = acc.vaults[0]?.name ?? "";
  await assert.rejects(d.plugin.cloud.connectVault(vault), (e: { code?: string }) => e.code === "device_limit");
  const tablet = acc.devices.find((x) => x.name === "tablet");
  assert.ok(tablet);
  await d.plugin.cloud.revokeDevice(tablet.id);
  await d.plugin.cloud.connectVault(vault);
  await until(d.plugin, "файлы на D", () => read(d.dir, "note.md") === `${SECRET}\n`);

  // Правка с D доходит до A.
  await fsp.writeFile(join(d.dir, "from-d.md"), `${SECRET} from d\n`);
  await until(d.plugin, "отправка с D", () => d.plugin.runner?.status().pending === 0);
  await until(a.plugin, "правка D на A", () => read(a.dir, "from-d.md") === `${SECRET} from d\n`);

  // E: забыли пароль — фраза задаёт новый; старый больше не входит.
  const e = await device("recovery");
  await e.plugin.cloud.recover("cis", email, words.join(" "), NEW_PASSWORD);
  await assert.rejects(e.plugin.cloud.login("cis", email, PASSWORD), (err: { code?: string }) => err.code === "bad_credentials");
  await e.plugin.cloud.login("cis", email, NEW_PASSWORD);
  // Смена пароля из плагина: неверный текущий — отказ без запроса; верный — новый входит.
  assert.equal(await e.plugin.cloud.changePassword("not the password", "third long passphrase x"), false);
  assert.equal(await e.plugin.cloud.changePassword(NEW_PASSWORD, "third long passphrase x"), true);
  await assert.rejects(e.plugin.cloud.login("cis", email, NEW_PASSWORD), (err: { code?: string }) => err.code === "bad_credentials");
  await e.plugin.cloud.login("cis", email, "third long passphrase x");
  // Устройства с токеном и ключом продолжают синхронизироваться.
  await fsp.writeFile(join(b.dir, "after.md"), "после смены пароля\n");
  await until(b.plugin, "отправка с B", () => b.plugin.runner?.status().pending === 0);
  await until(a.plugin, "правка B на A", () => read(a.dir, "after.md") === "после смены пароля\n");

  // Открытый текст и имена файлов не уходили на сервер ни в одном запросе — даже
  // на время (миграция потом вычистила бы его с диска, но сервер его уже видел).
  assert.ok(sent.length > 10);
  for (const body of sent) {
    assert.ok(!body.includes(Buffer.from("секретная строка")), "открытый текст в запросе");
    assert.ok(!body.includes(Buffer.from("deep.md")), "открытое имя файла в запросе");
  }
  // Сервер не видел открытого текста: ни в блобах, ни в базах, ни в журналах WAL.
  const needle = Buffer.from("секретная строка");
  for (const f of files(server.data)) {
    assert.ok(!readFileSync(f).includes(needle), `открытый текст в ${f}`);
  }
  // Имена файлов тоже зашифрованы.
  for (const f of files(server.data)) {
    assert.ok(!readFileSync(f).includes(Buffer.from("deep.md")), `открытое имя файла в ${f}`);
  }
});

test("облако C7: старт без email, QR аккаунта, вход фразой, email и пароль позже — без открытого текста на сервере", { skip: SKIP }, async () => {
  assert.ok(server);
  sent.length = 0;

  // A: одно нажатие — аккаунт и vault; фраза ждёт отметки на устройстве.
  const a = await device("laptop");
  await fsp.writeFile(join(a.dir, "note.md"), `${SECRET} c7\n`);
  await a.plugin.cloud.start("cis", "Notes");
  assert.equal(a.plugin.settings.hasPassword, false);
  assert.equal(a.plugin.cloud.account?.email, null);
  assert.equal(a.plugin.cloud.phraseStatus(), "pending-here");
  const words = a.plugin.cloud.pendingPhrase();
  assert.ok(words && words.length === 24);
  await until(a.plugin, "шифрование и отправка на A", () => {
    const s = a.plugin.runner?.status();
    return s?.encrypted === true && s.pending === 0 && s.state === "idle";
  });

  // B: QR аккаунта — ключ и vault в ссылке, устройство входит и подключается сразу.
  const inv = await a.plugin.cloud.accountCode("phone");
  const q = new URL(inv.uri.replace("obsidian://", "https://x/"));
  assert.equal(q.searchParams.get("c"), inv.code);
  assert.ok(q.searchParams.get("k"));
  const b = await device("phone");
  const rb = await b.plugin.cloud.redeemAccount(q.searchParams.get("s") ?? "", inv.code, { key: q.searchParams.get("k") ?? undefined, vault: q.searchParams.get("v") ?? undefined });
  assert.deepEqual(rb, { key: true, password: false, vault: a.plugin.settings.vault });
  await until(b.plugin, "файлы на B", () => read(b.dir, "note.md") === `${SECRET} c7\n`);
  // На B слов нет, но аккаунт знает: фраза не записана.
  assert.equal(b.plugin.cloud.phraseStatus(), "pending-elsewhere");

  // C: текстовый код без пароля — только фраза.
  const inv2 = await a.plugin.cloud.accountCode("tablet");
  const c = await device("tablet");
  const rc = await c.plugin.cloud.redeemAccount(server.url, inv2.code);
  assert.deepEqual(rc, { key: false, password: false, vault: a.plugin.settings.vault });
  assert.equal(c.plugin.settings.pendingVault, a.plugin.settings.vault);
  assert.equal(read(c.dir, "note.md"), null, "без ключа ничего не скачано");
  await c.plugin.cloud.loginPhrase("cis", words.join(" "));
  await c.plugin.cloud.unlock();
  await until(c.plugin, "файлы на C", () => read(c.dir, "note.md") === `${SECRET} c7\n`);

  // Отметка «записал» на A снимает напоминание у всех.
  await a.plugin.cloud.confirmPhrase();
  assert.equal(a.plugin.cloud.phraseStatus(), "confirmed");
  assert.equal(a.plugin.cloud.pendingPhrase(), null);
  await b.plugin.cloud.refreshAccount();
  assert.equal(b.plugin.cloud.phraseStatus(), "confirmed");

  // Входы аккаунта видны, лишний закрывается.
  const acc = await a.plugin.cloud.refreshAccount();
  assert.ok(acc && acc.sessions.length === 3, JSON.stringify(acc?.sessions));
  const tablet = acc.sessions.find((x) => x.name === "tablet");
  assert.ok(tablet && !tablet.current);
  await a.plugin.cloud.revokeSession(tablet.id);
  assert.equal((await c.plugin.cloud.refreshAccount()), null, "сессия C закрыта");
  // Синк C от этого не зависит: токен устройства остаётся.
  await fsp.writeFile(join(c.dir, "from-c.md"), `${SECRET} from c\n`);
  await until(c.plugin, "отправка с C", () => c.plugin.runner?.status().pending === 0);
  await until(a.plugin, "правка C на A", () => read(a.dir, "from-c.md") === `${SECRET} from c\n`);

  // Email и пароль позже: вход вводом на новом устройстве D.
  await a.plugin.cloud.setEmailPassword("c7@example.com", PASSWORD);
  assert.equal(a.plugin.settings.hasPassword, true);
  const d = await device("desktop");
  const accD = await d.plugin.cloud.login("cis", "c7@example.com", PASSWORD);
  assert.equal(accD.vaults.length, 1);
  // Лимит устройств бесплатного тарифа — три: отозвать планшет.
  const tabletDev = accD.devices.find((x) => x.name === "tablet");
  assert.ok(tabletDev);
  await d.plugin.cloud.revokeDevice(tabletDev.id);
  await d.plugin.cloud.connectVault(accD.vaults[0]?.name ?? "");
  await until(d.plugin, "файлы на D", () => read(d.dir, "note.md") === `${SECRET} c7\n`);

  // Новая фраза с B заменяет старую: старые слова больше не входят.
  const fresh = await b.plugin.cloud.newPhrase();
  assert.equal(fresh.length, 24);
  const e = await device("recovery");
  await assert.rejects(e.plugin.cloud.loginPhrase("cis", words.join(" ")), (err: { code?: string }) => err.code === "bad_recovery");
  await e.plugin.cloud.loginPhrase("cis", fresh.join(" "));

  // Открытый текст и имена файлов не уходили на сервер ни в одном запросе.
  assert.ok(sent.length > 10);
  for (const body of sent) {
    assert.ok(!body.includes(Buffer.from("секретная строка")), "открытый текст в запросе");
    assert.ok(!body.includes(Buffer.from("from-c.md")), "открытое имя файла в запросе");
  }
  const needle = Buffer.from("секретная строка");
  for (const f of files(server.data)) {
    assert.ok(!readFileSync(f).includes(needle), `открытый текст в ${f}`);
    // Слова фразы тоже не покидают устройство.
    assert.ok(!readFileSync(f).includes(Buffer.from(words.join(" "))), `фраза в ${f}`);
  }
});

