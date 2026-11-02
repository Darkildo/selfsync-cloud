# Translating Selfsync Cloud

The plugin shows its interface in the language of the Obsidian app. Translations other than English and Russian were **machine-translated** and have not been reviewed by native speakers yet. Corrections are very welcome: open a pull request that changes the file for your language.

Two sets of strings make up the interface:

- **Cloud screens** (account, sign-in, recovery phrase, plans, connecting devices) — this folder, `src/i18n/`.
- **Shared sync windows** (status bar, conflicts, history, trash, connection check) — the open selfsync plugin, copied into `core/`. Translate those in the [selfsync repository](https://github.com/Darkildo/selfsync) (`plugin/src/i18n/`); `core/` here is a byte-identical copy of a selfsync release and is never edited by hand.

## Files

- `en.ts` — the source strings. Every key and every `{parameter}` comes from here.
- `ru.ts` — Russian, maintained by the authors; a useful second reference.
- `<code>.ts` — one file per language, e.g. `de.ts`, `zh-tw.ts`, `pt-br.ts`. The codes are the Obsidian language codes listed in `core/plugin/src/i18n/LANGUAGES.md`.
- `locales.ts` — the registry. A language is used only after it is added there.
- `index.ts` — language selection and helpers. Translators do not need to touch it.

If a key is missing in a translation, the English string is shown.

## File format

```ts
// German (Deutsch). Machine translation; corrections welcome via pull request.

import type { Dict } from "./en.ts";

const de: Dict = {
  "settings.account": "Konto",
  // … the same keys as in en.ts, in the same order
};

export default de;
```

For codes with a dash, name the variable in camel case: `ptBr`, `zhTw`, `nanTw`. Register the language in `locales.ts` (imports and entries in alphabetical order): `import de from "./de.ts";` and `de,` or `"pt-br": ptBr,`.

## Rules

- Use the glossary and style of the selfsync translation (`core/plugin/src/i18n/TRANSLATING.md`), so both plugins use the same words for vault, device, encryption password, account key, recovery phrase and verification digits.
- Do not translate: **Selfsync Cloud**, **selfsync**, error codes, region and plan identifiers, URLs, and `{parameters}` — keep every `{parameter}` of the English string, in any position the sentence needs.
- Strings about passing the account key to another device (`handoff.*`, `invite.*`, the recovery phrase) are about security: translate them completely and precisely, without shortening.

## Checking

```sh
npm run i18n:check -- de      # one file, even before it is registered
npm run i18n:check            # every language file, with coverage
npm test                      # the same rules for every registered language
npm run typecheck             # an unknown key is also a type error
```
