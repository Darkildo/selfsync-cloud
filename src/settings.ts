// Вкладка настроек. Пока сервиса нет — только заготовка раздела аккаунта и версия
// ядра, чтобы было видно, из какого тега selfsync собран плагин. Как и в открытом
// плагине: до Obsidian 1.13 строки рисует `display()`, с 1.13 — `getSettingDefinitions()`.

import { type App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";

import { t } from "./i18n.ts";
import type SelfsyncCloudPlugin from "./main.ts";

interface Row {
  name: string;
  desc?: string;
  build(s: Setting): void;
}

interface Section {
  heading: string;
  rows: Row[];
}

export class CloudSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: SelfsyncCloudPlugin,
  ) {
    super(app, plugin);
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return this.sections().map((sec) => ({
      type: "group" as const,
      heading: sec.heading,
      items: sec.rows.map((r) => ({ name: r.name, desc: r.desc, render: (s: Setting) => r.build(s) })),
    }));
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();
    for (const sec of this.sections()) {
      new Setting(containerEl).setName(sec.heading).setHeading();
      for (const r of sec.rows) r.build(new Setting(containerEl));
    }
  }

  private sections(): Section[] {
    const core = this.plugin.core();
    const coreDesc = t("settings.coreDesc", { version: core.version, protocol: core.protocol });
    const soon: Row = {
      name: "",
      build: (s) => {
        s.setDesc(t("settings.soon"));
      },
    };
    const coreRow: Row = {
      name: t("settings.core"),
      desc: coreDesc,
      build: (s) => {
        s.setName(t("settings.core")).setDesc(coreDesc);
      },
    };
    return [
      { heading: t("settings.account"), rows: [soon] },
      { heading: t("settings.about"), rows: [coreRow] },
    ];
  }
}
