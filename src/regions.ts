// Регионы сервиса. Данные регионов не пересекаются: аккаунт живёт в том регионе,
// где зарегистрирован. Вход — VPS региона, он только пересылает TCP; TLS (IP-
// сертификат Let's Encrypt) и данные — на серверах сервиса. Для проверки другого
// сервера адрес можно указать в настройках («Адрес сервиса»).

export const REGIONS = ["ru", "intl"] as const;
export type Region = (typeof REGIONS)[number];

const URLS: Record<Region, string> = {
  ru: "https://87.249.49.6:7443",
  intl: "https://103.102.229.144:7443",
};

export function regionUrl(region: string): string {
  return URLS[region as Region] ?? "";
}
