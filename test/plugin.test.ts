// Собранный main.js целиком (WASM встроен) на заглушке Obsidian из core/: плагин
// загружается поверх открытого selfsync, вкладка настроек рисует облачные разделы.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fsp from "node:fs/promises";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";

import * as obsidian from "../core/plugin/test/obsidian-stub.ts";

const ROOT = new URL("..", import.meta.url).pathname;

before(() => {
  const b = spawnSync("node", ["esbuild.config.mjs", "production"], { cwd: ROOT, encoding: "utf8" });
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
  const Main = (req(join(ROOT, "main.js")) as { default: new (app: unknown, manifest: unknown) => LoadedPlugin }).default;
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

test("main.js: ядро из core/, шифрование обязательно, свои команды", async () => {
  const plugin = await load(null);
  try {
    const core = plugin.core();
    const manifest = JSON.parse(readFileSync(join(ROOT, "core/manifest.json"), "utf8")) as { version: string };
    assert.equal(core.version, manifest.version);
    assert.ok(core.protocol >= 1);
    const cfg = plugin.engineConfig();
    assert.equal(cfg.requireEncryption, true);
    assert.equal(cfg.client, "cloud/0.2.0");
    const ids = plugin.commands.map((c) => c.id);
    assert.ok(ids.includes("account") && ids.includes("invite") && ids.includes("phrase"), ids.join(", "));
    // Ссылки подключения self-hosted сервера здесь нет.
    assert.ok(!ids.includes("connect"));
    // Без подключения синк не запущен.
    assert.equal(plugin.runner, undefined);
    assert.equal(plugin.settings.region, "offline");
    // styles.css — общие окна ядра и окна облака.
    const css = readFileSync(join(ROOT, "styles.css"), "utf8");
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
  const plugin = await load({ vault: "c-x", vaultLabel: "Notes" });
  try {
    const { rows } = render(plugin);
    const intro = rows.find((r) => r.desc.includes("«Notes»"));
    assert.ok(intro, rows.map((r) => r.desc).join(" | "));
    assert.deepEqual(intro.buttons, ["Войти"]);
    assert.ok(rows.some((r) => r.name === "«Notes»" && r.buttons.includes("Подключить устройство")));
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
