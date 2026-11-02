// Сборка со сжатыми WASM и переводами (pack() ядра, как в esbuild.config.mjs):
// переводы ядра и облака те же, что в исходниках, а распаковывается только язык,
// выбранный в Obsidian.

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import esbuild from "esbuild";

import { pack } from "../core/plugin/src/build/pack.mjs";
import { LOCALES as CORE_SOURCE } from "../core/plugin/src/i18n/locales.ts";
import { LOCALES as SOURCE } from "../src/i18n/locales.ts";

const DIR = fileURLToPath(new URL("..", import.meta.url));

type Locales = Record<string, Record<string, string>>;

interface Bundle {
  LOCALES: Locales;
  CORE_LOCALES: Locales;
  setLanguage(code: string): void;
  t(key: string): string;
  coreT(key: string): string;
}

async function bundle(): Promise<Bundle> {
  const out = await esbuild.build({
    stdin: {
      contents: `
        export { setLanguage, t } from "./src/i18n.ts";
        export { t as coreT } from "./core/plugin/src/i18n.ts";
        export { LOCALES } from "./src/i18n/locales.ts";
        export { LOCALES as CORE_LOCALES } from "./core/plugin/src/i18n/locales.ts";`,
      resolveDir: DIR,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    write: false,
    logLevel: "error",
    plugins: [
      pack({
        locales: [
          { registry: `${DIR}core/plugin/src/i18n/locales.ts`, keep: ["ru"] },
          { registry: `${DIR}src/i18n/locales.ts`, keep: ["ru"] },
        ],
      }),
    ],
  });
  const code = out.outputFiles[0]!.text;
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as Bundle;
}

const unpacked = (locales: Locales) =>
  Object.keys(locales)
    .filter((c) => "value" in Object.getOwnPropertyDescriptor(locales, c)!)
    .sort();

test("сборка: распакован только выбранный язык — и у облака, и у ядра", async () => {
  const mod = await bundle();
  assert.deepEqual(Object.keys(mod.LOCALES).sort(), Object.keys(SOURCE).sort(), "те же языки облака");
  assert.deepEqual(Object.keys(mod.CORE_LOCALES).sort(), Object.keys(CORE_SOURCE).sort(), "те же языки ядра");
  assert.deepEqual(unpacked(mod.LOCALES), ["ru"], "до выбора языка у облака распакован только ru");
  assert.deepEqual(unpacked(mod.CORE_LOCALES), ["ru"], "до выбора языка у ядра распакован только ru");

  mod.setLanguage("de");
  assert.equal(mod.t("settings.account"), SOURCE["de"]!["settings.account"]);
  assert.equal(mod.coreT("status.idle"), CORE_SOURCE["de"]!["status.idle"]);
  assert.deepEqual(unpacked(mod.LOCALES), ["de", "ru"], "после выбора у облака — ещё только de");
  assert.deepEqual(unpacked(mod.CORE_LOCALES), ["de", "ru"], "после выбора у ядра — ещё только de");
});

test("сборка: каждый сжатый словарь облака совпадает с исходным", async () => {
  const mod = await bundle();
  for (const [code, dict] of Object.entries(SOURCE)) {
    assert.deepEqual({ ...mod.LOCALES[code] }, { ...dict }, code);
  }
});
