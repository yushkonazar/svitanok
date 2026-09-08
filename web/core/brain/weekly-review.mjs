// Профіль weekly-review (07 §5, S-9-1…5): що ядро дає прогону на вхід і що
// робить із його виходом. Сам прогін іде звичайним шляхом (startClaimedRun →
// /run мозку → deliver у тему), тут - лише те, що відрізняє звіт від чату:
//   - вхід за §0 інструкції: period_from/to (пн-нд, Київ), first_sunday_of_month,
//     попередній звіт (щоб не повторюватись), instruction_hash;
//   - вихід: deliver кладе текст у `reports(kind=weekly, instruction_hash)`.
// Без транскрипту чату, без памʼяті сесій - інструкція каже «нічого іншого».

import { kyivDateKey } from '../../kyiv-time.mjs';
import { weekBounds } from '../tools/weekly.mjs';
import { instructionHash } from '../instructions.mjs';

/** «звіт зараз» (S-9-5) - той самий профіль за запитом, період = поточний тиждень. */
export const WEEKLY_NOW_RE = /^звіт\s+зараз[.!]?$/i;
/** Скільки попереднього звіту показувати моделі (вона має не повторюватись,
 *  а не переказувати минулий). */
export const PREVIOUS_REPORT_MAX_CHARS = 6_000;

/**
 * Вхідний текст прогону weekly-review (§0 інструкції).
 *
 * ⚠️ ХЕША ІНСТРУКЦІЇ ТУТ НЕМА (прогін 08.09). Він приходив у вхідному тексті,
 * і модель слухняно ставила його в підпис звіту - власник бачив у чаті
 * «weekly-review@849bfbb…». Ядро пише хеш у `reports.instruction_hash` саме,
 * тож моделі він не потрібен узагалі.
 * @param {Env} env
 * @param {number} nowMs
 */
export async function buildWeeklyReviewInput(env, nowMs) {
  const today = kyivDateKey(new Date(nowMs));
  const { from, to } = weekBounds(today);
  const dayOfMonth = Number(today.slice(8, 10));
  const isSunday = new Date(`${today}T00:00:00Z`).getUTCDay() === 0;
  const firstSunday = isSunday && dayOfMonth <= 7;
  const previous = await readPreviousReport(env, from);
  const lines = [
    `period_from: ${from}`,
    `period_to: ${to}`,
    `today: ${today}`,
    `first_sunday_of_month: ${firstSunday}`,
    '',
    previous
      ? `Попередній тижневий звіт (${previous.period}), щоб не повторюватись:\n${clip(previous.text, PREVIOUS_REPORT_MAX_CHARS)}`
      : 'Попереднього тижневого звіту немає - це перший.',
    '',
    'Напиши тижневий звіт за інструкцією.',
  ];
  return { text: lines.join('\n'), periodFrom: from, periodTo: to, firstSunday };
}

/**
 * Останній звіт ПОПЕРЕДНІХ тижнів: «звіт зараз» після недільного не має
 * бачити цьогорічний тиждень як «попередній» - інакше порівняння «до
 * минулого тижня» рахувалось би від самого себе.
 * @param {Env} env @param {string} currentFrom
 */
async function readPreviousReport(env, currentFrom) {
  if (!env.DB) return null;
  const row = /** @type {any} */ (
    await env.DB.prepare(
      `SELECT period_from, period_to, text_md FROM reports
       WHERE kind = 'weekly' AND period_from < ? ORDER BY created_at DESC LIMIT 1`,
    )
      .bind(currentFrom)
      .first()
  );
  if (!row) return null;
  return { period: `${row.period_from} - ${row.period_to}`, text: String(row.text_md ?? '') };
}

/**
 * Профіль прогону з D1 runs - щоб deliver знав, що це звіт. Один PK-пошук;
 * реєстр активних прогонів профілю не віддає, а розширювати DO заради
 * одного читача нема сенсу.
 * @param {Env} env
 * @param {string} runId
 * @returns {Promise<string | null>}
 */
export async function readRunProfile(env, runId) {
  if (!env.DB) return null;
  const row = /** @type {any} */ (
    await env.DB.prepare('SELECT profile FROM runs WHERE id = ?').bind(runId).first()
  );
  return row?.profile ?? null;
}

/**
 * Зберегти доставлений звіт у `reports` (07 §1). Хеш - той, що зараз у D1
 * `instructions` для weekly-review: він же поїхав у /run, тож рядок звіту
 * каже, ЯКОЮ інструкцією його написано. Період - тиждень дати доставки за
 * Києвом (звіт нд 09:00 і «звіт зараз» обидва описують поточний тиждень).
 * @param {Env} env
 * @param {string} text
 * @param {number} nowMs
 */
export async function saveWeeklyReport(env, text, nowMs) {
  if (!env.DB) throw new Error('привʼязки DB немає - звіт не збережено');
  const today = kyivDateKey(new Date(nowMs));
  const { from, to } = weekBounds(today);
  const row = /** @type {any} */ (
    await env.DB.prepare('SELECT body_md FROM instructions WHERE name = ?')
      .bind('weekly-review')
      .first()
  );
  const hash = row ? await instructionHash(String(row.body_md ?? '')) : null;
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO reports (id, kind, period_from, period_to, text_md, instruction_hash, created_at)
     VALUES (?, 'weekly', ?, ?, ?, ?, ?)`,
  )
    .bind(id, from, to, text, hash, new Date(nowMs).toISOString())
    .run();
  return { id, periodFrom: from, periodTo: to, instructionHash: hash };
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
