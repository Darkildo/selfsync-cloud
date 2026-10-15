// Регионы сервиса. Данные регионов не пересекаются: аккаунт живёт в том регионе,
// где зарегистрирован. Вход — VPS региона, он только пересылает TCP; TLS (IP-
// сертификат Let's Encrypt) и данные — на серверах сервиса. Для проверки другого
// сервера адрес можно указать в настройках («Адрес сервиса»).

export const REGIONS = ["cis", "eu"] as const;
export type Region = (typeof REGIONS)[number];

const URLS: Record<Region, string> = {
  cis: "https://87.249.49.6:7443",
  eu: "https://103.102.229.144:7443",
};

/** Регион по умолчанию — по языку Obsidian: русский и языки СНГ — СНГ, иначе Europe. */
export function defaultRegion(locale: string): Region {
  return /^(ru|uk|be|kk|ky|uz|tg|hy|az|ka|ro-md)/i.test(locale) ? "cis" : "eu";
}

export function regionUrl(region: string): string {
  return URLS[region as Region] ?? "";
}
