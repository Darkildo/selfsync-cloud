// Строки облачной части плагина. Язык — как у Obsidian (getLanguage()), выбор —
// как в ядре: точный код, затем базовый язык, иначе en; нет строки в переводе —
// английская. Общие окна и уведомления переводит ядро (core/plugin/src/i18n/),
// язык у обоих выставляется вместе (setLanguage).

// ext-pure.ts, а не ext.ts: модуль грузится и вне Obsidian (тесты, Node), а ext.ts тянет main.ts → obsidian.
import { setLanguage as setCoreLanguage } from "../../core/plugin/src/ext-pure.ts";
import { type Dict, en, type Key } from "./en.ts";
import { LOCALES } from "./locales.ts";

export type { Key };

/** Коды, которые отдаёт moment.locale() или пишут по-другому, → код Obsidian. */
const ALIASES: Record<string, string> = {
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-sg": "zh",
  "zh-hant": "zh-tw",
  "zh-hk": "zh-tw",
  "zh-mo": "zh-tw",
  nb: "no",
};

/** Языки с письмом справа налево: параметры в строках изолируются (коды, адреса, имена). */
const RTL = new Set(["ar", "dv", "fa", "he", "ur"]);

let lang = "en";
let locale = "en";
let dict: Dict = en;

function known(code: string): string | null {
  const c = ALIASES[code] ?? code;
  return c === "en" || Object.hasOwn(LOCALES, c) ? c : null;
}

/** Код словаря для языка Obsidian: точный код, затем базовый язык, иначе en. */
export function resolveLanguage(code: string): string {
  const c = code.trim().toLowerCase().replace(/_/g, "-");
  return known(c) ?? known(c.split("-")[0] ?? "") ?? "en";
}

export function setLanguage(code: string): void {
  lang = resolveLanguage(code);
  locale = code.trim().replace(/_/g, "-") || "en";
  dict = lang === "en" ? en : (LOCALES[lang] ?? en);
  setCoreLanguage(code);
}

/** Текущий язык словаря (код из реестра или en). */
export function language(): string {
  return lang;
}

export function t(key: Key, params: Record<string, string | number> = {}): string {
  const s = dict[key] ?? en[key];
  const rtl = RTL.has(lang);
  return s.replace(/\{(\w+)\}/g, (m, k: string) => {
    if (!(k in params)) return m;
    // U+2068…U+2069: код, адрес или имя в арабской строке не переставляется по частям.
    return rtl ? `\u2068${String(params[k])}\u2069` : String(params[k]);
  });
}

function formatWith(ms: number, opts: Intl.DateTimeFormatOptions): string {
  try {
    return new Intl.DateTimeFormat(locale, opts).format(ms);
  } catch {
    return new Intl.DateTimeFormat(undefined, opts).format(ms);
  }
}

/** Дата и время в формате языка Obsidian. */
export function formatDateTime(ms: number): string {
  return formatWith(ms, { dateStyle: "short", timeStyle: "medium" });
}

/** Только время, в формате языка Obsidian. */
export function formatTime(ms: number): string {
  return formatWith(ms, { timeStyle: "short" });
}

/** Только дата, в формате языка Obsidian. */
export function formatDate(ms: number): string {
  return formatWith(ms, { dateStyle: "short" });
}

/** Текст ошибки сервиса: известные коды — по-человечески. */
export function errorText(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  const known: Partial<Record<string, Key>> = {
    bad_credentials: "auth.badCredentials",
    bad_key: "auth.badCredentials",
    email_taken: "auth.emailTaken",
    account_blocked: "auth.blocked",
    registration_closed: "auth.closed",
    rate_limited: "auth.rateLimited",
    code_invalid: "code.invalid",
    bad_kdf: "error.badKdf",
    bad_recovery: "recover.wrong",
    // Без отдельного «нет такого аккаунта»: не подсказывать, какие адреса заняты.
    account_not_found: "auth.badCredentials",
    bad_email: "auth.badEmail",
    email_domain_blocked: "auth.badEmail",
    device_limit: "devices.limit",
    vault_limit: "vault.limitReached",
    no_account: "auth.needSignIn",
    no_account_key: "auth.needSignIn",
    no_password: "auth.noPassword",
    has_email: "auth.hasEmail",
    client_outdated: "error.outdated",
    handoff_mismatch: "handoff.pinMismatch",
  };
  const k = code ? known[code] : undefined;
  if (k) return t(k);
  const msg = e instanceof Error ? e.message : String(e);
  // В сообщении — адрес из ссылки.
  if (code === "untrusted_server") return t("code.untrusted", { server: msg });
  if (/ERR_|ECONN|net::|Failed to fetch|timed out/i.test(msg)) return t("auth.offline");
  return t("error.generic", { message: msg });
}
