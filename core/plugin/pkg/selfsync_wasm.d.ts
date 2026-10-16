
export class WasmEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Обрабатывает событие; возвращает массив действий для исполнителя.
     */
    handle(now: number, event: any): any;
    /**
     * Есть ли неотправленные локальные изменения (перед выгрузкой плагина).
     */
    hasPending(): boolean;
    /**
     * `config` — объект настроек (`EngineConfig`, поля в camelCase, все необязательны);
     * `index` — сохранённый снимок индекса или `undefined`.
     */
    constructor(config: any, index?: Uint8Array | null);
    /**
     * Когда движок хочет следующий `tick` (мс) или `undefined`.
     */
    nextWake(): number | undefined;
    /**
     * Текущий статус (то же, что последний `Action::Status`).
     */
    status(): any;
}

/**
 * Argon2id(пароль, соль) → 32 байта; параметры — в тех же пределах, что у записи
 * ключа vault'а. Для надстроек (вход в аккаунт сервиса), ядру синка не нужен.
 */
export function argon2id(password: string, salt: Uint8Array, m_cost_kib: number, t_cost: number, p_cost: number): Uint8Array;

/**
 * Проверка фразы восстановления до отправки: `undefined` — в порядке, иначе
 * `count:N` (слов не 24), `word:I` (слово I, с единицы, не из словаря) или
 * `checksum`. Текст сообщения формирует интерфейс.
 */
export function checkPhrase(phrase: string): string | undefined;

export function clientOlderThan(client: string, min: string): boolean;

/**
 * Нормализованный путь vault'а (NFC, без лишних `/`) или `undefined`, если путь
 * не синхронизируется.
 */
export function normalizePath(path: string): string | undefined;

/**
 * Оценка стойкости пароля в битах (подсказка в интерфейсе, не запрет).
 */
export function passwordStrength(password: string): number;

/**
 * Фраза → 32 байта энтропии; неверная фраза — `undefined` (причину даёт `checkPhrase`).
 */
export function phraseDecode(phrase: string): Uint8Array | undefined;

/**
 * 32 байта энтропии → 24 слова BIP39 (как фраза восстановления vault'а).
 */
export function phraseEncode(entropy: Uint8Array): string[];

/**
 * Версия протокола, которую говорит ядро.
 */
export function protocolVersion(): number;

/**
 * QR-код строки (ссылки подключения): `[ширина, модули…]`, модуль 1 — тёмный.
 * Рисует интерфейс: так в WASM не попадает рендерер SVG/картинок.
 */
export function qrModules(text: string): Uint8Array;

/**
 * Клиент устройства (`plugin/0.3.0`) старее `min`; пустой или неразборчивый — тоже.
 * Минорная версия протокола, с которой сервер стирает старые версии файла.
 */
export function quotaMinor(): number;

/**
 * Минорная версия протокола, с которой сервер умеет устройства только для чтения
 * (сравнивается с `SyncStatus.serverMinor`).
 */
export function readOnlyMinor(): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmengine_free: (a: number, b: number) => void;
    readonly argon2id: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => void;
    readonly checkPhrase: (a: number, b: number, c: number) => void;
    readonly clientOlderThan: (a: number, b: number, c: number, d: number) => number;
    readonly normalizePath: (a: number, b: number, c: number) => void;
    readonly passwordStrength: (a: number, b: number) => number;
    readonly phraseDecode: (a: number, b: number, c: number) => void;
    readonly phraseEncode: (a: number, b: number, c: number) => void;
    readonly protocolVersion: () => number;
    readonly qrModules: (a: number, b: number, c: number) => void;
    readonly quotaMinor: () => number;
    readonly readOnlyMinor: () => number;
    readonly wasmengine_handle: (a: number, b: number, c: number, d: number) => void;
    readonly wasmengine_hasPending: (a: number) => number;
    readonly wasmengine_new: (a: number, b: number, c: number, d: number) => void;
    readonly wasmengine_nextWake: (a: number, b: number) => void;
    readonly wasmengine_status: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
