// Сборка плагина: src/main.ts → main.js (CommonJS, как ждёт Obsidian). Ядро и общий
// код плагина берутся из core/ (открытый selfsync на выпущенном теге, см. scripts/core.sh),
// WASM встраивается байтами прямо в main.js.
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import esbuild from "esbuild";

const production = process.argv[2] === "production";
// Версия ядра — из манифеста подмодуля: в настройках видно, из какого тега собран плагин.
const coreVersion = JSON.parse(readFileSync("core/manifest.json", "utf8")).version;

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  outfile: "main.js",
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  loader: { ".wasm": "binary" },
  alias: { "selfsync-wasm-bytes": "./core/plugin/pkg/selfsync_wasm_bg.wasm" },
  define: { __CORE_VERSION__: JSON.stringify(coreVersion) },
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  logLevel: "info",
  // import.meta.url есть только в асинхронной загрузке обвязки wasm-bindgen, а мы
  // инициализируем WASM синхронно из встроенных байтов.
  logOverride: { "empty-import-meta": "silent" },
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
