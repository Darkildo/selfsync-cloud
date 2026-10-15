// Регионы: адреса и регион по умолчанию по языку Obsidian.

import assert from "node:assert/strict";
import { test } from "node:test";

import { defaultRegion, REGIONS, regionUrl } from "../src/regions.ts";

test("регионы СНГ и Europe с адресами входа", () => {
  assert.deepEqual([...REGIONS], ["cis", "eu"]);
  for (const r of REGIONS) assert.match(regionUrl(r), /^https:\/\/[\d.]+:7443$/);
  assert.equal(regionUrl("mars"), "");
});

test("регион по умолчанию — по языку", () => {
  for (const l of ["ru", "ru-RU", "uk", "be", "kk", "uz"]) assert.equal(defaultRegion(l), "cis", l);
  for (const l of ["en", "en-gb", "de", "fr", "zh-cn", ""]) assert.equal(defaultRegion(l), "eu", l);
});
