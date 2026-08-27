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
 * Прогін почався. run: {id, trigger, profile?, threadId?, chatId?, model?, startedMs}.
 * @param {Env} env
 * @param {{ id: string, trigger: string, profile?: string | null, threadId?: string | number | null, chatId?: number | null, model?: string | null, startedMs: number }} run
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
 * Прогін завершився (успіх, відмова або сторож). Повертає threadId/chatId
 * щойно закритого прогону (для продовження треду) або null.
 * @param {Env} env
 * @param {string} id
 * @param {{ finishedMs: number, error?: string | null, steps?: number | null }} patch
 * @returns {Promise<{ threadId: string | number | null, chatId: number | null } | null>}
 */
export async function registryFinish(env, id, patch) {
  const ns = registryNs(env);
  if (!ns) return null;
  try {
    return (await ns.getByName(RUN_REGISTRY_DO_NAME).finish(id, patch)) ?? null;
  } catch (/** @type {any} */ e) {
    console.error('run-registry: finish впав (не блокує відповідь)', e?.message);
    return null;
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

/**
 * Дані активного прогону (threadId для taint-запису). null = невідомий/збій.
 * @param {Env} env
 * @param {string} id
 * @returns {Promise<{ threadId: string | number | null, chatId: number | null } | null>}
 */
export async function registryRunInfo(env, id) {
  const ns = registryNs(env);
  if (!ns) return null;
  try {
    return (await ns.getByName(RUN_REGISTRY_DO_NAME).runInfo(id)) ?? null;
  } catch (/** @type {any} */ e) {
    console.error('run-registry: runInfo впав', e?.message);
    return null;
  }
}

/**
 * Спожити nonce запиту internal API. Fail-closed, як registryHas: збій DO =
 * false = відмова, бо результат гейтить доступ, а не журнал.
 * @param {Env} env
 * @param {string} runId
 * @param {string} nonce
 * @param {number} nowMs
 * @param {number} keepMs
 */
export async function registryConsumeNonce(env, runId, nonce, nowMs, keepMs) {
  const ns = registryNs(env);
  if (!ns) return false;
  try {
    return Boolean(
      await ns.getByName(RUN_REGISTRY_DO_NAME).consumeNonce(runId, nonce, nowMs, keepMs),
    );
  } catch (/** @type {any} */ e) {
    console.error('run-registry: consumeNonce впав - трактуємо як реплей', e?.message);
    return false;
  }
}

// ── Черга треду (ADR-039, PR-3) ──────────────────────────────────────────────
// На відміну від телеметрії, черга ГЕЙТИТЬ обробку повідомлень - збої тут
// fail-closed у бік «не стартувати другий прогін» (threadClaim → queued -1),
// але «дати відповісти хоч якось» для finish/clear (null/порожньо + гучний лог).

/**
 * Взяти тред під прогін або стати в чергу. Збій DO = {queued:-1}: краще чесна
 * відмова «спробуй ще раз», ніж два паралельні прогони в одному треді.
 * @param {Env} env
 * @param {string} threadId
 * @param {{ text: string, route: string, attempts?: number, atMs: number, chatId?: number | null, statusMessageId?: number | null }} entry
 * @returns {Promise<{ start: true } | { queued: number }>}
 */
export async function registryThreadClaim(env, threadId, entry) {
  const ns = registryNs(env);
  if (!ns) return { queued: -1 };
  try {
    return await ns
      .getByName(RUN_REGISTRY_DO_NAME)
      .threadClaim(threadId, { ...entry, attempts: entry.attempts ?? 0 });
  } catch (/** @type {any} */ e) {
    console.error('run-registry: threadClaim впав', e?.message);
    return { queued: -1 };
  }
}

/** Привʼязати прогін до треду. claimed:false = тред уже зник («стоп» у вікні
 *  pending) - викликач НЕ сміє запускати мозок; збій DO трактуємо так само
 *  (fail-closed: краще не стартувати, ніж прогін-сирота).
 *  @param {Env} env @param {string} threadId @param {string} runId
 *  @param {number | null} statusMessageId @param {number} nowMs
 *  @returns {Promise<{ claimed: boolean }>} */
export async function registryThreadSetRun(env, threadId, runId, statusMessageId, nowMs) {
  const ns = registryNs(env);
  if (!ns) return { claimed: false };
  try {
    return await ns
      .getByName(RUN_REGISTRY_DO_NAME)
      .threadSetRun(threadId, runId, statusMessageId, nowMs);
  } catch (/** @type {any} */ e) {
    console.error('run-registry: threadSetRun впав', e?.message);
    return { claimed: false };
  }
}

/** @param {Env} env @param {string} threadId @param {string | null} runId -
 *  власник claim-у (ревʼю PR-3: чужий finish не краде чергу)
 *  @returns {Promise<{ next: { text: string, route: string, attempts: number, atMs: number, chatId?: number | null, statusMessageId?: number | null } | null, notOwner?: true }>} */
export async function registryThreadFinish(env, threadId, runId) {
  const ns = registryNs(env);
  if (!ns) return { next: null };
  try {
    return await ns.getByName(RUN_REGISTRY_DO_NAME).threadFinish(threadId, runId ?? null);
  } catch (/** @type {any} */ e) {
    console.error('run-registry: threadFinish впав (черга треду може застрягти)', e?.message);
    return { next: null };
  }
}

/**
 * Сторож (ревʼю PR-3): закрити прострочені прогони (sweepStale - досі не мав
 * викликача!) і звільнити треди з мертвим claim-ом (threadSweep).
 * @param {Env} env @param {number} nowMs
 * @returns {Promise<{ staleRuns: string[], freedThreads: { threadId: string, statusMessageId: number | null, chatId: number | null, queued: number }[] }>}
 */
export async function registrySweep(env, nowMs) {
  const ns = registryNs(env);
  if (!ns) return { staleRuns: [], freedThreads: [] };
  try {
    const stub = ns.getByName(RUN_REGISTRY_DO_NAME);
    const staleRuns = (await stub.sweepStale(nowMs, RUN_STALE_MS)) ?? [];
    const freedThreads = (await stub.threadSweep(nowMs, THREAD_CLAIM_GRACE_MS)) ?? [];
    return { staleRuns, freedThreads };
  } catch (/** @type {any} */ e) {
    console.error('run-registry: sweep впав', e?.message);
    return { staleRuns: [], freedThreads: [] };
  }
}

/** Прогін довший за це - обірваний (01 §2.1: сторож > 6 хв). */
export const RUN_STALE_MS = 6 * 60_000;
/** Мертвий claim треду живе не довше: покриває і вічний pending (ізолят помер
 *  між claim і setRun), і прогін, чий фініш/звіт загубився. */
export const THREAD_CLAIM_GRACE_MS = 90_000;

/** @param {Env} env @param {string} threadId */
export async function registryThreadClear(env, threadId) {
  const ns = registryNs(env);
  if (!ns) return { activeRunId: null, statusMessageId: null, cleared: 0 };
  try {
    return await ns.getByName(RUN_REGISTRY_DO_NAME).threadClear(threadId);
  } catch (/** @type {any} */ e) {
    console.error('run-registry: threadClear впав', e?.message);
    return { activeRunId: null, statusMessageId: null, cleared: 0 };
  }
}

/** @param {Env} env @param {string} threadId
 *  @param {{ text: string, route: string, attempts: number, atMs: number, statusMessageId?: number | null }} entry */
export async function registryThreadRetry(env, threadId, entry) {
  const ns = registryNs(env);
  if (!ns) return;
  try {
    await ns.getByName(RUN_REGISTRY_DO_NAME).threadRetry(threadId, entry);
  } catch (/** @type {any} */ e) {
    console.error('run-registry: threadRetry впав (запит втрачено з черги)', e?.message);
  }
}

/** @param {Env} env @param {string} threadId
 *  @returns {Promise<{ next: { text: string, route: string, attempts: number, atMs: number, chatId?: number | null, statusMessageId?: number | null } | null }>} */
export async function registryThreadKickNext(env, threadId) {
  const ns = registryNs(env);
  if (!ns) return { next: null };
  try {
    return await ns.getByName(RUN_REGISTRY_DO_NAME).threadKickNext(threadId);
  } catch (/** @type {any} */ e) {
    console.error('run-registry: threadKickNext впав', e?.message);
    return { next: null };
  }
}

/** @param {Env} env */
export async function registryThreadsSnapshot(env) {
  const ns = registryNs(env);
  if (!ns) return {};
  try {
    return await ns.getByName(RUN_REGISTRY_DO_NAME).threadsSnapshot();
  } catch (/** @type {any} */ e) {
    console.error('run-registry: threadsSnapshot впав', e?.message);
    return {};
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
