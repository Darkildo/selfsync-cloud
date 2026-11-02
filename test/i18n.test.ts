// Переводы облачной части: ключи и параметры как в en, выбор языка — как в ядре.

import assert from "node:assert/strict";
import { test } from "node:test";

import { lintDict } from "../core/plugin/src/i18n/lint.ts";
import { formatDate, language, resolveLanguage, setLanguage, t } from "../src/i18n.ts";
import { en } from "../src/i18n/en.ts";
import { LOCALES } from "../src/i18n/locales.ts";

test("переводы: ключи и параметры совпадают с en", () => {
  for (const [code, dict] of Object.entries(LOCALES)) {
    assert.equal(code, code.toLowerCase(), `${code}: код в реестре — в нижнем регистре`);
    assert.deepEqual(lintDict(dict, en).errors, [], code);
  }
});

test("ru: перевод полный", () => {
  const r = lintDict(LOCALES["ru"] ?? {}, en);
  assert.equal(r.translated, r.total);
});

test("выбор языка: точный код, базовый язык, en", () => {
  assert.equal(resolveLanguage("ru"), "ru");
  assert.equal(resolveLanguage("ru-RU"), "ru");
  assert.equal(resolveLanguage("en-GB"), "en");
  assert.equal(resolveLanguage("constructor"), "en");
  assert.equal(resolveLanguage(""), "en");
});

test("нет строки в переводе — английская; письмо справа налево — параметры изолированы", () => {
  LOCALES["xx"] = { "settings.account": "X" };
  LOCALES["zh"] = { "settings.account": "Z" };
  LOCALES["ar"] = { "invite.code": "A {code}" };
  try {
    setLanguage("xx-YY");
    assert.equal(language(), "xx");
    assert.equal(t("settings.account"), "X");
    assert.equal(t("settings.about"), "About");
    setLanguage("zh-cn");
    assert.equal(t("settings.account"), "Z", "moment.locale() отдаёт zh-cn, у Obsidian это zh");
    setLanguage("zh-TW");
    assert.equal(t("settings.account"), "Z", "нет zh-tw — базовый zh");
    setLanguage("ar");
    assert.equal(t("invite.code", { code: "AB12" }), "A ⁨AB12⁩");
    setLanguage("de");
    assert.equal(formatDate(Date.UTC(2026, 10, 2, 12)), "02.11.26");
  } finally {
    delete LOCALES["xx"];
    delete LOCALES["zh"];
    delete LOCALES["ar"];
    setLanguage("en");
  }
});
