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

/** @typedef {{ startedMs: number, trigger: string, profile: string | null, threadId: string | number | null, chatId: number | null, staleMs?: number }} ActiveRun */

const ACTIVE_KEY = 'active';
/** Нещодавно завершені run: дозволяють delivery telemetry retry, але не
 * повертають право викликати tools після фінішу. */
const COMPLETED_KEY = 'completed';
const COMPLETED_TTL_MS = 30 * 60_000;

/** Спожиті nonce internal API: {`runId:nonce` -> expiresMs}. Окремий ключ від
 *  активних прогонів — інший життєвий цикл і інший писар (router, не агент). */
const NONCES_KEY = 'nonces';

/** Черги тредів (ADR-039): {threadId -> {activeRunId, statusMessageId, chatId, sinceMs, queue}}. */
const THREADS_KEY = 'threads';
/** Стеля черги одного треду: далі чесна відмова, не безмежний хвіст. */
export const THREAD_QUEUE_MAX = 5;
/** Сентинел «тред взято, runId ще не відомий» (між claim і setRun). */
export const RUN_PENDING = 'pending';

export class RunRegistryDO extends DurableObject {
  /** @returns {Promise<Record<string, ActiveRun>>} */
  async #active() {
    return /** @type {Record<string, ActiveRun>} */ (
      (await this.ctx.storage.get(ACTIVE_KEY)) ?? {}
    );
  }

  /** @returns {Promise<Record<string, { entry: ActiveRun, expiresMs: number }>>} */
  async #completed(nowMs = Date.now()) {
    const completed = /** @type {Record<string, { entry: ActiveRun, expiresMs: number }>} */ (
      (await this.ctx.storage.get(COMPLETED_KEY)) ?? {}
    );
    let dirty = false;
    for (const [id, value] of Object.entries(completed)) {
      if (value.expiresMs <= nowMs) {
        delete completed[id];
        dirty = true;
      }
    }
    if (dirty) await this.ctx.storage.put(COMPLETED_KEY, completed);
    return completed;
  }

  /** D1 — telemetry/audit projection. Відмова D1 не має лишати активний run
   * без можливості завершитися у control plane DO. */
  #db() {
    const db = /** @type {Env} */ (this.env).DB;
    if (!db) throw new Error('привʼязки DB немає — телеметрія runs неможлива');
    return db;
  }

  /**
   * Прогін почався: у активний набір + рядок у D1 `runs`. ON CONFLICT DO
   * NOTHING — повторний begin того самого id (ретрай викликача) не падає і
   * не дублює рядок.
   * @param {{ id: string, trigger: string, profile?: string | null, threadId?: string | number | null, chatId?: number | null, model?: string | null, startedMs: number, staleMs?: number }} run
   */
  async begin(run) {
    const active = await this.#active();
    if (!active[run.id]) {
      active[run.id] = {
        startedMs: run.startedMs,
        trigger: run.trigger,
        profile: run.profile ?? null,
        threadId: run.threadId ?? null,
        // chatId прогону: TELEGRAM_CHAT_ID не єдиний чат системи.
        chatId: run.chatId ?? null,
        ...(Number.isFinite(run.staleMs) ? { staleMs: Number(run.staleMs) } : {}),
      };
      // Це authoritative write: якщо він впаде, клієнт не стартує brain.
      await this.ctx.storage.put(ACTIVE_KEY, active);
    }
    try {
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
    } catch (/** @type {any} */ e) {
      console.error(`run-registry: D1 telemetry begin ${run.id} впав`, e?.message);
    }
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
    const completed = await this.#completed(patch.finishedMs);
    const entry = active[id] ?? completed[id]?.entry;
    const newlyFinished = Boolean(active[id]);
    const startedMs = entry?.startedMs;
    if (newlyFinished) {
      completed[id] = {
        entry: /** @type {ActiveRun} */ (entry),
        expiresMs: patch.finishedMs + COMPLETED_TTL_MS,
      };
      // Спочатку лишаємо retriable completion record, потім забираємо право
      // на tools. Обидва записи серіалізує один DO.
      await this.ctx.storage.put(COMPLETED_KEY, completed);
      delete active[id];
      await this.ctx.storage.put(ACTIVE_KEY, active);
    }
    try {
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
    } catch (/** @type {any} */ e) {
      console.error(`run-registry: D1 telemetry finish ${id} впав`, e?.message);
    }
    // Дані щойно закритого прогону - викликачу (handleRuns продовжує тред без
    // окремого runInfo-виклику; ревʼю PR-3, efficiency).
    return entry ? { threadId: entry.threadId, chatId: entry.chatId ?? null, newlyFinished } : null;
  }

  /** Чи прогін зараз активний — перевірка run_id для internal API (PR-5).
   *  @param {string} id */
  async has(id) {
    return Boolean((await this.#active())[id]);
  }

  /** Для idempotent final report: завершений run відомий лише вузький TTL.
   * @param {string} id @param {number} [nowMs] */
  async hasOrCompleted(id, nowMs = Date.now()) {
    return Boolean((await this.#active())[id]) || Boolean((await this.#completed(nowMs))[id]);
  }

  /** Дані активного прогону (threadId для taint-запису, chatId для deliver,
   *  statusMessageId - щоб фінал замінив чернетку «▸ …», а не лишив її з
   *  обірваним партіалом). null = немає.
   *  @param {string} id */
  async runInfo(id) {
    const run = (await this.#active())[id];
    if (!run) return null;
    // Чернетка належить ТРЕДУ, не прогону: віддаємо її лише тому прогону, що
    // зараз активний у цьому треді. Інакше запізнілий deliver уже закритого
    // прогону відредагував би чернетку наступного.
    const t = run.threadId == null ? null : (await this.#threads())[String(run.threadId)];
    return {
      threadId: run.threadId,
      chatId: run.chatId ?? null,
      statusMessageId: t?.activeRunId === id ? (t?.statusMessageId ?? null) : null,
    };
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
      .filter(([, r]) => nowMs - r.startedMs > (r.staleMs ?? staleMs))
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

  // ── Черга треду (ADR-039, етап 2 PR-3; переписано за ревʼю PR-3) ─────────
  // Один активний прогін на тред (01 §2.1): claim бере тред або ставить у
  // чергу; finish віддає наступний запис І ПЕРЕВІРЯЄ ВЛАСНИКА (summarize-звіт
  // чужого прогону не сміє красти claim). sinceMs + threadSweep - сторож
  // тредів: best-effort звіт мозку більше не єдиний знімач claim-у. Стан -
  // один ключ на всі треди (тредів у власника одиниці). Глобальні слоти ≤2
  // тут НЕ дублюються - їх тримає мозок (429 busy → черга викликачем).

  /** @typedef {{ text: string, route: string, attempts: number, atMs: number, chatId?: number | null, statusMessageId?: number | null }} QueueEntry */
  /** @typedef {{ activeRunId: string | null, statusMessageId: number | null, chatId: number | null, sinceMs: number, queue: QueueEntry[] }} ThreadState */

  /** @returns {Promise<Record<string, ThreadState>>} */
  async #threads() {
    return /** @type {any} */ ((await this.ctx.storage.get(THREADS_KEY)) ?? {});
  }

  /** Голова черги → під прогін, або звільнення/видалення порожнього треду.
   *  @param {Record<string, ThreadState>} threads @param {string} threadId @param {ThreadState} t */
  #advance(threads, threadId, t) {
    const next = t.queue.shift() ?? null;
    if (next) {
      t.activeRunId = RUN_PENDING;
      t.statusMessageId = next.statusMessageId ?? null;
      t.chatId = next.chatId ?? null;
      t.sinceMs = next.atMs;
      threads[threadId] = t;
    } else {
      delete threads[threadId];
    }
    return next;
  }

  /**
   * Взяти тред під прогін або стати в чергу.
   * @param {string} threadId
   * @param {QueueEntry} entry
   * @returns {Promise<{ start: true } | { queued: number }>}
   */
  async threadClaim(threadId, entry) {
    const threads = await this.#threads();
    const t = threads[threadId] ?? {
      activeRunId: null,
      statusMessageId: null,
      chatId: null,
      sinceMs: 0,
      queue: [],
    };
    // Старт лише коли тред вільний І черга порожня: тред без активного прогону,
    // але з чергою - це «чекаємо ретраю» (S-0-7), нове повідомлення стає ЗА ним.
    if (t.activeRunId != null || t.queue.length > 0) {
      if (t.queue.length >= THREAD_QUEUE_MAX) return { queued: -1 };
      t.queue.push({ ...entry, attempts: entry.attempts ?? 0 });
      threads[threadId] = t;
      await this.ctx.storage.put(THREADS_KEY, threads);
      return { queued: t.queue.length };
    }
    t.activeRunId = RUN_PENDING;
    t.statusMessageId = entry.statusMessageId ?? null;
    t.chatId = entry.chatId ?? null;
    t.sinceMs = entry.atMs;
    threads[threadId] = t;
    await this.ctx.storage.put(THREADS_KEY, threads);
    return { start: true };
  }

  /**
   * Невдалий старт (мозок недоступний, S-0-7): запис повертається на ПОЧАТОК
   * черги, тред звільняється - «підняття» (threadKickNext з задачі
   * brain-health) спробує знову, а нові повідомлення стають позаду.
   * @param {string} threadId
   * @param {QueueEntry} entry
   */
  async threadRetry(threadId, entry) {
    const threads = await this.#threads();
    const t = threads[threadId] ?? {
      activeRunId: null,
      statusMessageId: null,
      chatId: null,
      sinceMs: 0,
      queue: [],
    };
    t.queue.unshift(entry);
    t.activeRunId = null;
    t.statusMessageId = null;
    threads[threadId] = t;
    await this.ctx.storage.put(THREADS_KEY, threads);
  }

  /**
   * «Підняти» вільний тред із непорожньою чергою: взяти голову черги під
   * прогін. Тред з активним прогоном - тихий null (нічого піднімати).
   * @param {string} threadId
   */
  async threadKickNext(threadId) {
    const threads = await this.#threads();
    const t = threads[threadId];
    if (!t || t.activeRunId != null) return { next: null };
    const next = this.#advance(threads, threadId, t);
    await this.ctx.storage.put(THREADS_KEY, threads);
    return { next };
  }

  /**
   * Прогін треду стартував по-справжньому. claimed:false = треду вже немає
   * («стоп» у вікні pending, ревʼю PR-3) - викликач мусить НЕ запускати мозок.
   * Ескалація легітимно переписує activeRunId ще живого claim-у.
   * @param {string} threadId @param {string} runId
   * @param {number | null} statusMessageId @param {number} nowMs
   */
  async threadSetRun(threadId, runId, statusMessageId, nowMs) {
    const threads = await this.#threads();
    const t = threads[threadId];
    if (!t) return { claimed: false };
    t.activeRunId = runId;
    t.statusMessageId = statusMessageId ?? null;
    t.sinceMs = nowMs;
    await this.ctx.storage.put(THREADS_KEY, threads);
    return { claimed: true };
  }

  /**
   * Прогін треду завершився: віддати наступний запис черги або звільнити тред.
   * ВЛАСНІСТЬ (ревʼю PR-3): finish діє лише коли runId = activeRunId - звіт
   * summarize-прогону (чи будь-якого чужого) не краде claim і не знімає чергу.
   * Тред без claim - тихий null.
   * @param {string} threadId
   * @param {string | null} runId
   * @returns {Promise<{ next: QueueEntry | null, notOwner?: true }>}
   */
  async threadFinish(threadId, runId) {
    const threads = await this.#threads();
    const t = threads[threadId];
    if (!t) return { next: null };
    if (runId != null && t.activeRunId !== runId) return { next: null, notOwner: true };
    const next = this.#advance(threads, threadId, t);
    await this.ctx.storage.put(THREADS_KEY, threads);
    return { next };
  }

  /** «стоп»: очистити чергу і віддати активний прогін для abort.
   *  @param {string} threadId */
  async threadClear(threadId) {
    const threads = await this.#threads();
    const t = threads[threadId];
    if (!t) return { activeRunId: null, statusMessageId: null, cleared: 0 };
    const out = {
      activeRunId: t.activeRunId === RUN_PENDING ? null : t.activeRunId,
      statusMessageId: t.statusMessageId,
      cleared: t.queue.length,
    };
    delete threads[threadId];
    await this.ctx.storage.put(THREADS_KEY, threads);
    return out;
  }

  /**
   * Сторож тредів (ревʼю PR-3: раніше best-effort звіт мозку був ЄДИНИМ
   * знімачем claim-у - один мережевий збій блокував тред назавжди). Тред,
   * чий activeRunId не значиться в активних (або вічний pending) довше за
   * graceMs, - звільняється; черга лишається і підніметься kick-ом.
   * Повертає звільнені треди зі статусниками - викликач чесно скаже власнику.
   * @param {number} nowMs
   * @param {number} graceMs
   */
  async threadSweep(nowMs, graceMs) {
    const threads = await this.#threads();
    const active = await this.#active();
    /** @type {{ threadId: string, statusMessageId: number | null, chatId: number | null, queued: number }[]} */
    const freed = [];
    let dirty = false;
    for (const [threadId, t] of Object.entries(threads)) {
      if (t.activeRunId == null) continue;
      const runAlive = t.activeRunId !== RUN_PENDING && Boolean(active[t.activeRunId]);
      if (runAlive) continue;
      if (nowMs - (t.sinceMs ?? 0) <= graceMs) continue;
      freed.push({
        threadId,
        statusMessageId: t.statusMessageId,
        chatId: t.chatId ?? null,
        queued: t.queue.length,
      });
      t.activeRunId = null;
      t.statusMessageId = null;
      if (t.queue.length === 0) delete threads[threadId];
      dirty = true;
    }
    if (dirty) await this.ctx.storage.put(THREADS_KEY, threads);
    return freed;
  }

  /** Стан тредів (для «підняття» черг після відновлення мозку і /status). */
  async threadsSnapshot() {
    return await this.#threads();
  }
}
