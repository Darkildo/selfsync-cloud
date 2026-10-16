// Вкладка настроек: аккаунт, фраза восстановления, vault этого устройства, входы
// и устройства аккаунта, тарифы и версия ядра; затем разделы синхронизации
// открытого плагина как есть.

import { type App, Notice, type Setting } from "obsidian";

import { formatBytes, t as coreT } from "../core/plugin/src/i18n.ts";
import { type Row, type Section, SelfsyncSettingTab } from "../core/plugin/src/settings.ts";
import { confirm } from "../core/plugin/src/ui/confirm.ts";
import { DiagnoseModal } from "../core/plugin/src/ui/diagnose.ts";
import type { TariffView } from "./api.ts";
import { errorText, t } from "./i18n.ts";
import type SelfsyncCloudPlugin from "./main.ts";
import { ChangePasswordModal, EmailPasswordModal, ExistingModal, InviteModal, PasswordPromptModal, StartModal, VaultModal } from "./ui.ts";

/** Данные аккаунта старее — перечитать при открытии вкладки. */
const STALE_MS = 30_000;

export function limitText(n: number, f: (n: number) => string = String): string {
  return n === 0 ? t("account.unlimited") : f(n);
}

export function tariffLimits(x: TariffView): string {
  return t("tariff.limits", {
    bytes: limitText(x.bytes_hard, formatBytes),
    vaults: limitText(x.vaults),
    devices: limitText(x.devices),
    file: limitText(x.max_file, formatBytes),
  });
}

export class CloudSettingTab extends SelfsyncSettingTab {
  private loadedAt = 0;
  private loading = false;
  /** Аккаунт не загрузился: текст ошибки (нет связи, регион не открыт). */
  private loadError = "";

  constructor(
    app: App,
    private cloudPlugin: SelfsyncCloudPlugin,
  ) {
    super(app, cloudPlugin);
  }

  /** Аккаунт и тарифы — с сервера, в фоне; по ответу вкладка перерисовывается. */
  private load(): void {
    if (this.loading || Date.now() - this.loadedAt < STALE_MS) return;
    const cloud = this.cloudPlugin.cloud;
    if (!cloud.server()) {
      this.loadError = t("account.notOpen");
      return;
    }
    this.loading = true;
    void Promise.allSettled([cloud.refreshAccount(), cloud.loadInfo()]).then(([account]) => {
      this.loading = false;
      this.loadedAt = Date.now();
      this.loadError = account.status === "rejected" ? errorText(account.reason) : "";
      this.cloudPlugin.accountChanged();
    });
  }

  /** Перечитать аккаунт (после действий): сейчас, если вкладка открыта, иначе при открытии. */
  reload(): void {
    this.loadedAt = 0;
    if (this.containerEl.isConnected) this.load();
    this.refresh();
  }

  protected override sections(): Section[] {
    // Обе отрисовки (display и getSettingDefinitions) начинаются здесь.
    this.load();
    const keep = super
      .sections()
      .filter((s) => s.heading === coreT("settings.sync") || s.heading === coreT("configSync.heading"));
    const out: Section[] = [{ heading: t("settings.account"), rows: this.accountRows() }];
    const vault = this.vaultRows();
    if (vault.length > 0) out.push({ heading: t("settings.vault"), rows: vault });
    if (this.cloudPlugin.cloud.account) {
      out.push({ heading: t("settings.sessions"), rows: this.sessionRows() });
      out.push({ heading: t("settings.devices"), rows: this.deviceRows() });
    }
    const tariffs = this.tariffRows();
    if (tariffs.length > 0) out.push({ heading: t("settings.tariffs"), rows: tariffs });
    out.push(...keep);
    out.push({ heading: t("settings.about"), rows: [this.aboutRow()] });
    return out;
  }

  private get s() {
    return this.cloudPlugin.settings;
  }

  private accountRows(): Row[] {
    const cloud = this.cloudPlugin.cloud;
    const a = cloud.account;
    const rows: Row[] = [];
    if (a) {
      const name = a.email ?? t("account.anonymous", { id: a.id });
      const desc = t("account.usage", {
        tariff: a.tariff.title,
        used: formatBytes(a.usage.bytes),
        limit: limitText(a.tariff.bytes_hard, formatBytes),
        vaults: `${a.usage.vaults}/${limitText(a.tariff.vaults)}`,
        devices: `${a.usage.devices}/${limitText(a.tariff.devices)}`,
      });
      rows.push({
        name,
        desc,
        build: (s: Setting) => {
          s.setName(name).setDesc(desc);
          if (a.has_password) s.addButton((b) => b.setButtonText(t("account.changePassword")).onClick(() => new ChangePasswordModal(this.app, this.cloudPlugin).open()));
          else if (cloud.accountKey()) s.addButton((b) => b.setButtonText(t("account.addEmail")).onClick(() => new EmailPasswordModal(this.app, this.cloudPlugin).open()));
          s.addButton((b) => b.setButtonText(t("account.logout")).onClick(() => void cloud.logout()));
        },
      });
      rows.push(this.phraseRow());
      rows.push({
        name: t("account.delete"),
        desc: t("account.deleteDesc"),
        build: (s: Setting) => {
          s.setName(t("account.delete")).setDesc(t("account.deleteDesc"));
          s.addButton((b) =>
            b.setButtonText(t("account.delete")).onClick(() => {
              if (a.has_password) {
                new PasswordPromptModal(this.app, t("account.delete"), t("account.deleteConfirm"), async (pw) => {
                  await cloud.deleteAccount(pw);
                  new Notice(t("account.deleted"));
                  return null;
                }).open();
                return;
              }
              void confirm(this.app, t("account.deleteConfirmKey"), t("account.delete")).then(async (ok) => {
                if (!ok) return;
                try {
                  await cloud.deleteAccount();
                  new Notice(t("account.deleted"));
                } catch (e) {
                  new Notice(errorText(e));
                }
              });
            }),
          );
        },
      });
    } else if (this.s.session) {
      // Сессия есть, а аккаунт не загрузился: не предлагать начать заново.
      const label = this.s.email || (this.s.accountId ? t("account.anonymous", { id: this.s.accountId }) : t("settings.account"));
      const desc = this.loadError ? t("account.unavailable", { error: this.loadError }) : t("account.loading");
      rows.push({
        name: label,
        desc,
        build: (s: Setting) => {
          s.setName(label).setDesc(desc);
          if (this.loadError) s.addButton((b) => b.setButtonText(t("account.retry")).onClick(() => this.reload()));
          s.addButton((b) => b.setButtonText(t("account.logout")).onClick(() => void cloud.logout()));
        },
      });
      if (cloud.pendingPhrase()) rows.push(this.phraseRow());
    } else {
      const invited = this.s.vault !== "";
      const desc = invited ? t("account.invited", { label: this.s.vaultLabel }) : t("account.intro");
      rows.push({
        name: "",
        desc,
        build: (s: Setting) => {
          s.setDesc(desc);
          if (!invited) s.addButton((b) => b.setButtonText(t("start.begin")).setCta().onClick(() => new StartModal(this.app, this.cloudPlugin).open()));
          s.addButton((b) => b.setButtonText(t("start.signIn")).onClick(() => new ExistingModal(this.app, this.cloudPlugin).open()));
        },
      });
    }
    rows.push({
      name: coreT("settings.device"),
      desc: t("settings.deviceDesc"),
      build: (s: Setting) => {
        s.setName(coreT("settings.device")).setDesc(t("settings.deviceDesc"));
        s.addText((x) =>
          x.setValue(this.s.deviceName).onChange(async (v) => {
            this.s.deviceName = v.trim() || this.s.deviceName;
            await this.cloudPlugin.saveSettings({ reconfigure: true });
          }),
        );
      },
    });
    rows.push({
      name: t("account.service"),
      desc: t("account.serviceDesc"),
      build: (s: Setting) => {
        s.setName(t("account.service")).setDesc(t("account.serviceDesc"));
        s.addText((x) =>
          x
            .setValue(this.s.serviceUrl)
            .onChange(async (v) => {
              this.s.serviceUrl = v.trim();
              await this.cloudPlugin.saveSettings();
            }),
        );
      },
    });
    return rows;
  }

  /** Фраза восстановления: записана ли, показать или создать новую. */
  private phraseRow(): Row {
    const cloud = this.cloudPlugin.cloud;
    const status = cloud.phraseStatus();
    const desc = {
      confirmed: t("phrase.statusConfirmed"),
      "pending-here": t("phrase.statusHere"),
      "pending-elsewhere": t("phrase.statusElsewhere"),
      unknown: "",
    }[status];
    return {
      name: t("phrase.title"),
      desc,
      build: (s: Setting) => {
        s.setName(t("phrase.title")).setDesc(desc);
        if (status === "pending-here") s.addButton((b) => b.setButtonText(t("phrase.show")).setCta().onClick(() => this.cloudPlugin.showPhrase()));
        else if (cloud.accountKey()) s.addButton((b) => b.setButtonText(t("phrase.new")).onClick(() => this.cloudPlugin.showPhrase()));
      },
    };
  }

  private vaultRows(): Row[] {
    const cloud = this.cloudPlugin.cloud;
    if (this.s.vault) {
      const name = t("vault.connected", { label: this.s.vaultLabel || this.s.vault });
      return [
        {
          name,
          desc: t("vault.connectedDesc"),
          build: (s: Setting) => {
            s.setName(name).setDesc(t("vault.connectedDesc"));
            s.addButton((b) => b.setButtonText(t("vault.invite")).onClick(() => new InviteModal(this.app, this.cloudPlugin).open()));
            s.addButton((b) =>
              b
                .setButtonText(coreT("diag.button"))
                .setDisabled(!this.cloudPlugin.runner)
                .onClick(() => new DiagnoseModal(this.app, () => this.cloudPlugin.diagnose()).open()),
            );
          },
        },
        {
          name: t("vault.disconnect"),
          desc: t("vault.disconnectDesc"),
          build: (s: Setting) => {
            s.setName(t("vault.disconnect")).setDesc(t("vault.disconnectDesc"));
            s.addButton((b) =>
              b
                .setButtonText(t("vault.disconnectButton"))
                .setDestructive()
                .onClick(async () => {
                  if (!(await confirm(this.app, t("vault.disconnectConfirm"), t("vault.disconnectButton")))) return;
                  try {
                    await cloud.forgetDevice();
                  } catch (e) {
                    // Без связи токен не отозвать: отключить только здесь — по согласию.
                    if (!(await confirm(this.app, t("vault.disconnectOffline", { error: errorText(e) }), t("vault.disconnectButton")))) return;
                    await cloud.forgetDevice({ revoke: false });
                  }
                }),
            );
          },
        },
      ];
    }
    if (!cloud.account) return [];
    return [
      {
        name: t("vault.pickTitle"),
        desc: t("vault.pickDesc"),
        build: (s: Setting) => {
          s.setName(t("vault.pickTitle")).setDesc(t("vault.pickDesc"));
          s.addButton((b) => b.setButtonText(t("vault.pickTitle")).setCta().onClick(() => new VaultModal(this.app, this.cloudPlugin).open()));
        },
      },
    ];
  }

  /** Входы в аккаунт (сессии): с какого устройства, когда; отзыв и «выйти везде». */
  private sessionRows(): Row[] {
    const cloud = this.cloudPlugin.cloud;
    const a = cloud.account;
    if (!a) return [];
    const rows: Row[] = a.sessions.map((x) => {
      const name = x.current ? t("devices.current", { name: x.name }) : x.name;
      const time = x.last_seen ? t("sessions.lastSeen", { time: new Date(x.last_seen).toLocaleString() }) : "";
      const desc = [x.client, time].filter(Boolean).join(" · ");
      return {
        name,
        desc,
        build: (s: Setting) => {
          s.setName(name).setDesc(desc);
          if (x.current) return;
          s.addButton((b) =>
            b.setButtonText(t("sessions.revoke")).onClick(async () => {
              try {
                await cloud.revokeSession(x.id);
              } catch (e) {
                s.setDesc(errorText(e));
              }
            }),
          );
        },
      };
    });
    if (a.sessions.length > 1) {
      rows.push({
        name: t("sessions.logoutAll"),
        desc: t("sessions.logoutAllDesc"),
        build: (s: Setting) => {
          s.setName(t("sessions.logoutAll")).setDesc(t("sessions.logoutAllDesc"));
          s.addButton((b) =>
            b.setButtonText(t("sessions.logoutAll")).onClick(async () => {
              if (!(await confirm(this.app, t("sessions.logoutAllConfirm"), t("sessions.logoutAll")))) return;
              try {
                await cloud.logoutAll();
              } catch (e) {
                new Notice(errorText(e));
              }
            }),
          );
        },
      });
    }
    return rows;
  }

  private deviceRows(): Row[] {
    const a = this.cloudPlugin.cloud.account;
    if (!a || a.devices.length === 0) return [{ name: "", build: (s: Setting) => s.setDesc(t("devices.none")) }];
    const label = (vault: string) => a.vaults.find((v) => v.name === vault)?.label ?? vault;
    return a.devices.map((d) => {
      const desc = t("devices.lastSeen", { vault: label(d.vault), time: d.last_seen ? new Date(d.last_seen).toLocaleString() : "—" });
      // Это устройство отключают в разделе vault'а: там ещё забываются ключи.
      const current = this.s.deviceId !== 0 && d.id === this.s.deviceId;
      const name = current ? t("devices.current", { name: d.name }) : d.name;
      return {
        name,
        desc,
        build: (s: Setting) => {
          s.setName(name).setDesc(desc);
          if (current) return;
          s.addButton((b) =>
            b.setButtonText(t("devices.revoke")).onClick(async () => {
              if (!(await confirm(this.app, t("devices.revokeConfirm", { name: d.name }), t("devices.revoke")))) return;
              try {
                await this.cloudPlugin.cloud.revokeDevice(d.id);
              } catch (e) {
                s.setDesc(errorText(e));
              }
            }),
          );
        },
      };
    });
  }

  private tariffRows(): Row[] {
    const cloud = this.cloudPlugin.cloud;
    const list = cloud.info()?.tariffs ?? (cloud.account ? [cloud.account.tariff] : []);
    const current = cloud.account?.tariff.id;
    return list.map((x) => {
      const status = x.id === current ? t("tariff.current") : x.status === "soon" ? t("tariff.soon") : "";
      const name = [x.title, x.price, status ? `· ${status}` : ""].filter(Boolean).join(" ");
      const desc = tariffLimits(x);
      return {
        name,
        desc,
        build: (s: Setting) => {
          s.setName(name).setDesc(desc);
          // Тариф «скоро» виден, но выбрать его пока нельзя.
          if (x.status === "soon") s.settingEl.addClass("selfsync-cloud-soon");
        },
      };
    });
  }

  private aboutRow(): Row {
    const core = this.cloudPlugin.core();
    const desc = t("settings.coreDesc", { version: core.version, protocol: core.protocol });
    return {
      name: t("settings.core"),
      desc,
      build: (s: Setting) => {
        s.setName(t("settings.core")).setDesc(desc);
      },
    };
  }
}
