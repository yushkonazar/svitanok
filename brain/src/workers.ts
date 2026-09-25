// Працівники (07 §5): працівник - окремий прогін SDK зі СВОЇМ системним
// промптом, моделлю і стелею ходів. Розмови власника він не бачить: на вхід
// іде лише задача й формат, назад - текст. Тут реєстр працівників (дзеркало
// front-matter docs/assistant/agents/<name>.md - парність тримає тест
// brain-workers, тож правка файлу без правки реєстру червонить CI) і запуск.
//
// Тіло інструкції (промпт) у реєстрі НЕ живе: воно приїжджає з D1 ядра через
// /internal/instruction у момент delegate і звіряється хешем (ADR-016), як
// персона в /run. Front-matter (модель, інструменти, стеля, taint) - тут, бо
// в D1 його немає, а мозку він потрібен ДО прогону.
//
// Етап 2 підключив одного - quick (він же профіль швидкої смуги); етап 4 -
// решту девʼятьох через delegate (тим самим runWorker).

import type { EngineOutcome, EngineRunOptions, RunEngine } from './agent.js';

/** `model:` з front-matter → id моделі API. Перелік той самий, що валідує
 *  ядро (web/core/instructions.mjs: haiku | sonnet | -). */
export const WORKER_MODEL_IDS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
} as const;

export type WorkerModel = keyof typeof WORKER_MODEL_IDS;

/** `effort:` з front-matter - скільки моделі думати перед відповіддю
 *  (SDK Options.effort). Дефолт SDK - 'high', тож поле має сенс саме тоді,
 *  коли працівникові стільки думати НЕ треба. */
export type WorkerEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const WORKER_EFFORTS: readonly WorkerEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Вбудовані інструменти SDK, які працівник може мати замість наших (01 §2.2:
 *  WebSearch/WebFetch - лише в Дослідника). */
export const BUILTIN_WORKER_TOOLS = ['WebSearch', 'WebFetch'] as const;
export type BuiltinWorkerTool = (typeof BUILTIN_WORKER_TOOLS)[number];

/** Дзеркало front-matter працівника (07 §5: front-matter → AgentDefinition). */
export interface WorkerDef {
  name: string;
  /** Тіло agents/<name>.md - системний промпт працівника. */
  prompt: string;
  model: WorkerModel;
  /** `max_steps` - стеля ходів SDK і викликів інструментів працівника. */
  maxSteps: number;
  /** `tools` у mcp-іменах; порожньо - працівник без наших інструментів. */
  toolNames: string[];
  /** `tools`, що є вбудованими інструментами SDK (WebSearch, WebFetch). */
  builtinTools: BuiltinWorkerTool[];
  /** `effort` - рівень зусиль; не задано = дефолт SDK. */
  effort?: WorkerEffort;
  /** `tainted_output` - вихід працівника є зовнішнім вмістом: мозок маркує
   *  його <external> і просить ядро поставити taint треду (01 §4.2). */
  taintedOutput: boolean;
}

/** Опис без промпту - те, що є в реєстрі до приїзду інструкції з D1. */
export type WorkerSpec = Omit<WorkerDef, 'prompt'>;

/** `tools` з front-matter → mcp-імена наших інструментів + вбудовані окремо. */
function spec(
  name: string,
  model: WorkerModel,
  tools: readonly string[],
  maxSteps: number,
  taintedOutput: boolean,
  effort?: WorkerEffort,
): WorkerSpec {
  const builtinTools = tools.filter((t): t is BuiltinWorkerTool =>
    (BUILTIN_WORKER_TOOLS as readonly string[]).includes(t),
  );
  const toolNames = tools
    .filter((t) => !(BUILTIN_WORKER_TOOLS as readonly string[]).includes(t))
    .map((t) => t.replaceAll('.', '_'));
  return {
    name,
    model,
    maxSteps,
    toolNames,
    builtinTools,
    taintedOutput,
    ...(effort ? { effort } : {}),
  };
}

/**
 * Реєстр: значення - дзеркало front-matter файлів docs/assistant/agents/*.md
 * (крім code-reviewer - він живе в GitHub Actions, не в мозку). Інструменти,
 * ще не описані в ядрі (finance.query, routes.eta, places.*), лишаються тут
 * як у файлі - у прогін ідуть лише описані (фільтр у availableTools), а
 * інструкція каже працівникові писати про недоступне чесно.
 */
export const WORKERS: Readonly<Record<string, WorkerSpec>> = {
  analyst: spec('analyst', 'sonnet', ['data.read', 'data.search', 'finance.query'], 8, false),
  copywriter: spec('copywriter', 'sonnet', [], 4, false),
  'day-planner': spec(
    'day-planner',
    'sonnet',
    ['calendar.read', 'data.read', 'facts.get', 'routes.eta'],
    6,
    false,
  ),
  editor: spec('editor', 'haiku', [], 3, false),
  finance: spec('finance', 'sonnet', ['finance.query'], 6, false),
  'mail-secretary': spec('mail-secretary', 'sonnet', ['mail.search', 'mail.read'], 20, true),
  planner: spec(
    'planner',
    'sonnet',
    ['routes.eta', 'places.search', 'places.details', 'calendar.read'],
    10,
    true,
  ),
  // Один хід, 1-3 рядки, без інструментів - думати тут майже нема над чим, а
  // дефолтний 'high' коштував 8 с на «17 % від 14 672» (замір 29.08).
  quick: spec('quick', 'haiku', [], 1, false, 'low'),
  researcher: spec('researcher', 'sonnet', ['WebSearch', 'WebFetch'], 30, true),
  tutor: spec('tutor', 'haiku', ['data.read'], 6, false),
};

/** quick - профіль швидкої смуги; його опис читає profiles.ts. */
export const QUICK_WORKER: WorkerSpec = WORKERS.quick as WorkerSpec;

/** researcher - працівник профілю price-check (07 §5): WebSearch/WebFetch, sonnet, 30 ходів. */
export const RESEARCHER_WORKER: WorkerSpec = WORKERS.researcher as WorkerSpec;

/** Кого можна кликати через delegate: усі, крім quick (він - профіль швидкої
 *  смуги) і day-planner (він - працівник DayPlanChain з JSON-контрактом
 *  intent/explain/replan; у чаті план дня будує сам chat через plan.*, ревʼю
 *  PR-3). Опис інструмента delegate будується з цього ж переліку. */
export const DELEGATE_WORKERS: readonly string[] = Object.keys(WORKERS).filter(
  (n) => n !== 'quick' && n !== 'day-planner',
);

/**
 * Стеля ходів SDK для працівника: max_steps рахує ВИКЛИКИ інструментів, а
 * хід SDK - одне повідомлення моделі, тож N послідовних викликів + фінальна
 * відповідь = N+1 ходів (ревʼю PR-3: при maxTurns = max_steps стеля
 * інструментів була недосяжна, а фінал упирався в error_max_turns).
 * Один хід (quick) лишається одним.
 */
export function workerMaxTurns(maxSteps: number): number {
  return maxSteps <= 1 ? 1 : maxSteps + 2;
}

export interface WorkerRunContext {
  abortSignal: AbortSignal;
  onToolCall: EngineRunOptions['onToolCall'];
  onPartialText: EngineRunOptions['onPartialText'];
  /** Чи є куди стрімити частковий текст: у профілю quick є статусник, у
   *  працівника всередині chat його немає. */
  streamPartials: boolean;
  /** quick має окремий route, делегати — `worker`; це потрібно canary-router-у. */
  profileName?: string;
}

/**
 * Запустити працівника: свіжа сесія SDK (resume немає свідомо - працівник не
 * продовжує розмову власника і не має її бачити), модель і стеля ходів із
 * front-matter, інструменти - лише його власні.
 */
export function runWorker(
  engine: RunEngine,
  def: WorkerDef,
  task: string,
  ctx: WorkerRunContext,
): Promise<EngineOutcome> {
  return engine.run(
    {
      systemPrompt: def.prompt,
      model: WORKER_MODEL_IDS[def.model],
      profileName: ctx.profileName ?? 'worker',
      openAiModelTier: def.model === 'haiku' ? 'fast' : 'standard',
      maxOutputTokens: def.model === 'haiku' ? 1_000 : 2_000,
      safetyIdentifier: 'worker',
      maxTurns: workerMaxTurns(def.maxSteps),
      toolNames: def.toolNames,
      ...(def.builtinTools.length ? { builtinTools: [...def.builtinTools] } : {}),
      ...(def.effort ? { effort: def.effort } : {}),
      resumeSessionId: null,
      streamPartials: ctx.streamPartials,
      abortSignal: ctx.abortSignal,
      onToolCall: ctx.onToolCall,
      onPartialText: ctx.onPartialText,
    },
    task,
  );
}

/** Вхід працівника (07 §4 delegate): лише задача і формат, без розмови. */
export function workerInput(task: string, format: string): string {
  return `Задача:\n${task.trim()}\n\nФормат: ${format.trim() || 'chat'}`;
}
