// runs.query (07 §4, етап 3 PR-2): телеметрія прогонів за профілями, квоти
// місяця, терміни секретів - блок СИСТЕМА тижневого звіту. Читає лише власні
// таблиці ядра (runs, quota_counters), тож не tainting.
//
// Медіана/p90 рахуються тут, а не в SQL: D1 без віконних функцій для
// percentile, а прогонів за тиждень - сотні, не мільйони. Токени в `runs` поки
// не пишуться (мозок їх не звітує) - віддаємо чесне `tokens_known: 0`, а не 0
// токенів, щоб модель не написала «токени 0/0» як факт.

import { readQuotas, QUOTA_LIMITS } from '../quota/quota.mjs';
import { shrinkToCap } from './weekly.mjs';
import { analyticsPeriod } from '../finance/analytics.mjs';
import { reportPeriod } from '../report-period.mjs';
import { ToolArgumentError } from '../tool-arguments.mjs';
import {
  readReportCosts,
  readReportCredentials,
  readReportToolCalls,
  reportErrorClass,
} from '../ops/reporting.mjs';

/** Стеля рядків за період: тиждень власника - сотні прогонів, тисячі -
 *  вже аномалія, яку варто побачити як `capped:true`, а не тягнути мегабайт. */
export const RUNS_QUERY_ROW_CAP = 5_000;
/** Останні помилки в списку - профіль і суть, без транскриптів. */
export const RUNS_QUERY_ERRORS_MAX = 20;
/** Кап тексту відповіді (бюджет одного читання у профілі weekly). */
export const RUNS_QUERY_MAX_CHARS = 20_000;

/**
 * @param {Env} env
 * @param {{ period?: string }} args
 * @param {number} nowMs
 */
export async function runRunsQuery(env, args, nowMs) {
  if (!env.DB) throw new Error('привʼязки DB немає - runs недоступні');
  let selection;
  try {
    selection = analyticsPeriod(args.period ?? 'тиждень', nowMs);
  } catch {
    throw new ToolArgumentError(
      'Некоректний період: день, тиждень, місяць, Nd/Nw/Nm або YYYY-MM-DD..YYYY-MM-DD',
    );
  }
  const period = reportPeriod(selection.from, selection.to, nowMs);
  const { from, to } = period;
  const days = (Date.parse(selection.to) - Date.parse(selection.from)) / 86_400_000 + 1;

  const reads = await Promise.allSettled([
    Promise.resolve().then(() =>
      env.DB?.prepare(
        `SELECT profile, trigger, started_at, duration_ms, tokens_in, tokens_out, steps, error
     FROM runs WHERE started_at >= ?1 AND started_at < ?2
     ORDER BY started_at DESC LIMIT ?3`,
      )
        .bind(from, to, RUNS_QUERY_ROW_CAP + 1)
        .all(),
    ),
    readQuotas(env, nowMs),
    readReportCredentials(env, nowMs),
    readReportToolCalls(env, period),
    readReportCosts(env, period, nowMs),
  ]);
  /** @type {Record<string,any>} */ const values = {};
  /** @type {Record<string,any>} */ const sources = {};
  for (const [i, name] of ['runs', 'quotas', 'secrets', 'toolCalls', 'costs'].entries()) {
    const read = reads[i];
    values[name] = read?.status === 'fulfilled' ? read.value : null;
    sources[name] = { status: read?.status === 'fulfilled' ? 'available' : 'unavailable' };
  }
  const rows = /** @type {RunRow[]} */ (values.runs?.results ?? []);
  const capped = rows.length > RUNS_QUERY_ROW_CAP;
  const sample = capped ? rows.slice(0, RUNS_QUERY_ROW_CAP) : rows;

  const quotas = values.quotas;

  const doc = {
    period: { ...period, days },
    sources,
    runs: values.runs
      ? summarizeRuns(
          sample.map((r) => ({ ...r, error: r.error ? reportErrorClass(r.error) : null })),
          capped,
        )
      : null,
    toolCalls: values.toolCalls,
    costs: values.costs,
    quotas: quotas
      ? {
          month: /** @type {any[]} */ (quotas).map((q) => ({
            key: q.key,
            value: q.value,
            limit: q.limit_value ?? QUOTA_LIMITS[String(q.key)] ?? null,
            updated_at: q.updated_at,
          })),
          // Ліміти з коду - для ключів, у яких за місяць ще не було жодного
          // виклику (рядка в таблиці немає, а межу модель знати мусить).
          limits: QUOTA_LIMITS,
          note: 'Лічильники використання за місяць, не грошовий рахунок; дата актуальності в кожному рядку.',
        }
      : null,
    secrets: values.secrets ?? {
      metadataAvailable: false,
      note: 'Метадані доступів зараз недоступні.',
    },
  };
  // Та сама стеля, що в data.read: спершу знімаються списки помилок і квот,
  // і лише потім - зріз із маркером `truncated`, щоб обрив був видимий.
  return {
    result: shrinkToCap(doc, RUNS_QUERY_MAX_CHARS, [
      { name: 'runs.errors', apply: (d) => nullify(d.runs, 'errors') },
      { name: 'toolCalls.errors', apply: (d) => nullify(d.toolCalls, 'errors') },
      { name: 'secrets.entries', apply: (d) => nullify(d.secrets, 'entries') },
      { name: 'quotas', apply: (d) => nullify(d, 'quotas') },
    ]).text,
  };
}

/** @param {any} obj @param {string} key */
function nullify(obj, key) {
  if (!obj || obj[key] == null) return false;
  obj[key] = null;
  return true;
}

/**
 * @typedef {{ profile: string | null, trigger: string, started_at: string,
 *   duration_ms: number | null, tokens_in: number | null, tokens_out: number | null,
 *   steps: number | null, error: string | null }} RunRow
 */

/**
 * Зведення за профілями + останні помилки. Чиста функція - тестується без D1.
 * @param {RunRow[]} rows - новіші першими
 * @param {boolean} capped
 */
export function summarizeRuns(rows, capped) {
  /** @type {Map<string, RunRow[]>} */
  const byProfile = new Map();
  for (const r of rows) {
    const key = r.profile ?? '(без профілю)';
    const list = byProfile.get(key) ?? [];
    list.push(r);
    byProfile.set(key, list);
  }
  const profiles = [...byProfile.entries()]
    .map(([profile, list]) => {
      const durations = list
        .map((r) => r.duration_ms)
        .filter(isFiniteNumber)
        .sort((a, b) => a - b);
      const withTokens = list.filter((r) => r.tokens_in != null || r.tokens_out != null);
      return {
        profile,
        n: list.length,
        errors: list.filter((r) => r.error).length,
        unfinished: list.filter((r) => r.duration_ms == null && !r.error).length,
        median_ms: percentile(durations, 0.5),
        p90_ms: percentile(durations, 0.9),
        steps_avg: avg(list.map((r) => r.steps).filter(isFiniteNumber)),
        tokens_in: withTokens.length ? sum(withTokens.map((r) => r.tokens_in ?? 0)) : null,
        tokens_out: withTokens.length ? sum(withTokens.map((r) => r.tokens_out ?? 0)) : null,
        tokens_known: withTokens.length,
      };
    })
    .sort((a, b) => b.n - a.n);
  const errors = rows
    .filter((r) => r.error)
    .slice(0, RUNS_QUERY_ERRORS_MAX)
    .map((r) => ({ profile: r.profile, at: r.started_at, error: String(r.error).slice(0, 200) }));
  return { total: rows.length, capped, profiles, errors };
}

/** Type guard: скінченне число (null/undefined у колонках D1 - звичайна річ).
 *  @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/** @param {number[]} sorted @param {number} p */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1));
  return sorted[idx] ?? null;
}

/** @param {number[]} xs */
function avg(xs) {
  return xs.length ? Math.round(sum(xs) / xs.length) : null;
}

/** @param {number[]} xs */
function sum(xs) {
  return xs.reduce((a, b) => a + b, 0);
}
