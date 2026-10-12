// Плагин Selfsync Cloud: аккаунт, тарифы и подключение устройств поверх ядра
// открытого selfsync. Ядро, исполнитель и общие окна — из подмодуля core/.

import { moment, Plugin } from "obsidian";

import wasmBytes from "selfsync-wasm-bytes";
import { protocolVersion } from "../core/plugin/pkg/selfsync_wasm.js";
import { initWasm } from "../core/plugin/src/engine.ts";
import { setLanguage } from "./i18n.ts";
import { CloudSettingTab } from "./settings.ts";

export interface CloudSettings {
  email: string;
}

const DEFAULT_SETTINGS: CloudSettings = { email: "" };

export default class SelfsyncCloudPlugin extends Plugin {
  override settings: CloudSettings = { ...DEFAULT_SETTINGS };
  private settingTab: CloudSettingTab | undefined;

  override async onload(): Promise<void> {
    setLanguage(moment.locale());
    this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<CloudSettings> | null) };
    initWasm(wasmBytes);
    this.settingTab = new CloudSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
  }

  /** Версия ядра, с которым собран плагин: тег подмодуля и протокол из WASM. */
  core(): { version: string; protocol: number } {
    return { version: __CORE_VERSION__, protocol: protocolVersion() };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}
