// Регионы сервиса. Данные регионов не пересекаются: аккаунт живёт в том регионе,
// где зарегистрирован. Адреса появятся, когда регион откроется; до тех пор
// сервис можно проверить, указав адрес в настройках («Адрес сервиса»).

export const REGIONS = ["ru", "intl"] as const;
export type Region = (typeof REGIONS)[number];

const URLS: Record<Region, string> = {
  ru: "",
  intl: "",
};

export function regionUrl(region: string): string {
  return URLS[region as Region] ?? "";
}
