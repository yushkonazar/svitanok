// Durable Object планувальника (07-schema §7, 01-architecture §2.1): таблиця
// `jobs` у власному SQLite-сховищі DO, ОДИН alarm = min(due_at), тік виконує
// прострочені задачі послідовно з ізоляцією збоїв (той самий інваріант B11, що
// в runCronTasks) і dedupe-ключем на появу. Cron */5 лишається сторожем: він
// НЕ виконує задачі, поки alarm живий, — лише рятує, коли alarm загубився
// (shouldWatchdogTick). Так замір джитера міряє саме alarm, а не сторожа.
//
// Як і agent-run-do.mjs, це платформний файл: імпортує `cloudflare:workers`
// (у тестах — заглушка з vitest.config.ts). Уся логіка рішень — у core.mjs.

import { DurableObject } from 'cloudflare:workers';
import { SCHEDULER_TASKS } from './tasks.mjs';
import {
  dueJobs,
  nextAlarmMs,
  occurrenceDedupeKey,
  advanceDueAt,
  shouldWatchdogTick,
  recordJitterSample,
  jitterStats,
} from './core.mjs';

/** @typedef {import('./core.mjs').SchedulerJob} SchedulerJob */

/** Вибірка джитера живе в KV-сховищі DO поруч із SQL-таблицею: це службовий
 *  ряд чисел, не предметні дані — таблиця була б церемонією (той самий
 *  аргумент, що STATE_KEY у agent-run-do.mjs). */
const JITTER_KEY = 'jitter';

export class SchedulerDO extends DurableObject {
  /** Реєстр задач — полем, а не імпортом у методах: тести підставляють свій
   *  (збійна задача, шпигуни) без мутації спільного модуля. */
  tasks = SCHEDULER_TASKS;

  #schemaReady = false;

  #ensureSchema() {
    if (this.#schemaReady) return;
    // Колонки — дослівно 07 §7; period у хвилинах (null = разова задача).
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS jobs (
         id           TEXT PRIMARY KEY,
         kind         TEXT NOT NULL,
         due_at       TEXT NOT NULL,
         period       INTEGER,
         payload_json TEXT,
         last_run_at  TEXT,
         last_status  TEXT,
         attempts     INTEGER NOT NULL DEFAULT 0,
         dedupe_key   TEXT
       )`,
    );
    this.#schemaReady = true;
  }

  /** @returns {SchedulerJob[]} */
  #loadJobs() {
    return /** @type {SchedulerJob[]} */ (
      /** @type {unknown} */ (this.ctx.storage.sql.exec('SELECT * FROM jobs').toArray())
    );
  }

  /**
   * Звести таблицю з реєстром: додати нові kind'и (перша поява — через period
   * від зараз), прибрати рядки без виконавця. Прибирання — не косметика:
   * задача без виконавця вічно падала б «невідомий kind» на кожній появі.
   * @param {number} nowMs
   */
  #syncRegistry(nowMs) {
    const known = Object.keys(this.tasks);
    const placeholders = known.map(() => '?').join(', ');
    this.ctx.storage.sql.exec(`DELETE FROM jobs WHERE kind NOT IN (${placeholders})`, ...known);
    for (const [kind, def] of Object.entries(this.tasks)) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO jobs (id, kind, due_at, period) VALUES (?, ?, ?, ?)`,
        kind,
        kind,
        new Date(nowMs + def.periodMin * 60_000).toISOString(),
        def.periodMin,
      );
    }
  }

  /**
   * Вхід cron-сторожа (worker.js, scheduled): звести реєстр і тікнути, ЛИШЕ
   * якщо alarm загубився чи прострочений понад грейс. Свіжий alarm — не наша
   * справа: тік належить йому.
   * @param {number} nowMs
   */
  async watchdogTick(nowMs) {
    this.#ensureSchema();
    this.#syncRegistry(nowMs);
    const alarmMs = await this.ctx.storage.getAlarm();
    if (!shouldWatchdogTick(alarmMs, nowMs)) return { ticked: false };
    return this.tick(nowMs, 'watchdog');
  }

  /** Платформний вхід alarm'а. @override */
  async alarm() {
    this.#ensureSchema();
    await this.tick(Date.now(), 'alarm');
  }

  /**
   * Тік: прострочені задачі послідовно, кожна у своєму try/catch; замір
   * джитера — лише для alarm-тіків (сторож приходить о своїй годині, його
   * запізнення міряло б крон, не alarm).
   * @param {number} nowMs
   * @param {'alarm' | 'watchdog'} source
   */
  async tick(nowMs, source) {
    this.#ensureSchema();
    const due = dueJobs(this.#loadJobs(), nowMs);

    if (source === 'alarm' && due.length > 0) {
      const plannedMs = /** @type {number} */ (nextAlarmMs(due));
      const samples = /** @type {number[]} */ ((await this.ctx.storage.get(JITTER_KEY)) ?? []);
      await this.ctx.storage.put(JITTER_KEY, recordJitterSample(samples, nowMs - plannedMs));
    }

    let ran = 0;
    for (const job of due) {
      const key = occurrenceDedupeKey(job.kind, job.due_at);
      if (job.dedupe_key === key) {
        // Цю появу вже виконано (напр., сторож устиг перед alarm'ом) — лише
        // посунути due_at, щоб задача не лишалась вічно простроченою.
        this.#reschedule(job, nowMs);
        continue;
      }
      const status = await this.#runJob(job);
      ran += 1;
      if (job.period == null && status === 'ok') {
        this.ctx.storage.sql.exec('DELETE FROM jobs WHERE id = ?', job.id);
        continue;
      }
      this.ctx.storage.sql.exec(
        `UPDATE jobs SET last_run_at = ?, last_status = ?, attempts = attempts + 1,
                         dedupe_key = ?, due_at = ? WHERE id = ?`,
        new Date(nowMs).toISOString(),
        status,
        key,
        job.period == null ? job.due_at : advanceDueAt(job.due_at, job.period, nowMs),
        job.id,
      );
    }

    await this.#setNextAlarm();
    return { ticked: true, due: due.length, ran };
  }

  /**
   * Виконати одну задачу з ізоляцією збою. У shadow (і будь-якому режимі, крім
   * `on`) задача без shadowSafe НЕ виконується — лише лог «виконалась би»:
   * це і є паралельний прогін поруч зі старим кроном без подвійних ефектів.
   * @param {SchedulerJob} job
   */
  async #runJob(job) {
    const def = this.tasks[job.kind];
    if (!def) return 'error: невідомий kind'; // #syncRegistry мав прибрати — видимий слід, не тиша
    const env = /** @type {Env} */ (this.env);
    if (env.ASSISTANT_V2 !== 'on' && !def.shadowSafe) {
      console.log(`scheduler shadow: ${job.kind} виконалась би (due ${job.due_at})`);
      return 'shadow';
    }
    try {
      await def.run(env);
      return 'ok';
    } catch (/** @type {any} */ e) {
      // Збій однієї задачі не зачіпає решту (інваріант B11 чинного крону).
      console.error(`scheduler: задача ${job.kind} впала (решта виконуються далі)`, e?.message);
      return `error: ${e?.message ?? 'невідомо'}`.slice(0, 200);
    }
  }

  /**
   * Посунути появу без виконання (dedupe-гілка).
   * @param {SchedulerJob} job
   * @param {number} nowMs
   */
  #reschedule(job, nowMs) {
    if (job.period == null) {
      this.ctx.storage.sql.exec('DELETE FROM jobs WHERE id = ?', job.id);
      return;
    }
    this.ctx.storage.sql.exec(
      'UPDATE jobs SET due_at = ? WHERE id = ?',
      advanceDueAt(job.due_at, job.period, nowMs),
      job.id,
    );
  }

  async #setNextAlarm() {
    const next = nextAlarmMs(this.#loadJobs());
    if (next != null) await this.ctx.storage.setAlarm(next);
  }

  /** Стан для /status (приймання етапу: планувальник + задачі + час останнього
   *  тіку) і для тестів приймання джитера. */
  async status() {
    this.#ensureSchema();
    return {
      jobs: this.#loadJobs(),
      jitter: jitterStats(/** @type {number[]} */ ((await this.ctx.storage.get(JITTER_KEY)) ?? [])),
    };
  }
}
