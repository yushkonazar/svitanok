// Тонкий клієнт RunRegistry для коду Worker'а (етап 1, PR-4). Телеметрія —
// best-effort з обох боків: гейт за прапорцем (при off реєстр не існує для
// коду взагалі), а будь-який збій DO — console.error і далі, бо запис у
// журнал не сміє валити чи гальмувати сам прогін (той самий принцип, що в
// markRunStarted: «марка потрібна лише сторожу»).
//
// Файл платформно-чистий (без cloudflare:workers): його можна імпортувати
// звідусіль, включно з кодом, який тести ганяють без заглушки workerd.

/** Єдиний інстанс реєстру. Константа, не літерал у викликача: розсинхрон
 *  імені означав би тихий другий інстанс із порожнім журналом. */
export const RUN_REGISTRY_DO_NAME = 'run-registry';

const enabled = (/** @type {Env} */ env) =>
  env.ASSISTANT_V2 === 'shadow' || env.ASSISTANT_V2 === 'on';

/**
 * Прогін почався. run: {id, trigger, profile?, threadId?, model?, startedMs}.
 * @param {Env} env
 * @param {{ id: string, trigger: string, profile?: string | null, threadId?: string | number | null, model?: string | null, startedMs: number }} run
 */
export async function registryBegin(env, run) {
  const ns = registryNs(env);
  if (!ns) return;
  try {
    await ns.getByName(RUN_REGISTRY_DO_NAME).begin(run);
  } catch (/** @type {any} */ e) {
    console.error('run-registry: begin впав (прогін не зачеплено)', e?.message);
  }
}

/**
 * Прогін завершився (успіх, відмова або сторож).
 * @param {Env} env
 * @param {string} id
 * @param {{ finishedMs: number, error?: string | null, steps?: number | null }} patch
 */
export async function registryFinish(env, id, patch) {
  const ns = registryNs(env);
  if (!ns) return;
  try {
    await ns.getByName(RUN_REGISTRY_DO_NAME).finish(id, patch);
  } catch (/** @type {any} */ e) {
    console.error('run-registry: finish впав (не блокує відповідь)', e?.message);
  }
}

/**
 * Чи прогін живий у реєстрі (перевірка run_id для internal API, PR-5).
 * На відміну від begin/finish, збій тут = false, НЕ пропуск: невідомість -
 * це відмова (fail-closed), бо результат гейтить доступ, а не журнал.
 * @param {Env} env
 * @param {string} id
 */
export async function registryHas(env, id) {
  const ns = registryNs(env);
  if (!ns) return false;
  try {
    return Boolean(await ns.getByName(RUN_REGISTRY_DO_NAME).has(id));
  } catch (/** @type {any} */ e) {
    console.error('run-registry: has впав - трактуємо як невідомий прогін', e?.message);
    return false;
  }
}

/** @param {Env} env */
function registryNs(env) {
  if (!enabled(env)) return null;
  const ns = env.RUN_REGISTRY;
  if (typeof ns?.getByName !== 'function') {
    // Прапорець увімкнено, привʼязки немає — помилка конфігурації, вголос.
    console.error(`run-registry: ASSISTANT_V2=${env.ASSISTANT_V2}, але RUN_REGISTRY не привʼязано`);
    return null;
  }
  return ns;
}
