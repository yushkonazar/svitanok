import { json } from './http-core.mjs';
import { checkPrimaryOwner } from './auth-core.mjs';
import { weeklyTextStatus } from './core/brain/weekly-report-quality.mjs';
import { weeklySummary } from './core/tools/weekly-summary.mjs';
import { validDate } from './core/ops/system-period.mjs';

const LABELS = /** @type {Record<string,string>} */ ({
  stats: 'Особисті спостереження не прочитано',
  state: 'Прогрес не прочитано',
  archive: 'Архів недоступний',
  weeklyArchive: 'Тижневий архів недоступний',
  levers: 'Закономірності недоступні',
  plans: 'Підсумки Плану не прочитано',
  finance: 'Фінанси не прочитано',
  system: 'Системні дані не прочитано',
  'truncated-data': 'Пакет даних втратив змістовні розділи',
  'prepared-data-not-read': 'Підготовлені показники не перевірено',
  'finance-conversion': 'Не всі суми мають гривневий еквівалент',
  'finance-classification': 'Не всі рухи коштів класифіковано',
  'finance-comparison': 'База порівняння неповна',
  'finance-balances': 'Залишки чи резерви неповні',
  'finance-payment-amounts': 'Не всі суми найближчих платежів відомі',
  'finance-context-coverage': 'Деталі платежів і підписок неповні',
  'finance-evidence-coverage': 'Деталі фінансової перевірки неповні',
  'personal-time-coverage': 'Час частини відповідей невідомий',
  'personal-context-coverage': 'Старший особистий контекст скорочено',
  'system-coverage': 'Телеметрія неповна',
  'system-sources': 'Частина системних джерел недоступна',
  'system-cost-sources': 'Частина обліку вартості недоступна',
  'system-cost-coverage': 'Ціни чи історія використання неповні',
  'system-credentials': 'Метадані доступів недоступні',
  'plan-coverage': 'Деталі задач чи пояснень неповні',
  'finance-summary': 'Фінансові підсумки втрачені',
  'system-summary': 'Системні підсумки втрачені',
  'plans-summary': 'Підсумки Плану втрачені',
  'personal-summary': 'Особисті підсумки втрачені',
});
/** @param {unknown} value */
function parsed(value) {
  try {
    return JSON.parse(String(value ?? '{}'));
  } catch {
    return {};
  }
}
/** Read-only saved evidence; opening this endpoint never generates a report or
 * refreshes a bank/provider. @param {Env} env @param {string|null} [week] */
export async function readWeeklyReports(env, week = null) {
  if (!env.DB) throw new Error('Weekly report storage unavailable');
  const result = await env.DB.prepare(
    `SELECT id,period_from,period_to,text_md,status,as_of,created_at,quality_json
    FROM reports WHERE kind='weekly' ORDER BY period_from DESC,created_at DESC,id DESC LIMIT 100`,
  )
    .bind()
    .all();
  /** @type {Map<string, any>} */ const periods = new Map();
  for (const row of result.results ?? []) {
    const from = String(row.period_from ?? ''),
      to = String(row.period_to ?? '');
    if (!validDate(from) || !validDate(to)) continue;
    const status = ['ready', 'partial', 'failed'].includes(String(row.status))
      ? String(row.status)
      : weeklyTextStatus(String(row.text_md ?? ''));
    const previous = periods.get(from);
    if (!previous || (previous.status === 'failed' && status !== 'failed'))
      periods.set(from, { ...row, status, from, to });
  }
  if (week) {
    const exact = await env.DB.prepare(
      `SELECT id,period_from,period_to,text_md,status,as_of,created_at,quality_json
      FROM reports WHERE kind='weekly' AND period_from=?
      ORDER BY CASE WHEN status IN ('ready','partial') THEN 0 WHEN status IS NULL THEN 1 ELSE 2 END,
        created_at DESC,id DESC LIMIT 100`,
    )
      .bind(week)
      .all();
    const candidates = (exact.results ?? []).map((row) => ({
      ...row,
      from: String(row.period_from),
      to: String(row.period_to),
      status: ['ready', 'partial', 'failed'].includes(String(row.status))
        ? String(row.status)
        : weeklyTextStatus(String(row.text_md ?? '')),
    }));
    const selected = candidates.find((row) => row.status !== 'failed') ?? candidates[0];
    if (selected) periods.set(week, selected);
  }
  const recent = [...periods.values()].slice(0, 12);
  if (week && periods.has(week) && !recent.some((row) => row.from === week))
    recent.push(periods.get(week));
  const history = recent.map((row) => ({
    week: row.from,
    to: row.to,
    status: row.status,
    createdAt: String(row.created_at),
  }));
  const selected = week ? periods.get(week) : periods.values().next().value;
  if (!selected) return { history, report: null };
  const quality = parsed(selected.quality_json);
  return {
    history,
    report: {
      id: String(selected.id),
      from: selected.from,
      to: selected.to,
      status: selected.status,
      asOf: typeof selected.as_of === 'string' ? selected.as_of : null,
      createdAt: String(selected.created_at),
      text:
        selected.status === 'failed'
          ? 'Огляд не сформовано. Збережені дані й результати задач залишаються доступними.'
          : String(selected.text_md ?? '').slice(0, 16000),
      missing: (Array.isArray(quality.missing) ? quality.missing : ['prepared-data-not-read'])
        .slice(0, 40)
        .map((/** @type {string} */ code) => LABELS[code] ?? 'Частина даних не перевірена'),
      details: quality.details ? weeklySummary(quality.details) : null,
    },
  };
}
/** @param {Request} request @param {Env} env */
export async function handleWeeklyReports(request, env) {
  const reply = (/** @type {unknown} */ body, status = 200) => {
    const response = json(body, status);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  };
  if (request.method !== 'GET') return reply({ ok: false, error: 'method' }, 405);
  const auth = await checkPrimaryOwner(request.headers.get('X-Telegram-Init-Data'), env);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
  const week = new URL(request.url).searchParams.get('week');
  if (week && !validDate(week)) return reply({ ok: false, error: 'invalid-week' }, 400);
  try {
    return reply(await readWeeklyReports(env, week));
  } catch {
    return reply({ ok: false, error: 'reports-unavailable' }, 503);
  }
}
