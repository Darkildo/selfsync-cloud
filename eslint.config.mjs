// Тот же набор правил, которым каталог плагинов Obsidian проверяет релизы.
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  // core/ — открытый selfsync, его проверяет собственный CI; тесты — код для Node.
  { ignores: ["main.js", "core/", "node_modules/", "test/"] },
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.mjs", "esbuild.config.mjs"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  // Подставляет esbuild (define), объявлено в src/globals.d.ts.
  { files: ["src/**/*.ts"], languageOptions: { globals: { __CORE_VERSION__: "readonly" } } },
  // Сборка работает в Node, а не в Obsidian.
  {
    files: ["*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
    rules: { "obsidianmd/no-nodejs-modules": "off", "no-restricted-globals": "off", "import/no-nodejs-modules": "off" },
  },
]);
