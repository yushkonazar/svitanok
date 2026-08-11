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

/** Мінімум, який вживає AgentRun; тести підставляють Map замість сховища. */
interface DurableObjectState {
  storage: {
    get: (key: string) => Promise<unknown>;
    put: (key: string, value: unknown) => Promise<void>;
    deleteAll: () => Promise<void>;
    setAlarm: (scheduledTime: number) => Promise<void>;
  };
}
