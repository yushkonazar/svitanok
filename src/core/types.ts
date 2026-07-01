// Контракти ядра (§4). Модулям передається ПОВНИЙ типізований конфіг (Ctx.config),
// кожен описує свій зріз — усуває «модуль не бачить поле верхнього рівня» (§19.5).

export type { Clock } from './clock.js';
import type { Clock } from './clock.js';

export interface Button {
  label: string;
  action: string;
}

export interface Block {
  id: string;
  title: string;
  icon?: string;
  summary: string; // показується завжди (плейн-текст; render екранує)
  detail?: string; // ховається в expandable (плейн-текст; render екранує)
  // Готовий БЕЗПЕЧНИЙ HTML (модуль уже екранував динаміку через escapeHtml) —
  // для лінків у словах тощо. Якщо заданий, render бере його замість summary/detail.
  summaryHtml?: string;
  detailHtml?: string;
  buttons?: Button[];
  priority: number; // порядок ВІДОБРАЖЕННЯ (менше = вище)
  // Структуровані дані блоку для Mini App (briefing.json). Серіалізовний JSON.
  data?: unknown;
  // false -> блок НЕ йде в Telegram-повідомлення (лише в Mini App). Дефолт true.
  inMessage?: boolean;
  // Поля `fresh` немає. Єдиний сигнал «нічого свіжого» — run() повертає null.
}

/** Довговічний стан МІЖ запусками (персиститься у state.json / гілку state). */
export interface StateStore {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
  flush(): Promise<void>;
  prune(): void;
}

/** Transient producer->consumer У МЕЖАХ одного запуску. НЕ персиститься. */
export interface RunBus {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T): void;
}

export interface LLMClient {
  complete(prompt: string, opts?: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
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
  handleCallback?(action: string, ctx: Ctx<TConfig>): Promise<void>; // фаза B
}
