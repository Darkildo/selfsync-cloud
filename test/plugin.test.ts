// Собранный main.js целиком (WASM встроен) на заглушке Obsidian из core/: плагин
// загружается поверх открытого selfsync, вкладка настроек рисует облачные разделы.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import Module from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { before, test } from "node:test";

import * as obsidian from "../core/plugin/test/obsidian-stub.ts";

const ROOT = new URL("..", import.meta.url).pathname;
/** Своя сборка main.js: сквозной тест параллельно собирает свою. */
const MAIN = join(mkdtempSync(join(tmpdir(), "selfsync-cloud-build-")), "main.js");

before(() => {
  const b = spawnSync("node", ["esbuild.config.mjs", "production"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, SELFSYNC_CLOUD_OUT: MAIN } });
  assert.equal(b.status, 0, b.stderr);
  // main.js делает require("obsidian") — подставить заглушку.
  const m = Module as unknown as { _load: (req: string, ...rest: unknown[]) => unknown };
  const orig = m._load;
  m._load = function (req: string, ...rest: unknown[]) {
    if (req === "obsidian") return obsidian;
    return orig.call(this, req, ...rest);
  };
  const g = globalThis as Record<string, unknown>;
  g.document = { visibilityState: "visible" };
  g.window ??= globalThis;
});

interface LoadedPlugin {
  onload(): Promise<void>;
  onunload(): void;
  runner?: unknown;
  settings: Record<string, unknown>;
  commands: { id: string }[];
  settingTab: { getSettingDefinitions(): { heading: string; items: { render(s: unknown): unknown }[] }[] };
  engineConfig(): Record<string, unknown>;
  core(): { version: string; protocol: number };
}

async function load(data: unknown, storage: Record<string, string> = {}): Promise<LoadedPlugin> {
  const dir = await fsp.mkdtemp(join(tmpdir(), "selfsync-cloud-"));
  const req = Module.createRequire(import.meta.url);
  const Main = (req(MAIN) as { default: new (app: unknown, manifest: unknown) => LoadedPlugin }).default;
  // Регион без адреса: отрисовка настроек не ходит в сеть к настоящему сервису.
  const app = obsidian.stubApp(dir, { region: "offline", ...(data as object) });
  Object.assign(app.storage, storage);
  const plugin = new Main(app, { id: "selfsync-cloud", version: "0.2.0" });
  await plugin.onload();
  return plugin;
}

function render(plugin: LoadedPlugin): { headings: string[]; rows: obsidian.Setting[] } {
  obsidian.settings.length = 0;
  const groups = plugin.settingTab.getSettingDefinitions();
  for (const g of groups) for (const it of g.items) it.render(new obsidian.Setting());
  return { headings: groups.map((g) => g.heading), rows: obsidian.settings.filter((s) => !s.hidden) };
}

test("main.js: WASM и переводы сжаты — сборка заметно меньше сырого WASM с 140 словарями", () => {
  const wasm = readFileSync(join(ROOT, "core/plugin/pkg/selfsync_wasm_bg.wasm")).length;
  const size = readFileSync(MAIN).length;
  // Без сжатия: WASM в base64 (×1,33) плюс ~3,3 МБ словарей — больше 5 МБ.
  assert.ok(size < wasm * 2, `main.js ${size} байт, WASM ${wasm}`);
});

test("main.js: ядро из core/, шифрование обязательно, свои команды", async () => {
  const plugin = await load(null);
  try {
    const core = plugin.core();
    const manifest = JSON.parse(readFileSync(join(ROOT, "core/manifest.json"), "utf8")) as { version: string };
    assert.equal(core.version, manifest.version);
    assert.ok(core.protocol >= 1);
    const cfg = plugin.engineConfig();
    assert.equal(cfg.requireEncryption, true);
    // Сервис намеренно на младшей минорной версии протокола: «обновите сервер» не показывать.
    assert.equal(cfg.serverMinorWarn, null);
    // Журнал синка ядра (sync.log) лежит в каталоге плагина: в синк он не попадает.
    assert.ok((cfg.hardExcludes as string[]).some((p) => p.endsWith("/plugins/selfsync-cloud/")), JSON.stringify(cfg.hardExcludes));
    assert.equal(cfg.client, "cloud/0.2.0");
    const ids = plugin.commands.map((c) => c.id);
    assert.ok(ids.includes("account") && ids.includes("invite") && ids.includes("phrase"), ids.join(", "));
    assert.ok(ids.includes("log"), ids.join(", "));
    // Ссылки подключения self-hosted сервера здесь нет.
    assert.ok(!ids.includes("connect"));
    // Без подключения синк не запущен.
    assert.equal(plugin.runner, undefined);
    assert.equal(plugin.settings.region, "offline");
    // styles.css — общие окна ядра и окна облака.
    const css = readFileSync(join(dirname(MAIN), "styles.css"), "utf8");
    assert.ok(css.includes(".selfsync-qr") && css.includes(".selfsync-cloud-phrase"));
  } finally {
    plugin.onunload();
  }
});

test("main.js: настройки без аккаунта — начать или войти; затем синк и версия ядра", async () => {
  const plugin = await load(null);
  try {
    const { headings, rows } = render(plugin);
    assert.equal(headings[0], "Аккаунт");
    assert.ok(headings.includes("О плагине"));
    // Разделы синхронизации открытого плагина на месте, подключения к своему серверу — нет.
    assert.ok(headings.includes("Синхронизация"), headings.join(", "));
    assert.ok(!headings.includes("Подключение"), headings.join(", "));
    const buttons = rows.flatMap((r) => r.buttons);
    for (const b of ["Начать синхронизацию", "Войти"]) assert.ok(buttons.includes(b), buttons.join(", "));
    // Регистрации по email больше нет: аккаунт создаётся одним нажатием.
    assert.ok(!buttons.includes("Зарегистрироваться"), buttons.join(", "));
    // Имя устройства — в конфликтных копиях и списке устройств аккаунта.
    assert.ok(rows.some((r) => r.name === "Имя устройства"), rows.map((r) => r.name).join(" | "));
  } finally {
    plugin.onunload();
  }
});

test("main.js: устройство по приглашению без сессии — только вход", async () => {
  // Без токена синк не запускается: проверяется только отрисовка.
  const plugin = await load({ vault: "c-x", vaultLabel: "Notes" }, { "selfsync-cloud-account-key": "a2V5" });
  try {
    const { rows } = render(plugin);
    const intro = rows.find((r) => r.desc.includes("«Notes»"));
    assert.ok(intro, rows.map((r) => r.desc).join(" | "));
    assert.deepEqual(intro.buttons, ["Войти"]);
    assert.ok(rows.some((r) => r.name === "«Notes»" && r.buttons.includes("Подключить устройство")));
    // Отключение — своей строкой: три кнопки в одной сжимали описание vault'а до буквы.
    assert.ok(rows.some((r) => r.name === "Отключить это устройство" && r.buttons.includes("Отключить")));
    assert.ok(!rows.some((r) => r.name === "«Notes»" && r.buttons.includes("Отключить")));
  } finally {
    plugin.onunload();
  }
});

test("main.js: сессия есть, а аккаунт не загрузился — не предлагать регистрацию", async () => {
  const plugin = await load({ session: "cs_x", email: "a@example.com" });
  try {
    const { rows } = render(plugin);
    const row = rows.find((r) => r.name === "a@example.com");
    assert.ok(row, rows.map((r) => r.name).join(" | "));
    assert.ok(row.desc.includes("не загрузился"), row.desc);
    assert.deepEqual(row.buttons, ["Повторить", "Выйти"]);
    const buttons = rows.flatMap((r) => r.buttons);
    assert.ok(!buttons.includes("Начать синхронизацию"), buttons.join(", "));
  } finally {
    plugin.onunload();
  }
});

test("main.js: аккаунт без email — номер вместо адреса, фраза ещё здесь: показать", async () => {
  // Слова фразы лежат в localStorage до отметки «записал».
  const words = JSON.stringify({ version: 1, words: Array.from({ length: 24 }, () => "abandon") });
  const plugin = await load({ session: "cs_x", accountId: 42 }, { "selfsync-cloud-phrase": words });
  try {
    const { rows } = render(plugin);
    assert.ok(rows.some((r) => r.name === "Аккаунт #42"), rows.map((r) => r.name).join(" | "));
    const phrase = rows.find((r) => r.name === "Фраза восстановления");
    assert.ok(phrase, rows.map((r) => r.name).join(" | "));
    assert.ok(phrase.desc.includes("не записана"), phrase.desc);
    assert.deepEqual(phrase.buttons, ["Показать"]);
    // Строка состояния напоминает.
    const bar = (plugin as unknown as { statusBar: { text: string } }).statusBar;
    assert.ok(bar.text.includes("фраза"), bar.text);
  } finally {
    plugin.onunload();
  }
});

test("main.js: ссылки 0.2.x с ключом и приглашения 0.1.x — только сообщение, без запросов", async () => {
  const dir = await fsp.mkdtemp(join(tmpdir(), "selfsync-cloud-"));
  const req = Module.createRequire(import.meta.url);
  const Main = (req(MAIN) as { default: new (app: unknown, manifest: unknown) => LoadedPlugin }).default;
  const plugin = new Main(obsidian.stubApp(dir, { region: "offline" }), { id: "selfsync-cloud", version: "0.3.0" });
  const handlers = new Map<string, (p: Record<string, string>) => void>();
  Object.assign(plugin, { registerObsidianProtocolHandler: (a: string, cb: (p: Record<string, string>) => void) => handlers.set(a, cb) });
  const requests: unknown[] = [];
  Object.assign(plugin, { cloud: Object.assign((plugin as unknown as { cloud: object }).cloud, { redeemAccount: (...a: unknown[]) => requests.push(a) }) });
  await plugin.onload();
  try {
    obsidian.shown.length = 0;
    handlers.get("selfsync-cloud-login")?.({ s: "https://cis.selfsync.cloud", c: "ABCDEFGHIJKLMNOP", k: "a2V5", v: "c-1" });
    assert.match(obsidian.shown[0] ?? "", /старой версии плагина/);
    handlers.get("selfsync-cloud-invite")?.({ s: "https://cis.selfsync.cloud", c: "ABCDEFGH", k: "pw" });
    assert.match(obsidian.shown[1] ?? "", /Устаревшая ссылка-приглашение/);
    assert.equal(obsidian.shown.length, 2);
    assert.deepEqual(requests, []);
  } finally {
    plugin.onunload();
  }
});

test("main.js: ключа аккаунта на устройстве нет — «Подключить устройство» не предлагается", async () => {
  const plugin = await load({ vault: "c-x", vaultLabel: "Notes", token: "", session: "cs_x" });
  try {
    const { rows } = render(plugin);
    const row = rows.find((r) => r.name === "«Notes»");
    assert.ok(row, rows.map((r) => r.name).join(" | "));
    assert.ok(!row.buttons.includes("Подключить устройство"), row.buttons.join(", "));
    assert.match(row.desc, /нет ключа аккаунта — на новом устройстве войдите фразой восстановления/);
    assert.ok(!plugin.commands.some((c) => c.id === "invite" && (c as { checkCallback?: (x: boolean) => boolean }).checkCallback?.(true)));
  } finally {
    plugin.onunload();
  }
});

/** Сервис на localhost: считает запросы, отвечает данными аккаунта #7.
 *  `delayMs` — ответ на `/account` медленный. */
async function fakeService(delayMs = 0): Promise<{ url: string; account: () => number; total: () => number; close: () => void }> {
  let account = 0;
  let total = 0;
  const tariff = { id: 1, code: "free", title: "Free", price: "0", status: "active", vaults: 1, bytes_soft: 0, bytes_hard: 1 << 30, devices: 3, max_file: 1 << 20 };
  const view = {
    id: 7, email: "a@example.com", created_at: 0, tariff, usage: { bytes: 0, vaults: 0, devices: 0 },
    vaults: [], devices: [], sessions: [], has_password: true, has_key_auth: false,
    phrase_version: 1, phrase_confirmed: true, terms_version: "", recovery_wrapped: "", kdf: null, salt: null, wrapped_key: null,
  };
  const server = createServer((req, res) => {
    total++;
    if (req.url === "/cloud/v1/account") {
      account++;
      setTimeout(() => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(view)), delayMs);
      return;
    }
    res.writeHead(503).end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    account: () => account,
    total: () => total,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

/** Вкладка настроек через заглушку ядра: она ведёт себя как Obsidian 1.13+ — addSettingTab()
 *  вызывает update(), update() перерисовывает только открытую вкладку, а открытие рисует
 *  сохранённые строки, не вызывая getSettingDefinitions(). */
function tabOf(plugin: unknown): { open(): obsidian.Setting[]; close(): void; rows(): obsidian.Setting[] } {
  const tab = (plugin as { settingTab: obsidian.PluginSettingTab }).settingTab;
  const rows = (): obsidian.Setting[] => tab.rendered.filter((s) => !s.hidden && s.name !== "");
  return {
    open: () => {
      tab.open();
      return rows();
    },
    close: () => tab.close(),
    rows,
  };
}

const waitFor = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
};
const accountDesc = (rows: obsidian.Setting[]): string => rows.find((r) => r.name === "a@example.com")?.desc ?? "";

test("main.js: аккаунт дочитан при закрытых настройках — при открытии виден тариф", async () => {
  const svc = await fakeService();
  const plugin = await load({ session: "cs_x", email: "a@example.com", serviceUrl: svc.url });
  const tabs = tabOf(plugin);
  try {
    await waitFor(() => svc.account() === 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.match(accountDesc(tabs.open()), /Free/);
    assert.equal(svc.account(), 1);
  } finally {
    plugin.onunload();
    svc.close();
  }
});

test("main.js: настройки открыты во время загрузки — перерисованы, ровно один /account", async () => {
  const svc = await fakeService();
  const plugin = await load({ session: "cs_x", email: "a@example.com", serviceUrl: svc.url });
  const tabs = tabOf(plugin);
  try {
    assert.equal(accountDesc(tabs.open()), "Загружаю аккаунт…");
    await waitFor(() => /Free/.test(accountDesc(tabs.rows())));
    assert.match(accountDesc(tabs.rows()), /Free/);
    // Перерисовка не запускает новую загрузку: один запрос, а не цикл.
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(svc.account(), 1);
  } finally {
    plugin.onunload();
    svc.close();
  }
});

test("main.js: данные устарели — открытие вкладки перечитывает аккаунт, события синка — нет", async () => {
  const svc = await fakeService();
  const plugin = await load({ session: "cs_x", email: "a@example.com", serviceUrl: svc.url });
  const tabs = tabOf(plugin);
  try {
    await waitFor(() => svc.account() === 1);
    await new Promise((r) => setTimeout(r, 50));
    const tab = plugin.settingTab as unknown as { loadedAt: number; refresh(): void };
    tab.loadedAt = 1;
    // Настройки закрыты: перерисовка по событию сеть не трогает.
    tab.refresh();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(svc.account(), 1);
    tabs.open();
    await waitFor(() => svc.account() === 2);
    assert.equal(svc.account(), 2);
    await new Promise((r) => setTimeout(r, 100));
    assert.match(accountDesc(tabs.rows()), /Free/);
    tabs.close();
  } finally {
    plugin.onunload();
    svc.close();
  }
});

test("main.js: без сессии запуск не ходит в сеть; тарифы — при открытии вкладки", async () => {
  const svc = await fakeService();
  const plugin = await load({ serviceUrl: svc.url });
  const tabs = tabOf(plugin);
  try {
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(svc.total(), 0);
    tabs.open();
    await waitFor(() => svc.total() > 0);
    // Без сессии /account не нужен: только тарифы региона.
    assert.equal(svc.account(), 0);
    tabs.close();
  } finally {
    plugin.onunload();
    svc.close();
  }
});

test("main.js: «перечитать» во время загрузки не теряется — второй /account после первого", async () => {
  const svc = await fakeService(150);
  const plugin = await load({ session: "cs_x", email: "a@example.com", serviceUrl: svc.url });
  const tabs = tabOf(plugin);
  try {
    await waitFor(() => svc.account() === 1);
    // Первый ответ ещё в пути, а действие уже просит перечитать.
    (plugin as unknown as { accountChanged(): void }).accountChanged();
    await waitFor(() => svc.account() === 2);
    assert.equal(svc.account(), 2);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(svc.account(), 2);
    assert.match(accountDesc(tabs.open()), /Free/);
    tabs.close();
  } finally {
    plugin.onunload();
    svc.close();
  }
});

test("main.js: ключ на устройстве есть, а vault не подключился — ошибка и окно пароля, а не тишина", async () => {
  const plugin = await load({ session: "cs_x", pendingVault: "c-1" });
  const opened: unknown[] = [];
  const open = obsidian.Modal.prototype.open;
  obsidian.Modal.prototype.open = function (this: unknown) {
    opened.push(this);
  };
  try {
    const p = plugin as unknown as { askPassword(): void; cloud: { unlock(): Promise<boolean> } };
    p.cloud.unlock = () => Promise.reject(new Error("network down"));
    obsidian.shown.length = 0;
    p.askPassword();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(obsidian.shown.some((m) => m.includes("network down")), obsidian.shown.join(" | "));
    assert.equal(opened.length, 1);
    // В следующий раз снова пробуется ключ с устройства, а не сразу пароль.
    p.cloud.unlock = () => Promise.resolve(true);
    p.askPassword();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(opened.length, 1);
  } finally {
    obsidian.Modal.prototype.open = open;
    plugin.onunload();
  }
});

test("main.js: выгрузка плагина закрывает открытые окна обмена", async () => {
  const plugin = await load(null);
  const closed: string[] = [];
  const modals = (plugin as unknown as { modals: Set<{ close(): void }> }).modals;
  modals.add({ close: () => closed.push("invite") });
  modals.add({ close: () => closed.push("handoff") });
  plugin.onunload();
  assert.deepEqual(closed, ["invite", "handoff"]);
  assert.equal(modals.size, 0);
});
