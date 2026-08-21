// Контракти ядра (§4). Модулям передається ПОВНИЙ типізований конфіг (Ctx.config),
// кожен описує свій зріз — усуває «модуль не бачить поле верхнього рівня» (§19.5).

export type { Clock } from './clock.js';
import type { Clock } from './clock.js';

/**
 * Блок брифінгу.
 *
 * ⚠️ Що тут МОЖНА мати: рівно те, що доїжджає до споживача. Споживач один —
 * `briefing.json` для Mini App, і `buildBriefingData` бере id/title/icon/
 * summary/data/priority. Telegram отримує лише заголовок дати й короткий рядок
 * дня, які збирає orchestrator.
 *
 * Тому звідси прибрано (аудит B20/F5) `detail`/`summaryHtml`/`detailHtml`/
 * `buttons`/`inMessage`: усі п'ять читав ЛИШЕ видалений рендерер. Найгірше в
 * них було не саме сміття, а хибний контракт — модулі чесно рахували HTML і
 * кнопки, які нікуди не йшли (news екранував лінки, weather складав повний
 * detail, stoic/fact/jobs малювали 🔖 «Зберегти»). Нове поле тут заводимо лише
 * разом зі споживачем.
 */
export interface Block {
  id: string;
  title: string;
  icon?: string;
  summary: string; // показується завжди (плейн-текст)
  priority: number; // порядок ВІДОБРАЖЕННЯ (менше = вище)
  // Структуровані дані блоку для Mini App (briefing.json). Серіалізовний JSON.
  data?: unknown;
  // Поля `fresh` немає. Єдиний сигнал «нічого свіжого» — run() повертає null.
}

/** Довговічний стан МІЖ запусками (персиститься у state.json / гілку state). */
export interface StateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  /**
   * Змінити ключ ТРАНСФОРМАЦІЄЮ, а не знімком.
   *
   * Різниця видна лише на flush у KV-сторі й лише для ключів, які пише ще
   * хтось. `set` фіксує значення, пораховане на початку рану, і на flush кладе
   * його поверх свіжого — тобто затирає все, що встигло статись за час рану
   * (а він триває хвилини). `update` натомість застосовує функцію до СВІЖОГО
   * значення в момент запису.
   *
   * Бери `update` там, де нове значення ВИВОДИТЬСЯ зі старого (decay, лічильник,
   * додавання в список). Бери `set` там, де значення авторитетне саме по собі
   * (`lastSentDate`, `lastDecayDate`) — його якраз і треба покласти як є.
   *
   * ⚠️ Функція мусить бути чистою й ідемпотентною за змістом: на flush вона
   * викликається ВДРУГЕ, вже на свіжому значенні.
   */
  update<T>(key: string, fn: (current: T | undefined) => T): void;
  flush(): Promise<void>;
  prune(): void;
}

/** Transient producer->consumer У МЕЖАХ одного запуску. НЕ персиститься. */
export interface RunBus {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface LLMClient {
  /** tag — ідентифікатор модуля-викликача (A3): якщо виклик упаде, оркестратор
   *  назве в попередженні саме той блок, що деградував. */
  complete(
    prompt: string,
    opts?: { maxTokens?: number; timeoutMs?: number; tag?: string },
  ): Promise<string>;
}

export interface SourceFetcher {
  /** Тільки allowlist; таймаут; ретрай з бекофом. Лінки з контенту не відкриваємо (SSRF). */
  fetch(url: string): Promise<string>;
}

export interface Logger {
  debug(msg: string, ...args: unknown[]): void;
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
}

export interface Ctx<TConfig = unknown> {
  clock: Clock;
  config: TConfig;
  state: StateStore;
  bus: RunBus;
  llm: LLMClient;
  fetcher: SourceFetcher;
  log: Logger;
}

export type ModuleKind = 'producer' | 'consumer';

export interface Module<TConfig = unknown> {
  id: string;
  kind: ModuleKind;
  enabled(config: TConfig): boolean;
  run(ctx: Ctx<TConfig>): Promise<Block | null>;
}
