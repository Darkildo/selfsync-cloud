// Строки облачной части плагина. Общие окна и уведомления ядра переводит
// core/plugin/src/i18n.ts, язык у обоих выставляется вместе (setLanguage).

import { setLanguage as setCoreLanguage } from "../core/plugin/src/i18n.ts";

const en = {
  "settings.account": "Account",
  "settings.about": "About",
  "settings.core": "Sync core",
  "settings.coreDesc": "selfsync {version}, protocol {protocol}",
  "settings.vault": "Vault",
  "settings.devices": "Devices",
  "settings.tariffs": "Plans",
  "settings.deviceDesc": "Shown in conflict copies. The account device list gets it when the device connects to a vault.",

  "account.intro": "Sync this vault through Selfsync Cloud. Notes are encrypted on your devices: the service cannot read them. No email needed.",
  "account.register": "Sign up",
  "account.login": "Sign in",
  "account.haveCode": "I have an invite code",
  "account.invited": "This device is connected to “{label}” by invite. Sign in to manage the account.",
  "account.usage": "Plan {tariff}: {used} of {limit} used · vaults {vaults} · devices {devices}",
  "account.logout": "Sign out",
  "account.changePassword": "Change password",
  "account.oldPassword": "Current password",
  "account.newPassword": "New password",
  "account.passwordChanged": "Password changed. Other devices keep syncing; sign in again elsewhere.",
  "account.delete": "Delete account",
  "account.deleteDesc": "Deletes the account and every vault in it from the server. Notes on your devices stay.",
  "account.deleteConfirm": "Enter the password to delete the account with all data on the server. This cannot be undone.",
  "account.deleted": "Account deleted",
  "account.service": "Service address",
  "account.serviceDesc": "Leave empty to use the region address. Only for testing a server.",
  "account.notOpen": "The service is not open in this region yet.",
  "account.unlimited": "unlimited",
  "account.loading": "Loading the account…",
  "account.unavailable": "The account did not load: {error}",
  "account.retry": "Retry",

  "region.name": "Region",
  "region.cis": "CIS",
  "region.eu": "Europe",

  "auth.registerTitle": "Create a Selfsync Cloud account",
  "auth.loginTitle": "Sign in to Selfsync Cloud",
  "auth.email": "Email",
  "auth.password": "Password",
  "auth.passwordDesc": "One password for the account and the encryption. It never leaves this device.",
  "auth.confirm": "Repeat the password",
  "auth.mismatch": "The passwords do not match",
  "auth.weak": "The password is too weak: use at least 10 characters, better a phrase of several words",
  "auth.forgot": "Forgot the password?",
  "auth.working": "Deriving keys…",
  "auth.closed": "Sign-up is closed right now",
  "auth.badCredentials": "Wrong email or password",
  "auth.emailTaken": "An account with this email already exists",
  "auth.blocked": "The account is blocked",
  "auth.rateLimited": "Too many attempts, try again later",
  "auth.offline": "The service did not respond: check the connection",
  "auth.badEmail": "This email address is not accepted",
  "auth.needSignIn": "Sign in to the account on this device first",

  "phrase.title": "Recovery phrase",
  "phrase.desc": "These 24 words sign in to the account from any device and restore it if the password is forgotten or every device is lost. Write them down and keep them apart from the password. Without the phrase nobody (the service included) can restore your notes.",
  "phrase.copy": "Copy",
  "phrase.written": "I have written the phrase down",
  "phrase.done": "Done",

  "recover.title": "Restore access",
  "recover.desc": "Enter the email, the 24-word recovery phrase and a new password. Other devices will ask for the new password.",
  "recover.phrase": "Recovery phrase",
  "recover.submit": "Restore",
  "recover.wrong": "This phrase does not fit the account",
  "recover.done": "Access restored, the password is replaced",

  "vault.connected": "“{label}”",
  "vault.connectedDesc": "Encrypted, synced through Selfsync Cloud.",
  "vault.invite": "Connect a device",
  "vault.disconnect": "Disconnect this device",
  "vault.disconnectConfirm": "Disconnect this device from the vault? Files here stay, sync stops.",
  "vault.disconnectOffline": "The device could not be revoked on the service ({error}). Disconnect it only here? It stays in the account device list until you revoke it there.",
  "vault.pickTitle": "Choose a vault",
  "vault.pickDesc": "Connect this Obsidian vault to an existing vault of the account or create a new one.",
  "vault.connect": "Connect here",
  "vault.connectDesc": "{used} · created {date}",
  "vault.create": "Create a new vault",
  "vault.createDesc": "Files of this Obsidian vault are encrypted before the first upload.",
  "vault.limit": "Your plan allows {n} vault(s)",
  "vault.none": "The account has no vaults yet.",
  "vault.limitReached": "The plan allows no more vaults",
  "devices.limit": "The plan allows no more devices: revoke one in the settings",

  "invite.title": "Connect a device",
  "invite.desc": "Scan the code with the new device’s camera: it opens Obsidian and signs in at once. Or enter the text code there under “Enter a code”; it will then ask for {how}. Valid until {until}, once.",
  "invite.descNoKey": "Scan the code with the new device’s camera, or enter the text code there under “Enter a code”. Either way it will ask for {how}: the key is not on this device. Valid until {until}, once.",
  "invite.code": "Code: {code}",
  "invite.copy": "Copy the code",

  "code.title": "Connect by invite",
  "code.desc": "Enter the code from another device. Then enter the account password: it opens the encryption key.",
  "code.code": "Invite code",
  "code.submit": "Connect",
  "code.invalid": "The code is invalid or expired",
  "code.from": "Code {code} from {server}",
  "code.replaces": "This device syncs “{label}”. The invite connects it to another vault instead: files here stay and join that vault.",
  "code.untrusted": "The invite link points to an unknown server {server}. Selfsync Cloud connects only to its own regions or to the service address set in the settings.",

  "unlock.title": "Account password",
  "unlock.desc": "The vault is encrypted. Enter the account password to open the key on this device.",
  "unlock.submit": "Unlock",
  "unlock.wrong": "Wrong password",

  "devices.lastSeen": "{vault} · last seen {time}",
  "devices.current": "{name} (this device)",
  "devices.revoke": "Revoke",
  "devices.revokeConfirm": "Revoke “{name}”? It stops syncing and has to be invited again.",
  "devices.none": "No devices yet.",

  "tariff.current": "Your plan",
  "tariff.soon": "Soon",
  "tariff.limits": "{bytes} · vaults: {vaults} · devices: {devices} · file up to {file}",

  "start.title": "Selfsync Cloud",
  "cmd.account": "Account and sign in",
  "cmd.invite": "Connect a device",

  "settings.sessions": "Signed-in devices",

  "account.anonymous": "Account #{id}",
  "account.addEmail": "Add email and password",
  "account.deleteConfirmKey": "Delete the account with all data on the server? This cannot be undone. Notes on your devices stay.",

  "region.desc": "Where the account and the encrypted data are stored. Cannot be changed later.",

  "start.desc": "One press creates an account and encrypts this vault; no email or password needed. The recovery phrase appears in the settings: write it down soon, it is the only way back in.",
  "start.begin": "Start syncing",
  "start.terms": "By pressing Start you accept the",
  "start.termsLink": "terms of service",
  "start.haveAccount": "Already have an account?",
  "start.signIn": "Sign in",
  "start.done": "The vault is being encrypted and uploaded. Write down the recovery phrase: Settings → Selfsync Cloud.",
  "start.alreadySignedIn": "This device is already signed in: sign out first",

  "existing.title": "Sign in to an existing account",
  "existing.qr": "Easiest: on a connected device press “Connect a device” and scan the QR code with this device’s camera. The link opens Obsidian and signs in at once.",
  "existing.code": "Code from another device",
  "existing.codeDesc": "Type the code shown under the QR. Then the account password, or the recovery phrase if the account has no password.",
  "existing.codeButton": "Enter a code",
  "existing.phrase": "Recovery phrase",
  "existing.phraseDesc": "The 24 words sign in without any other device.",
  "existing.phraseButton": "Enter the phrase",
  "existing.password": "Email and password",
  "existing.passwordDesc": "If you added them to the account.",

  "phraseLogin.title": "Sign in with the recovery phrase",
  "phraseLogin.desc": "Enter the 24 words. The phrase opens the encryption key on this device; the service never sees it.",

  "loginCode.title": "Sign in with a code",
  "loginCode.desc": "Enter the code from “Connect a device” on another device. Without the QR, the key is opened by the account password or the recovery phrase.",
  "loginCode.code": "Code",

  "phrase.bar": "⚠ recovery phrase",
  "phrase.reminder": "Write down the recovery phrase: without it a lost device means lost notes. Click to show it.",
  "phrase.later": "Later",
  "phrase.show": "Show",
  "phrase.new": "Create a new phrase",
  "phrase.newConfirm": "Create a new recovery phrase? The old one stops working. Write the new one down at once.",
  "phrase.needKey": "The encryption key is not on this device: sign in with the QR code or the phrase first.",
  "phrase.statusConfirmed": "Written down. Keep it apart from the password: it is the only way back in if devices are lost.",
  "phrase.statusHere": "Not written down yet. Without it a lost device means lost notes.",
  "phrase.statusElsewhere": "Not written down. The words are on the device that created the account; or create a new phrase here.",

  "invite.phraseFirst": "The recovery phrase is not written down yet.",
  "invite.phraseShow": "Show it",
  "invite.codePassword": "the account password",
  "invite.codePhrase": "the recovery phrase",

  "sessions.lastSeen": "{client} · last seen {time}",
  "sessions.revoke": "Sign out",
  "sessions.logoutAll": "Sign out everywhere",
  "sessions.logoutAllDesc": "Closes every sign-in except this one. Devices keep syncing.",
  "sessions.logoutAllConfirm": "Sign out on all other devices?",

  "unlock.phraseDesc": "The vault is encrypted and the key is not on this device. The account has no password: sign in with the recovery phrase or scan the QR code from a connected device.",

  "email.title": "Add email and password",
  "email.desc": "Lets you sign in by typing them on any device and protects actions with the password. One password for the account and the encryption. It never leaves this device.",
  "email.submit": "Add",
  "email.done": "Email and password added",
  "auth.noPassword": "The account has no password: add one in the settings",
  "auth.hasEmail": "The account already has an email",

  "cmd.phrase": "Recovery phrase",
  "error.generic": "Error: {message}",
  "error.badKdf": "The service asked for unsafe password protection settings. Nothing was sent; update the plugin or contact support.",
};

type Key = keyof typeof en;

const ru: Record<Key, string> = {
  "settings.account": "Аккаунт",
  "settings.about": "О плагине",
  "settings.core": "Ядро синхронизации",
  "settings.coreDesc": "selfsync {version}, протокол {protocol}",
  "settings.vault": "Vault",
  "settings.devices": "Устройства",
  "settings.tariffs": "Тарифы",
  "settings.deviceDesc": "Видно в конфликтных копиях. В список устройств аккаунта попадает при подключении к vault'у.",

  "account.intro": "Синхронизация этого vault'а через Selfsync Cloud. Заметки шифруются на ваших устройствах: сервис не может их прочитать. Email не нужен.",
  "account.register": "Зарегистрироваться",
  "account.login": "Войти",
  "account.haveCode": "У меня есть код приглашения",
  "account.invited": "Устройство подключено к «{label}» по приглашению. Войдите, чтобы управлять аккаунтом.",
  "account.usage": "Тариф {tariff}: занято {used} из {limit} · vault'ов {vaults} · устройств {devices}",
  "account.logout": "Выйти",
  "account.changePassword": "Сменить пароль",
  "account.oldPassword": "Текущий пароль",
  "account.newPassword": "Новый пароль",
  "account.passwordChanged": "Пароль сменён. Другие устройства продолжают синхронизироваться; на них нужно войти заново.",
  "account.delete": "Удалить аккаунт",
  "account.deleteDesc": "Удаляет аккаунт и все его vault'ы с сервера. Заметки на устройствах остаются.",
  "account.deleteConfirm": "Введите пароль, чтобы удалить аккаунт со всеми данными на сервере. Это необратимо.",
  "account.deleted": "Аккаунт удалён",
  "account.service": "Адрес сервиса",
  "account.serviceDesc": "Пусто — адрес региона. Нужно только для проверки сервера.",
  "account.notOpen": "В этом регионе сервис ещё не открыт.",
  "account.unlimited": "без ограничения",
  "account.loading": "Загружаю аккаунт…",
  "account.unavailable": "Аккаунт не загрузился: {error}",
  "account.retry": "Повторить",

  "region.name": "Регион",
  "region.cis": "СНГ",
  "region.eu": "Europe",

  "auth.registerTitle": "Регистрация в Selfsync Cloud",
  "auth.loginTitle": "Вход в Selfsync Cloud",
  "auth.email": "Email",
  "auth.password": "Пароль",
  "auth.passwordDesc": "Один пароль для аккаунта и шифрования. С устройства он не уходит.",
  "auth.confirm": "Пароль ещё раз",
  "auth.mismatch": "Пароли не совпадают",
  "auth.weak": "Пароль слишком простой: не меньше 10 символов, лучше фраза из нескольких слов",
  "auth.forgot": "Забыли пароль?",
  "auth.working": "Вывожу ключи…",
  "auth.closed": "Регистрация сейчас закрыта",
  "auth.badCredentials": "Неверный email или пароль",
  "auth.emailTaken": "Аккаунт с таким email уже есть",
  "auth.blocked": "Аккаунт заблокирован",
  "auth.rateLimited": "Слишком много попыток, попробуйте позже",
  "auth.offline": "Сервис не ответил: проверьте соединение",
  "auth.badEmail": "Этот адрес почты не принимается",
  "auth.needSignIn": "Сначала войдите в аккаунт на этом устройстве",

  "phrase.title": "Фраза восстановления",
  "phrase.desc": "Эти 24 слова входят в аккаунт с любого устройства и возвращают его, если пароль забыт или все устройства потеряны. Запишите их и храните отдельно от пароля. Без фразы восстановить заметки не сможет никто, включая сервис.",
  "phrase.copy": "Скопировать",
  "phrase.written": "Я записал(а) фразу",
  "phrase.done": "Готово",

  "recover.title": "Восстановление доступа",
  "recover.desc": "Введите email, фразу восстановления из 24 слов и новый пароль. Другие устройства попросят новый пароль.",
  "recover.phrase": "Фраза восстановления",
  "recover.submit": "Восстановить",
  "recover.wrong": "Фраза не подходит к этому аккаунту",
  "recover.done": "Доступ восстановлен, пароль заменён",

  "vault.connected": "«{label}»",
  "vault.connectedDesc": "Зашифрован, синхронизируется через Selfsync Cloud.",
  "vault.invite": "Подключить устройство",
  "vault.disconnect": "Отключить это устройство",
  "vault.disconnectConfirm": "Отключить это устройство от vault'а? Файлы здесь останутся, синхронизация остановится.",
  "vault.disconnectOffline": "Не удалось отозвать устройство в сервисе ({error}). Отключить только здесь? Устройство останется в списке аккаунта, пока вы не отзовёте его там.",
  "vault.pickTitle": "Выбор vault'а",
  "vault.pickDesc": "Подключите этот vault Obsidian к существующему vault'у аккаунта или создайте новый.",
  "vault.connect": "Подключить сюда",
  "vault.connectDesc": "{used} · создан {date}",
  "vault.create": "Создать новый vault",
  "vault.createDesc": "Файлы этого vault'а Obsidian зашифруются до первой отправки.",
  "vault.limit": "Тариф позволяет vault'ов: {n}",
  "vault.none": "В аккаунте пока нет vault'ов.",
  "vault.limitReached": "Тариф не позволяет больше vault'ов",
  "devices.limit": "Тариф не позволяет больше устройств: отзовите одно в настройках",

  "invite.title": "Подключить устройство",
  "invite.desc": "Наведите камеру нового устройства на код: откроется Obsidian и сразу войдёт. Или введите текстовый код там в «Ввести код»; тогда оно спросит {how}. Действует до {until}, один раз.",
  "invite.descNoKey": "Наведите камеру нового устройства на код или введите текстовый код там в «Ввести код». В обоих случаях оно спросит {how}: ключа на этом устройстве нет. Действует до {until}, один раз.",
  "invite.code": "Код: {code}",
  "invite.copy": "Скопировать код",

  "code.title": "Подключение по приглашению",
  "code.desc": "Введите код с другого устройства. Затем — пароль аккаунта: он открывает ключ шифрования.",
  "code.code": "Код приглашения",
  "code.submit": "Подключить",
  "code.invalid": "Код неверный или истёк",
  "code.from": "Код {code} от {server}",
  "code.replaces": "Это устройство синхронизирует «{label}». Приглашение подключит его к другому vault'у: файлы здесь останутся и попадут в тот vault.",
  "code.untrusted": "Ссылка приглашения ведёт на неизвестный сервер {server}. Selfsync Cloud подключается только к своим регионам или к адресу сервиса из настроек.",

  "unlock.title": "Пароль аккаунта",
  "unlock.desc": "Vault зашифрован. Введите пароль аккаунта, чтобы открыть ключ на этом устройстве.",
  "unlock.submit": "Открыть",
  "unlock.wrong": "Неверный пароль",

  "devices.lastSeen": "{vault} · на связи {time}",
  "devices.current": "{name} (это устройство)",
  "devices.revoke": "Отозвать",
  "devices.revokeConfirm": "Отозвать «{name}»? Устройство перестанет синхронизироваться, подключить его можно будет только новым приглашением.",
  "devices.none": "Устройств пока нет.",

  "tariff.current": "Ваш тариф",
  "tariff.soon": "Скоро",
  "tariff.limits": "{bytes} · vault'ов: {vaults} · устройств: {devices} · файл до {file}",

  "start.title": "Selfsync Cloud",
  "cmd.account": "Аккаунт и вход",
  "cmd.invite": "Подключить устройство",

  "settings.sessions": "Входы в аккаунт",

  "account.anonymous": "Аккаунт #{id}",
  "account.addEmail": "Добавить email и пароль",
  "account.deleteConfirmKey": "Удалить аккаунт со всеми данными на сервере? Это необратимо. Заметки на устройствах останутся.",

  "region.desc": "Где хранятся аккаунт и зашифрованные данные. Потом не поменять.",

  "start.desc": "Одно нажатие создаёт аккаунт и шифрует этот vault; email и пароль не нужны. Фраза восстановления появится в настройках: запишите её поскорее, это единственный путь назад.",
  "start.begin": "Начать синхронизацию",
  "start.terms": "Нажимая «Начать», вы принимаете",
  "start.termsLink": "условия оферты",
  "start.haveAccount": "Уже есть аккаунт?",
  "start.signIn": "Войти",
  "start.done": "Vault шифруется и отправляется. Запишите фразу восстановления: Настройки → Selfsync Cloud.",
  "start.alreadySignedIn": "На этом устройстве уже выполнен вход: сначала выйдите",

  "existing.title": "Вход в существующий аккаунт",
  "existing.qr": "Проще всего: на подключённом устройстве нажмите «Подключить устройство» и отсканируйте QR-код камерой этого устройства. Ссылка откроет Obsidian и сразу войдёт.",
  "existing.code": "Код с другого устройства",
  "existing.codeDesc": "Введите код, показанный под QR. Затем пароль аккаунта, а если пароля нет — фразу восстановления.",
  "existing.codeButton": "Ввести код",
  "existing.phrase": "Фраза восстановления",
  "existing.phraseDesc": "24 слова входят без других устройств.",
  "existing.phraseButton": "Ввести фразу",
  "existing.password": "Email и пароль",
  "existing.passwordDesc": "Если вы добавили их в аккаунт.",

  "phraseLogin.title": "Вход по фразе восстановления",
  "phraseLogin.desc": "Введите 24 слова. Фраза открывает ключ шифрования на этом устройстве; сервис её не видит.",

  "loginCode.title": "Вход по коду",
  "loginCode.desc": "Введите код из «Подключить устройство» на другом устройстве. Без QR ключ откроет пароль аккаунта или фраза восстановления.",
  "loginCode.code": "Код",

  "phrase.bar": "⚠ фраза восстановления",
  "phrase.reminder": "Запишите фразу восстановления: без неё потеря устройства — потеря заметок. Нажмите, чтобы показать.",
  "phrase.later": "Позже",
  "phrase.show": "Показать",
  "phrase.new": "Создать новую фразу",
  "phrase.newConfirm": "Создать новую фразу восстановления? Прежняя перестанет действовать. Сразу запишите новую.",
  "phrase.needKey": "Ключа шифрования на этом устройстве нет: сначала войдите по QR или фразе.",
  "phrase.statusConfirmed": "Записана. Храните отдельно от пароля: это единственный путь назад, если устройства пропадут.",
  "phrase.statusHere": "Ещё не записана. Без неё потеря устройства — потеря заметок.",
  "phrase.statusElsewhere": "Не записана. Слова — на устройстве, создавшем аккаунт; или создайте новую фразу здесь.",

  "invite.phraseFirst": "Фраза восстановления ещё не записана.",
  "invite.phraseShow": "Показать",
  "invite.codePassword": "пароль аккаунта",
  "invite.codePhrase": "фразу восстановления",

  "sessions.lastSeen": "{client} · на связи {time}",
  "sessions.revoke": "Выйти",
  "sessions.logoutAll": "Выйти везде",
  "sessions.logoutAllDesc": "Закрывает все входы, кроме этого. Устройства продолжают синхронизироваться.",
  "sessions.logoutAllConfirm": "Выйти на всех остальных устройствах?",

  "unlock.phraseDesc": "Vault зашифрован, а ключа на этом устройстве нет. У аккаунта нет пароля: войдите фразой восстановления или отсканируйте QR с подключённого устройства.",

  "email.title": "Добавить email и пароль",
  "email.desc": "Позволяет входить вводом на любом устройстве и защищает действия паролем. Один пароль для аккаунта и шифрования. С устройства он не уходит.",
  "email.submit": "Добавить",
  "email.done": "Email и пароль добавлены",
  "auth.noPassword": "У аккаунта нет пароля: добавьте его в настройках",
  "auth.hasEmail": "У аккаунта уже есть email",

  "cmd.phrase": "Фраза восстановления",
  "error.generic": "Ошибка: {message}",
  "error.badKdf": "Сервис запросил небезопасные параметры защиты пароля. Ничего не отправлено; обновите плагин или напишите в поддержку.",
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
  };
  const k = code ? known[code] : undefined;
  if (k) return t(k);
  const msg = e instanceof Error ? e.message : String(e);
  // В сообщении — адрес из ссылки.
  if (code === "untrusted_server") return t("code.untrusted", { server: msg });
  if (/ERR_|ECONN|net::|Failed to fetch|timed out/i.test(msg)) return t("auth.offline");
  return t("error.generic", { message: msg });
}
