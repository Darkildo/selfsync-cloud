// Строки облачной части плагина. Общие окна и уведомления ядра переводит
// core/plugin/src/i18n.ts, язык у обоих выставляется вместе (setLanguage).

import { setLanguage as setCoreLanguage } from "../core/plugin/src/i18n.ts";

const en = {
  "settings.account": "Account",
  "settings.soon": "Sign up and sign in will appear here once the Selfsync Cloud service opens.",
  "settings.about": "About",
  "settings.core": "Sync core",
  "settings.coreDesc": "selfsync {version}, protocol {protocol}",
};

type Key = keyof typeof en;

const ru: Record<Key, string> = {
  "settings.account": "Аккаунт",
  "settings.soon": "Регистрация и вход появятся здесь, когда откроется сервис Selfsync Cloud.",
  "settings.about": "О плагине",
  "settings.core": "Ядро синхронизации",
  "settings.coreDesc": "selfsync {version}, протокол {protocol}",
};

let lang: "ru" | "en" = "en";

export function setLanguage(locale: string): void {
  lang = locale.toLowerCase().startsWith("ru") ? "ru" : "en";
  setCoreLanguage(locale);
}

export function t(key: Key, params: Record<string, string | number> = {}): string {
  const s = (lang === "ru" ? ru : en)[key];
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}
