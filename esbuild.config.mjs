// Сборка плагина: src/main.ts → main.js (CommonJS, как ждёт Obsidian). Ядро и общий
// код плагина берутся из core/ (открытый selfsync на выпущенном теге, см. scripts/core.sh).
// WASM и переводы ядра и облака встраиваются в main.js сжатыми — плагином сборки ядра
// (core/plugin/src/build/pack.mjs): при старте распаковывается только язык Obsidian.
// styles.css — стили общих окон из core/ и окон облака.
import { readFileSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import esbuild from "esbuild";
import { pack } from "./core/plugin/src/build/pack.mjs";

const production = process.argv[2] === "production";
// Тесты собирают каждый в свой каталог: параллельные файлы тестов не читают
// main.js, пока другой его переписывает. styles.css — рядом с main.js.
const outfile = process.env.SELFSYNC_CLOUD_OUT || "main.js";
// Версия ядра — из манифеста подмодуля: в настройках видно, из какого тега собран плагин.
const coreVersion = JSON.parse(readFileSync("core/manifest.json", "utf8")).version;

function writeStyles() {
  writeFileSync(join(dirname(outfile), "styles.css"), readFileSync("core/plugin/styles.css", "utf8") + "\n" + readFileSync("src/styles.css", "utf8"));
}

const ctx = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  format: "cjs",
  target: "es2022",
  platform: "browser",
  outfile,
  external: ["obsidian", "electron", ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  define: { __CORE_VERSION__: JSON.stringify(coreVersion) },
  sourcemap: production ? false : "inline",
  minify: production,
  // Переводы на 70+ языков: без utf8 esbuild пишет не-ASCII как \uXXXX, и main.js
  // вырастает примерно в полтора раза.
  charset: "utf8",
  treeShaking: true,
  logLevel: "info",
  // import.meta.url есть только в асинхронной загрузке обвязки wasm-bindgen, а мы
  // инициализируем WASM синхронно из встроенных байтов.
  logOverride: { "empty-import-meta": "silent" },
  plugins: [
    // en — эталон, ru — второй основной язык: они не сжимаются.
    pack({
      wasm: "core/plugin/pkg/selfsync_wasm_bg.wasm",
      locales: [
        { registry: "core/plugin/src/i18n/locales.ts", keep: ["ru"] },
        { registry: "src/i18n/locales.ts", keep: ["ru"] },
      ],
    }),
    { name: "styles", setup: (b) => b.onEnd(writeStyles) },
  ],
});

if (production) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
