// Задача memory-summarize (07 §7, ADR-038): о 04:00 Києва раз на добу для
// тредів з активністю за останню добу ядро просить мозок згорнути сесію
// (профіль summarize; мозок читає транскрипт локально і повертає згортку в
// /internal/session). Гейт київською годиною + добова мітка в KV - той самий
// патерн, що добові задачі cron.mjs: поява щоп'ять хвилин, ефект раз на добу.

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { registryBegin } from '../run-registry/client.mjs';
import { callBrainRun } from './run-client.mjs';

const MARKER_KEY = 'memorySummarizedDay';
export const SUMMARIZE_HOUR = 4;
/** Стеля тредів на добу: власник один, тредів одиниці; стеля - страховка від
 *  оскаженілого списку, не квота. */
export const SUMMARIZE_MAX_THREADS = 10;

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function memorySummarize(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== SUMMARIZE_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB) {
    console.error('memory-summarize: привʼязки DB немає - задача не виконується');
    return { skipped: 'no-db' };
  }

  // Без sdk_session_id згортати нема чого: транскрипт живе в сесії SDK на VPS.
  const since = new Date(nowMs - 24 * 3_600_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT thread_id, sdk_session_id FROM sessions
     WHERE last_at > ?1 AND sdk_session_id IS NOT NULL
     ORDER BY last_at DESC LIMIT ?2`,
  )
    .bind(since, SUMMARIZE_MAX_THREADS)
    .all();
  const rows = /** @type {{ thread_id: string, sdk_session_id: string }[]} */ (results ?? []);

  let started = 0;
  for (const row of rows) {
    const runId = crypto.randomUUID();
    await registryBegin(env, {
      id: runId,
      trigger: 'scheduler',
      profile: 'summarize',
      threadId: row.thread_id,
      model: 'claude-haiku-4-5',
      startedMs: nowMs,
    });
    const res = await callBrainRun(
      env,
      {
        runId,
        profile: 'summarize',
        threadId: row.thread_id,
        inputText: 'згорни розмову',
        session: { sdk_session_id: row.sdk_session_id, summary_md: null },
      },
      nowMs,
    );
    if (res.ok) started += 1;
    else console.error(`memory-summarize: ${row.thread_id}: ${res.status} ${res.detail}`);
  }

  // Мітка ПІСЛЯ проходу: суцільний збій до цього рядка (виняток D1/KV) дасть
  // повтор наступною появою; per-тредові відмови залоговані вище - дубль
  // згортки дешевший за втрачений день памʼяті.
  await env.BRIEFING.put(MARKER_KEY, today);
  return { started, threads: rows.length };
}
