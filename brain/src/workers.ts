// Працівники (07 §5): працівник - окремий прогін SDK зі СВОЇМ системним
// промптом, моделлю і стелею ходів. Розмови власника він не бачить: на вхід
// іде лише задача й формат, назад - текст. Тут опис працівника (дзеркало
// front-matter agents/<name>.md) і його запуск.
//
// Етап 2 підключає одного - quick, він же профіль швидкої смуги: інструкція
// приїжджає в тілі /run, тож шлях працівника щодня перевіряється в проді ще
// до того, як на етапі 4 ним поїдуть решта десять.

import type { EngineOutcome, EngineRunOptions, RunEngine } from './agent.js';

/** `model:` з front-matter → id моделі API. Перелік той самий, що валідує
 *  ядро (web/core/instructions.mjs: haiku | sonnet | -). */
export const WORKER_MODEL_IDS = {
  haiku: 'claude-haiku-4-5',
  sonnet: 'claude-sonnet-5',
} as const;

export type WorkerModel = keyof typeof WORKER_MODEL_IDS;

/** Дзеркало front-matter працівника (07 §5: front-matter → AgentDefinition). */
export interface WorkerDef {
  name: string;
  /** Тіло agents/<name>.md - системний промпт працівника. */
  prompt: string;
  model: WorkerModel;
  /** `max_steps` - стеля ходів SDK. */
  maxSteps: number;
  /** `tools` у mcp-іменах; порожньо - працівник без інструментів. */
  toolNames: string[];
  /** `tainted_output` - вихід працівника є зовнішнім вмістом. Поки лише
   *  описове поле: успадкування taint приїде разом із рештою працівників, а
   *  єдиний підключений (quick) має false, тож розбіжності немає. */
  taintedOutput: boolean;
}

/**
 * quick (agents/quick.md) - єдиний підключений працівник етапу 2. Значення -
 * дзеркало front-matter файлу; парність тримає тест brain-workers, тож
 * правка файлу без правки цього обʼєкта червонить CI, а не тихо змінює
 * поведінку швидкої смуги.
 */
export const QUICK_WORKER: Omit<WorkerDef, 'prompt'> = {
  name: 'quick',
  model: 'haiku',
  maxSteps: 1,
  toolNames: [],
  taintedOutput: false,
};

export interface WorkerRunContext {
  abortSignal: AbortSignal;
  onToolCall: EngineRunOptions['onToolCall'];
  onPartialText: EngineRunOptions['onPartialText'];
  /** Чи є куди стрімити частковий текст: у профілю quick є статусник, у
   *  працівника всередині chat його немає. */
  streamPartials: boolean;
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
      maxTurns: def.maxSteps,
      toolNames: def.toolNames,
      resumeSessionId: null,
      streamPartials: ctx.streamPartials,
      abortSignal: ctx.abortSignal,
      onToolCall: ctx.onToolCall,
      onPartialText: ctx.onPartialText,
    },
    task,
  );
}
