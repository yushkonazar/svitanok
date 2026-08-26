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

/** Лічильник рятунків сторожа — чесність заміру джитера: втрачений alarm
 *  семпла не лишає (появу виконує сторож, а спізнілий alarm бачить порожні
 *  due), тож без цього числа p95/max систематично занижували б саме той
 *  найгірший хвіст, який замір мав показати. */
const RESCUES_KEY = 'watchdogRescues';

/** Знімок реєстру, з яким востаннє синхронізовано таблицю jobs: сівба на
 *  кожен 5-хвилинний тік була б DELETE+N×INSERT назавжди заради no-op. */
const REGISTRY_KEY = 'registrySnapshot';

/** Єдиний інстанс планувальника. Імʼя — константа, а не літерал у викликача:
 *  розсинхрон імені означав би тихий ДРУГИЙ інстанс із порожньою таблицею. */
export const SCHEDULER_DO_NAME = 'scheduler';

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
   * No-op, поки реєстр не змінився (знімок у KV): інакше це DELETE+N×INSERT
   * на кожен 5-хвилинний тік назавжди — заради нічого.
   * @param {number} nowMs
   */
  async #syncRegistry(nowMs) {
    const known = Object.keys(this.tasks).sort();
    // Знімок містить і periodMin: інакше зміна періоду наявного kind не
    // перетинала б early-return, і стара каденція жила б у таблиці вічно.
    const snapshot = known.map((k) => `${k}:${this.tasks[k]?.periodMin}`).join(',');
    if ((await this.ctx.storage.get(REGISTRY_KEY)) === snapshot) return;
    if (known.length === 0) {
      // `NOT IN ()` — синтаксична помилка SQLite; порожній реєстр = порожня таблиця.
      this.ctx.storage.sql.exec('DELETE FROM jobs');
    } else {
      const placeholders = known.map(() => '?').join(', ');
      this.ctx.storage.sql.exec(`DELETE FROM jobs WHERE kind NOT IN (${placeholders})`, ...known);
    }
    for (const [kind, def] of Object.entries(this.tasks)) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO jobs (id, kind, due_at, period) VALUES (?, ?, ?, ?)`,
        kind,
        kind,
        new Date(nowMs + def.periodMin * 60_000).toISOString(),
        def.periodMin,
      );
      // INSERT OR IGNORE наявний рядок не чіпає — період звіряємо окремо.
      // `period IS NOT NULL` береже разові задачі того ж kind від перетворення
      // на періодичні.
      this.ctx.storage.sql.exec(
        'UPDATE jobs SET period = ? WHERE kind = ? AND period IS NOT NULL AND period != ?',
        def.periodMin,
        kind,
        def.periodMin,
      );
    }
    await this.ctx.storage.put(REGISTRY_KEY, snapshot);
    // Нова задача могла отримати найранішу появу — інваріант alarm=min(due_at)
    // мусить вижити і на гілці сторожа «alarm свіжий, тікати не треба».
    await this.#setNextAlarm();
  }

  /**
   * Вхід cron-сторожа (worker.js, scheduled): звести реєстр і тікнути, ЛИШЕ
   * якщо alarm загубився чи прострочений понад грейс. Свіжий alarm — не наша
   * справа: тік належить йому.
   * @param {number} nowMs
   */
  async watchdogTick(nowMs) {
    // Тік уже в польоті (сторож зайшов у вікно await задачі alarm-тіка) —
    // це не «загублений alarm», і в лічильник рятунків воно йти не мусить.
    if (this.#ticking) return { ticked: false };
    this.#ensureSchema();
    await this.#syncRegistry(nowMs);
    const alarmMs = await this.ctx.storage.getAlarm();
    if (!shouldWatchdogTick(alarmMs, nowMs)) return { ticked: false };
    // Рятунок із простроченими появами = alarm їх проґавив. Семпла джитера
    // від нього не буде (появи виконає сторож), тож слід — у лічильнику.
    if (alarmMs != null && dueJobs(this.#loadJobs(), nowMs).length > 0) {
      const rescues = /** @type {number} */ ((await this.ctx.storage.get(RESCUES_KEY)) ?? 0);
      await this.ctx.storage.put(RESCUES_KEY, rescues + 1);
    }
    return this.tick(nowMs, 'watchdog');
  }

  /**
   * Платформний вхід alarm'а. При ASSISTANT_V2 поза shadow/on — згаснути БЕЗ
   * перепостановки: інакше одного разу озброєний у shadow alarm самовідтворю-
   * вався б вічно (tick → setAlarm → tick), і «off» прапорця не вимикав би
   * планувальник насправді. Сторож (worker.js) при off теж мовчить, тож DO
   * просто засинає, доки прапорець не повернуть.
   * @override
   */
  async alarm() {
    const env = /** @type {Env} */ (this.env);
    if (env.ASSISTANT_V2 !== 'shadow' && env.ASSISTANT_V2 !== 'on') {
      console.log(`scheduler: alarm згасає — ASSISTANT_V2=${env.ASSISTANT_V2 ?? 'off'}`);
      return;
    }
    this.#ensureSchema();
    await this.tick(Date.now(), 'alarm');
  }

  /** Тік уже виконується. Input-gate DO відкривається на await зовнішніх
   *  викликів усередині задачі (fetch у Telegram/GitHub), і в це вікно може
   *  зайти сторож: alarm на той момент уже спожито (getAlarm=null), dedupe_key
   *  ще не записано — без прапорця та сама поява виконалась би двічі. Поле, а
   *  не storage: подієвий цикл DO однопотоковий, читання/запис прапорця
   *  атомарні, а після падіння ізоляту він чесно скидається разом з інстансом. */
  #ticking = false;

  /**
   * Тік: прострочені задачі послідовно, кожна у своєму try/catch; замір
   * джитера — лише для alarm-тіків (сторож приходить о своїй годині, його
   * запізнення міряло б крон, не alarm).
   * @param {number} nowMs
   * @param {'alarm' | 'watchdog'} source
   */
  async tick(nowMs, source) {
    if (this.#ticking) return { ticked: false, due: 0, ran: 0 };
    this.#ticking = true;
    try {
      return await this.#tickLocked(nowMs, source);
    } finally {
      this.#ticking = false;
    }
  }

  /**
   * @param {number} nowMs
   * @param {'alarm' | 'watchdog'} source
   */
  async #tickLocked(nowMs, source) {
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
   *  тіку) і для тестів приймання джитера. watchdogRescues поруч зі
   *  статистикою — без нього p95/max мовчали б про втрачені alarm'и. */
  async status() {
    this.#ensureSchema();
    return {
      jobs: this.#loadJobs(),
      jitter: jitterStats(/** @type {number[]} */ ((await this.ctx.storage.get(JITTER_KEY)) ?? [])),
      watchdogRescues: /** @type {number} */ ((await this.ctx.storage.get(RESCUES_KEY)) ?? 0),
    };
  }
}
