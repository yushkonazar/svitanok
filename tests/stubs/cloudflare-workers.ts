/* Заглушка вбудованого модуля `cloudflare:workers` для тестів.
 *
 * Тести ганяють worker.js напряму в Node (vitest, environment:'node'), а
 * `cloudflare:workers` існує лише в workerd — без підміни впав би САМ ІМПОРТ,
 * і разом із ним усі 68 файлів тестів, а не лише ті, що торкаються DO.
 *
 * Підміна чесна: справжній базовий клас DurableObject для нашого коду робить
 * рівно це — кладе ctx/env на this (жодного іншого його API ми не вживаємо).
 * Прив'язка налаштована у vitest.config.ts; на збірку Cloudflare вона не
 * впливає — там модуль справжній. */

export class DurableObject<Env = unknown> {
  ctx: DurableObjectState;
  env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** Базовий клас Workflow (етап 3 PR-8, DayPlanChain): так само лише ctx/env
 *  на this. Машина станів ланцюга тестується напряму (runDayPlanChain) з
 *  фейковим step - клас потрібен тесту лише щоб імпорт worker.js не впав. */
export class WorkflowEntrypoint<Env = unknown, Params = unknown> {
  ctx: unknown;
  env: Env;

  constructor(ctx: unknown, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async run(_event: { payload: Params }, _step: unknown): Promise<unknown> {
    return undefined;
  }
}

/** Мінімум, який вживають AgentRun і SchedulerDO; тести підставляють Map
 *  замість KV-сховища і node:sqlite замість SQL-сховища. getAlarm/sql —
 *  опційні, щоб фейки AgentRun-тестів (без SQL) лишались валідними. */
interface DurableObjectState {
  storage: {
    get: (key: string) => Promise<unknown>;
    put: (key: string, value: unknown) => Promise<void>;
    deleteAll: () => Promise<void>;
    setAlarm: (scheduledTime: number) => Promise<void>;
    getAlarm?: () => Promise<number | null>;
    sql?: { exec: (query: string, ...bindings: unknown[]) => { toArray: () => unknown[] } };
  };
}
