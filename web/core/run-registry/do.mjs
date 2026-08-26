// Durable Object реєстру прогонів (01-architecture §2.1, етап 1, PR-4):
// авторитетний список АКТИВНИХ прогонів + запис телеметрії в D1 `runs`
// (07-schema §1). На цьому етапі — ЛИШЕ ЗАПИС для старого агента: слоти (≤2)
// і handshake мозку зʼявляться, коли буде кому їх тримати (етап 2); перевірку
// «run_id відомий реєстру» для internal API (PR-5) вже дає has().
//
// Активний набір — один KV-ключ у сховищі DO, не SQL-таблиця: одночасних
// прогонів одиниці, і таблиця була б церемонією (той самий аргумент, що в
// agent-run-do.mjs). Історія ж живе в D1 - її читатимуть звіти і /status.
//
// Як і agent-run-do.mjs, файл платформний: імпортує cloudflare:workers
// (у тестах — заглушка з vitest.config.ts).

import { DurableObject } from 'cloudflare:workers';

/** @typedef {{ startedMs: number, trigger: string, profile: string | null, threadId: string | number | null }} ActiveRun */

const ACTIVE_KEY = 'active';

/** Спожиті nonce internal API: {`runId:nonce` -> expiresMs}. Окремий ключ від
 *  активних прогонів — інший життєвий цикл і інший писар (router, не агент). */
const NONCES_KEY = 'nonces';

export class RunRegistryDO extends DurableObject {
  /** @returns {Promise<Record<string, ActiveRun>>} */
  async #active() {
    return /** @type {Record<string, ActiveRun>} */ (
      (await this.ctx.storage.get(ACTIVE_KEY)) ?? {}
    );
  }

  /** Телеметрія без D1 неможлива — і це мусить бути видно, а не тихо зникати
   *  (клієнт зловить виняток і залишить слід у логах). */
  #db() {
    const db = /** @type {Env} */ (this.env).DB;
    if (!db) throw new Error('привʼязки DB немає — телеметрія runs неможлива');
    return db;
  }

  /**
   * Прогін почався: у активний набір + рядок у D1 `runs`. ON CONFLICT DO
   * NOTHING — повторний begin того самого id (ретрай викликача) не падає і
   * не дублює рядок.
   * @param {{ id: string, trigger: string, profile?: string | null, threadId?: string | number | null, model?: string | null, startedMs: number }} run
   */
  async begin(run) {
    const active = await this.#active();
    active[run.id] = {
      startedMs: run.startedMs,
      trigger: run.trigger,
      profile: run.profile ?? null,
      threadId: run.threadId ?? null,
    };
    await this.ctx.storage.put(ACTIVE_KEY, active);
    await this.#db()
      .prepare(
        `INSERT INTO runs (id, trigger, profile, thread_id, model, started_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        run.id,
        run.trigger,
        run.profile ?? null,
        run.threadId == null ? null : String(run.threadId),
        run.model ?? null,
        new Date(run.startedMs).toISOString(),
      )
      .run();
    return { active: Object.keys(active).length };
  }

  /**
   * Прогін завершився. duration_ms рахується від startedMs активного запису;
   * якщо запис загубився (рестарт ізоляту між begin і finish) — лишається
   * NULL, рядок в D1 однаково закривається. `finished_at IS NULL` робить
   * фініш ідемпотентним: другий виклик (сторож наздогнав уже закритий
   * прогін) нічого не переписує.
   * @param {string} id
   * @param {{ finishedMs: number, error?: string | null, steps?: number | null }} patch
   */
  async finish(id, patch) {
    const active = await this.#active();
    const startedMs = active[id]?.startedMs;
    delete active[id];
    await this.ctx.storage.put(ACTIVE_KEY, active);
    await this.#db()
      .prepare(
        `UPDATE runs SET finished_at = ?, duration_ms = ?, error = ?, steps = COALESCE(?, steps)
         WHERE id = ? AND finished_at IS NULL`,
      )
      .bind(
        new Date(patch.finishedMs).toISOString(),
        Number.isFinite(startedMs) ? patch.finishedMs - /** @type {number} */ (startedMs) : null,
        patch.error ?? null,
        patch.steps ?? null,
        id,
      )
      .run();
  }

  /** Чи прогін зараз активний — перевірка run_id для internal API (PR-5).
   *  @param {string} id */
  async has(id) {
    return Boolean((await this.#active())[id]);
  }

  /**
   * Спожити nonce запиту internal API: true = вперше (запит пускаємо),
   * false = уже бачили (реплей у вікні TTL). Атомарність дає сам DO
   * (виклики серіалізовані). Спожиті чистяться за віком на кожному виклику —
   * набір обмежений кількістю запитів за 2×TTL, тобто десятками.
   * @param {string} runId
   * @param {string} nonce
   * @param {number} nowMs
   * @param {number} keepMs — скільки памʼятати (2×TTL підпису: доки підпис
   *   узагалі міг би пройти, памʼять про nonce мусить жити)
   */
  async consumeNonce(runId, nonce, nowMs, keepMs) {
    const seen = /** @type {Record<string, number>} */ (
      (await this.ctx.storage.get(NONCES_KEY)) ?? {}
    );
    for (const [key, expiresMs] of Object.entries(seen)) {
      if (expiresMs <= nowMs) delete seen[key];
    }
    const key = `${runId}:${nonce}`;
    if (key in seen) return false;
    seen[key] = nowMs + keepMs;
    await this.ctx.storage.put(NONCES_KEY, seen);
    return true;
  }

  /**
   * Сторож обірваних: активні понад staleMs закриваються з error='timeout'.
   * Повертає закриті id — викликач вирішує, чи алертити.
   * @param {number} nowMs
   * @param {number} staleMs
   */
  async sweepStale(nowMs, staleMs) {
    const active = await this.#active();
    const stale = Object.entries(active)
      .filter(([, r]) => nowMs - r.startedMs > staleMs)
      .map(([id]) => id);
    for (const id of stale) {
      try {
        await this.finish(id, { finishedMs: nowMs, error: 'timeout' });
      } catch (/** @type {any} */ e) {
        // Збій D1 на одному id не сміє обірвати решту прибирання (той самий
        // інваріант ізоляції, що в тіку планувальника).
        console.error(`run-registry: sweep не закрив ${id}`, e?.message);
      }
    }
    return stale;
  }

  /** Стан для /status. */
  async snapshot() {
    return { active: await this.#active() };
  }
}
