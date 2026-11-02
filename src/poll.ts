// Опрос обмена ключом: часто, пока ответ вероятен, потом реже; без связи — ещё
// реже. Обмен у сервера живёт до 20 минут: каждые 1,5 с — это ~800 запросов.

/** Первую минуту — каждые 1,5 с: второе устройство обычно рядом и отвечает сразу. */
export const POLL_MS = 1500;
export const POLL_FAST_FOR_MS = 60_000;
/** Дальше — каждые 5 с. */
export const POLL_SLOW_MS = 5000;
/** Нет связи — шаг растёт вдвое на каждую ошибку подряд, до 10 с. */
export const POLL_ERROR_MAX_MS = 10_000;

/** Пауза до следующего шага: `elapsed` — с начала опроса, `failures` — ошибок подряд. */
export function pollDelay(elapsed: number, failures: number): number {
  const base = elapsed < POLL_FAST_FOR_MS ? POLL_MS : POLL_SLOW_MS;
  return failures === 0 ? base : Math.min(POLL_ERROR_MAX_MS, base * 2 ** failures);
}

export interface PollOptions {
  /** Окно открыто и ответ ещё нужен. */
  alive: () => boolean;
  /** Срок (`Date.now()`), после которого опрос прекращается. */
  deadline: number;
  /** Шаг не удался (нет связи): опрос идёт дальше. */
  onError?: (e: unknown) => void;
  sleep?: (ms: number) => Promise<unknown>;
  now?: () => number;
}

/** Опрашивать `step`, пока он не вернёт `true`, окно открыто и срок не вышел.
 *  Итог: `done` — шаг закончил, `closed` — окно закрыли, `timeout` — срок вышел. */
export async function poll(step: () => Promise<boolean>, o: PollOptions): Promise<"done" | "closed" | "timeout"> {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => window.setTimeout(r, ms)));
  const start = now();
  let failures = 0;
  while (o.alive() && now() < o.deadline) {
    try {
      if (await step()) return "done";
      failures = 0;
    } catch (e) {
      failures++;
      o.onError?.(e);
    }
    if (!o.alive()) return "closed";
    await sleep(pollDelay(now() - start, failures));
  }
  return o.alive() ? "timeout" : "closed";
}
