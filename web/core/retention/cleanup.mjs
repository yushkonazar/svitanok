// Ретенція (07 §1 колонка «Ретенція», ADR-018, 07 §7 `retention-cleanup`):
// щодня о 04:00 Києва прибрати те, чому вийшов строк.
//
// Список тут - ДАНІ, а не гілки коду: рядок на таблицю з полем часу і
// строком. Так його видно цілком, і забути таблицю можна тільки свідомо -
// контракт-тест звіряє його зі схемою міграцій.
//
// Що НЕ прибирається (і це навмисно, а не пропуск): дайджести чатів,
// підписки, ідеї, бажання, поїздки, колекції, записи, звіти, факти,
// інструкції, плани дня, згортки сесій. Строк «безстроково» з 07 §1 - це
// рішення власника, а не недогляд.
//
// FTS-таблиці standalone (ADR-036), тож індекс чиститься окремим твердженням
// за тими самими id: інакше пошук ще довго знаходив би стерті повідомлення.

import { kyivDateKey, kyivHour } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import {
  eraseExpiredManagedBackups,
  eraseExpiredMemoryChunks,
  eraseExpiredSdkSessions,
} from './external.mjs';

/** Година прибирання за Києвом (07 §7). */
export const CLEANUP_HOUR = 4;
/** Мітка «сьогодні вже прибирали». */
export const CLEANUP_MARKER_KEY = 'retentionCleanupDay';
/** Скільки рядків зносимо за одне твердження (щоб не з'їсти CPU тіку). */
export const BATCH = 2000;
/**
 * Скільки таких проходів за одну таблицю на добу. Одного мало: вхідних може
 * приходити до 5 000 на добу (`inbox/store.DAILY_CAP`), і при одному проході
 * на 2 000 рядків черга простроченого росла б щодня, а «ретенція 30 діб»
 * була б неправдою.
 */
export const PASSES = 5;

const DAY = 86_400_000;
/** «Місяць» ретенції - 30 діб: строки в 07 §1 задані в місяцях, не в датах. */
const MONTH = 30 * DAY;

/**
 * @typedef {{ table: string, column: string, ms: number, where?: string,
 *   fts?: { table: string, idColumn: string } }} RetentionRule
 */

/** @type {RetentionRule[]} */
export const RETENTION = [
  // Чужі чати - 30 діб (ADR-013); дайджести лишаються назавжди.
  {
    table: 'inbox_messages',
    column: 'at',
    ms: 30 * DAY,
    fts: { table: 'inbox_fts', idColumn: 'id' },
  },
  { table: 'transactions', column: 'at', ms: 24 * MONTH },
  { table: 'price_points', column: 'at', ms: 24 * MONTH },
  { table: 'runs', column: 'started_at', ms: 90 * DAY },
  { table: 'proposals', column: 'created_at', ms: 30 * DAY },
  // Нагадування - 12 місяців ПІСЛЯ виконання: активні не чіпаємо, хоч би
  // скільки їх відкладали. `sent` тут теж (ревʼю повторів): доставлене
  // нагадування лишається в `sent`, і ряд «щодня» додавав би 365 вічних рядків
  // на рік - доти під ретенцію потрапляли тільки done/cancelled.
  {
    table: 'reminders',
    column: 'due_at',
    ms: 12 * MONTH,
    where: "status IN ('done', 'cancelled', 'sent')",
  },
  // Черга відправок - 7 діб: доставлене й провалене; те, що ще чекає
  // (pending/sending), лишається сміттям видимим, а не стертим мовчки.
  { table: 'outbox', column: 'next_at', ms: 7 * DAY, where: "status IN ('sent', 'failed')" },
  { table: 'quota_counters', column: 'updated_at', ms: 12 * MONTH },
  // Стан голосового живе хвилини; доба - із запасом на завислий тап.
  { table: 'voice_pending', column: 'created_at', ms: DAY },
];

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - ретенція неможлива');
  return env.DB;
}

/**
 * Прибрати одну таблицю. Повертає, скільки рядків знесено.
 * @param {Env} env @param {RetentionRule} rule @param {number} nowMs
 */
export async function applyRule(env, rule, nowMs) {
  const before = new Date(nowMs - rule.ms).toISOString();
  const cond = `${rule.column} < ?${rule.where ? ` AND ${rule.where}` : ''}`;
  if (rule.fts) {
    // Спершу id (для індексу), потім рядки: зворотний порядок лишив би в
    // індексі «сироти», яких уже нема за чим знайти.
    const { results } = await db(env)
      .prepare(`SELECT id FROM ${rule.table} WHERE ${cond} LIMIT ${BATCH}`)
      .bind(before)
      .all();
    const ids = (results ?? []).map((r) => String(r.id));
    if (!ids.length) return 0;
    for (let i = 0; i < ids.length; i += 100) {
      const chunk = ids.slice(i, i + 100);
      const marks = chunk.map(() => '?').join(', ');
      await db(env)
        .prepare(`DELETE FROM ${rule.fts.table} WHERE ${rule.fts.idColumn} IN (${marks})`)
        .bind(...chunk)
        .run();
      await db(env)
        .prepare(`DELETE FROM ${rule.table} WHERE id IN (${marks})`)
        .bind(...chunk)
        .run();
    }
    return ids.length;
  }
  const { meta } = await db(env)
    .prepare(
      `DELETE FROM ${rule.table} WHERE rowid IN
         (SELECT rowid FROM ${rule.table} WHERE ${cond} LIMIT ${BATCH})`,
    )
    .bind(before)
    .run();
  return Number(meta?.changes ?? 0);
}

/**
 * Задача `retention-cleanup`: 04:00 Києва, раз на добу.
 * @param {Env} env @param {number} [nowMs]
 */
export async function retentionCleanupTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== CLEANUP_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(CLEANUP_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB) {
    console.error('retention-cleanup: привʼязки DB немає - прибирання не буде');
    return { skipped: 'no-db' };
  }

  /** @type {Record<string, number>} */
  const removed = {};
  /** @type {string[]} */
  const failed = [];
  for (const rule of RETENTION) {
    try {
      let n = 0;
      for (let pass = 0; pass < PASSES; pass += 1) {
        const got = await applyRule(env, rule, nowMs);
        n += got;
        // Менше за стелю - таблиця вичищена, далі проходити нема чого.
        if (got < BATCH) break;
      }
      if (n) removed[rule.table] = n;
    } catch (/** @type {any} */ e) {
      // Збій однієї таблиці не зупиняє решту - та сама ізоляція, що в
      // планувальнику (B11).
      console.error(`retention-cleanup: таблиця ${rule.table} не прибрана`, e?.message);
      failed.push(rule.table);
    }
  }
  // D1 не може підтвердити, що Vectorize/VPS/Drive справді очистились. Ці
  // три кроки тримають порядок «зовнішнє → D1» у external.mjs; збій одного
  // не ховається за success іншого й не блокує звичайну ретенцію таблиць.
  /** @type {[string, () => Promise<number>][]} */
  const external = [
    ['memory_chunks', () => eraseExpiredMemoryChunks(env, nowMs)],
    ['sessions', () => eraseExpiredSdkSessions(env, nowMs)],
    ['drive_backups', () => eraseExpiredManagedBackups(env, nowMs)],
  ];
  for (const [name, run] of external) {
    try {
      const n = await run();
      if (n) removed[name] = n;
    } catch (/** @type {any} */ e) {
      console.error(`retention-cleanup: зовнішній scope ${name} не прибрано`, e?.message);
      failed.push(name);
    }
  }
  // Мітка стоїть у будь-якому разі: часткове прибирання довершить завтрашній
  // прохід (кожне правило ідемпотентне), а крутитись годину сенсу немає.
  await env.BRIEFING.put(CLEANUP_MARKER_KEY, today);
  if (failed.length) {
    await sendSystemAlert(
      env,
      `⚠️ Ретенція не пройшла для: ${failed.join(', ')} - повторю завтра.`,
      nowMs,
    );
  }
  return { removed, failed };
}
