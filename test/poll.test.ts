// Опрос обмена ключом: часто первую минуту, потом реже, без связи — ещё реже;
// окно закрыли — опрос стоит.

import assert from "node:assert/strict";
import { test } from "node:test";

import { poll, pollDelay } from "../src/poll.ts";

/** Время только по паузам опроса: тест не ждёт по-настоящему. */
function clock() {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => {
      waits.push(ms);
      now += ms;
      return Promise.resolve();
    },
    waits,
  };
}

test("пауза: 1,5 с первую минуту, потом 5 с; ошибки подряд — вдвое, до 10 с", () => {
  assert.equal(pollDelay(0, 0), 1500);
  assert.equal(pollDelay(59_999, 0), 1500);
  assert.equal(pollDelay(60_000, 0), 5000);
  assert.equal(pollDelay(0, 1), 3000);
  assert.equal(pollDelay(0, 2), 6000);
  assert.equal(pollDelay(0, 5), 10_000);
  assert.equal(pollDelay(120_000, 1), 10_000);
});

test("опрос обмена (21 минута): запросов втрое меньше, чем каждые 1,5 с", async () => {
  const c = clock();
  let steps = 0;
  const end = await poll(
    () => {
      steps++;
      return Promise.resolve(false);
    },
    { alive: () => true, deadline: 21 * 60_000, sleep: c.sleep, now: c.now },
  );
  assert.equal(end, "timeout");
  // 40 шагов за первую минуту и по одному на 5 с дальше.
  assert.ok(steps <= 40 + 240 + 1, String(steps));
  assert.ok(steps < (21 * 60_000) / 1500 / 2.5, String(steps));
});

test("шаг закончил — опрос стоит; окно закрыли — тоже", async () => {
  const c = clock();
  let n = 0;
  assert.equal(await poll(() => Promise.resolve(++n === 3), { alive: () => true, deadline: 60_000, sleep: c.sleep, now: c.now }), "done");
  assert.equal(n, 3);
  assert.deepEqual(c.waits, [1500, 1500]);

  let alive = true;
  let m = 0;
  const end = await poll(
    () => {
      if (++m === 2) alive = false;
      return Promise.resolve(false);
    },
    { alive: () => alive, deadline: 60_000, sleep: c.sleep, now: c.now },
  );
  assert.equal(end, "closed");
  assert.equal(m, 2);
});

test("нет связи — ошибка показывается, пауза растёт; связь вернулась — снова обычная", async () => {
  const c = clock();
  const errors: unknown[] = [];
  let n = 0;
  const end = await poll(
    () => {
      n++;
      if (n <= 3) return Promise.reject(new Error("offline"));
      return Promise.resolve(n === 5);
    },
    { alive: () => true, deadline: 60_000, onError: (e) => errors.push(e), sleep: c.sleep, now: c.now },
  );
  assert.equal(end, "done");
  assert.equal(errors.length, 3);
  assert.deepEqual(c.waits, [3000, 6000, 10_000, 1500]);
});
