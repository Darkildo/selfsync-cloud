// Собранный main.js целиком (WASM встроен) на заглушке Obsidian из core/: плагин
// загружается, ядро инициализировано, вкладка настроек рисуется.

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
});

interface LoadedPlugin {
  onload(): Promise<void>;
  settings: { email: string };
  settingTab: {
    containerEl: { empty?: () => void };
    display(): void;
    getSettingDefinitions(): { heading: string; items: { render(s: unknown): unknown }[] }[];
  };
  core(): { version: string; protocol: number };
}

async function load(data: unknown): Promise<LoadedPlugin> {
  const dir = await fsp.mkdtemp(join(tmpdir(), "selfsync-cloud-"));
  const req = Module.createRequire(import.meta.url);
  const Main = (req(join(ROOT, "main.js")) as { default: new (app: unknown, manifest: unknown) => LoadedPlugin }).default;
  const plugin = new Main(obsidian.stubApp(dir, data), { id: "selfsync-cloud" });
  await plugin.onload();
  return plugin;
}

test("main.js: ядро из core/ загружено, версия — из манифеста подмодуля", async () => {
  const plugin = await load(null);
  const core = plugin.core();
  const manifest = JSON.parse(readFileSync(join(ROOT, "core/manifest.json"), "utf8")) as { version: string };
  assert.equal(core.version, manifest.version);
  assert.ok(core.protocol >= 1, `протокол ${core.protocol}`);
  assert.equal(plugin.settings.email, "");
});

test("main.js: вкладка настроек — раздел аккаунта и версия ядра, оба способа отрисовки", async () => {
  const plugin = await load({ email: "a@example.com" });
  assert.equal(plugin.settings.email, "a@example.com");
  obsidian.settings.length = 0;
  const groups = plugin.settingTab.getSettingDefinitions();
  assert.deepEqual(
    groups.map((g) => g.heading),
    ["Аккаунт", "О плагине"],
  );
  for (const g of groups) for (const it of g.items) it.render(new obsidian.Setting());
  const core = obsidian.settings.find((s) => s.name === "Ядро синхронизации");
  assert.ok(core?.desc.startsWith(`selfsync ${plugin.core().version}, протокол `), String(core?.desc));
  // Obsidian до 1.13 рисует те же строки через display().
  obsidian.settings.length = 0;
  plugin.settingTab.containerEl.empty = () => {};
  plugin.settingTab.display();
  assert.deepEqual(
    obsidian.settings.map((s) => s.name),
    ["Аккаунт", "", "О плагине", "Ядро синхронизации"],
  );
});
