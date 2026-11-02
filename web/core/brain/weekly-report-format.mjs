import { formatMoney } from '../format.mjs';

export const WEEKLY_OVERVIEW_MAX_CHARS = 2200;
const LABELS = /** @type {Record<string, string>} */ ({
  plan: 'Справи',
  personal: 'Стан',
  finance: 'Гроші',
});
/** @param {unknown} value @param {number} max */
function line(value, max) {
  return typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= max &&
    ![...value].some((character) => character.charCodeAt(0) < 32)
    ? value.trim()
    : null;
}
/** @param {string} text */
export function parseWeeklyDecision(text) {
  try {
    const doc = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gu, ''));
    if (
      !Array.isArray(doc.highlights) ||
      doc.highlights.length > 3 ||
      !Array.isArray(doc.actions) ||
      doc.actions.length > 2
    )
      return null;
    const highlights = doc.highlights.map((/** @type {any} */ h) => ({
      kind: h?.kind,
      text: line(h?.text, 360),
    }));
    const actions = doc.actions.map((/** @type {any} */ action) => line(action, 180));
    if (
      highlights.some(
        (/** @type {any} */ h) =>
          typeof h.kind !== 'string' || !Object.hasOwn(LABELS, h.kind) || !h.text,
      ) ||
      actions.some((/** @type {any} */ a) => !a)
    )
      return null;
    const sections =
      Array.isArray(doc.sections) && doc.sections.length <= 3
        ? doc.sections.map((/** @type {any} */ section) => ({
            kind: section?.kind,
            title: line(section?.title, 100),
            paragraphs: Array.isArray(section?.paragraphs)
              ? section.paragraphs.map((/** @type {any} */ p) => line(p, 700))
              : [],
          }))
        : [];
    const validSections =
      sections.length &&
      new Set(sections.map((/** @type {any} */ s) => s.kind)).size === sections.length &&
      sections.every(
        (/** @type {any} */ section) =>
          Object.hasOwn(LABELS, section.kind) &&
          section.title &&
          section.paragraphs.length >= 1 &&
          section.paragraphs.length <= 2 &&
          section.paragraphs.every(Boolean),
      );
    return { highlights, actions, ...(validSections ? { sections } : {}) };
  } catch {
    return null;
  }
}
/** Deterministic fallback preserves checked facts when model formatting fails.
 * It never turns an explicit provider/run failure into a successful report.
 * @param {any} details */
export function weeklyFactDecision(details) {
  /** @type {{kind: string, text: string}[]} */ const highlights = [];
  const plan = details?.plan;
  if (typeof plan?.summary?.acceptedCommitments === 'number') {
    highlights.push({
      kind: 'plan',
      text: `У Плані — ${plan.summary.acceptedCommitments} прийнятих обіцянок і ${plan.summary.distinctResults} унікальних результатів. Завершено ${plan.summary.completedDistinctResults}. Фактичне виконання враховано окремо від вчасності та XP.`,
    });
  }
  const periods = details?.personalPeriods;
  for (const [key, label] of /** @type {[string,string][]} */ ([
    ['morning.energy', 'Ранкова енергія'],
    ['evening.dayScore', 'Оцінка дня'],
  ])) {
    const current = periods?.current?.observationsV3?.[key];
    const previous = periods?.previousWeeks?.[0]?.observationsV3?.[key];
    const currentN = current?.numericN ?? current?.n,
      previousN = previous?.numericN ?? previous?.n;
    if (
      currentN >= 3 &&
      previousN >= 3 &&
      Number.isFinite(current.average) &&
      Number.isFinite(previous.average)
    ) {
      const number = (/** @type {number} */ n) =>
        new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 }).format(n);
      highlights.push({
        kind: 'personal',
        text: `${label}: ${number(current.average)} проти ${number(previous.average)} попереднього тижня; ${currentN} і ${previousN} відповідей тієї самої анкети. Це порівняння з одним тижнем.`,
      });
      break;
    }
  }
  const finance = details?.finance;
  if (typeof finance?.summary?.expenseMinor === 'number') {
    let text = `Обліковані витрати — ${formatMoney(finance.summary.expenseMinor, 'UAH')}.`;
    const comparison = finance.comparison;
    if (comparison?.complete && typeof comparison.averageExpenseMinor === 'number')
      text += ` Середнє чотирьох попередніх тижнів — ${formatMoney(comparison.averageExpenseMinor, 'UAH')}.`;
    else if (
      comparison?.previousWeek?.complete &&
      typeof comparison.previousWeek.expenseMinor === 'number'
    )
      text += ` Попередній тиждень — ${formatMoney(comparison.previousWeek.expenseMinor, 'UAH')}; це одна база порівняння.`;
    else text += ' Надійної бази порівняння немає.';
    highlights.push({ kind: 'finance', text });
  }
  return { highlights: highlights.slice(0, 3), actions: /** @type {string[]} */ ([]) };
}
/** Only a checked section can support a model-selected observation.
 * @param {any} details @param {string} kind */
function sectionAvailable(details, kind) {
  if (kind === 'plan') return details?.plan?.summary != null;
  if (kind === 'finance') return typeof details?.finance?.summary?.expenseMinor === 'number';
  return details?.personalPeriods?.current != null;
}
/** @param {string} raw @param {any} quality @param {boolean} [failed] */
export function renderWeeklyOverview(raw, quality, failed = false) {
  const p = quality.period;
  const dates = `${p.dateFrom.slice(8)}.${p.dateFrom.slice(5, 7)} — ${p.dateTo.slice(8)}.${p.dateTo.slice(5, 7)}`;
  if (failed || /^\s*(?:⚠️|error\b|помилка\b|немає кредиту|недостатньо)/iu.test(raw))
    return {
      text: `Не вдалося сформувати огляд за ${dates}. Стан доступний у застосунку.`,
      valid: false,
      fallback: false,
    };
  let decision = parseWeeklyDecision(raw);
  const fallback =
    !decision ||
    decision.highlights.length === 0 ||
    decision.highlights.some((/** @type {any} */ h) => !sectionAvailable(quality.details, h.kind));
  if (fallback) decision = weeklyFactDecision(quality.details);
  if (!decision?.highlights.length)
    return {
      text: `Не вдалося отримати підсумки за ${dates}. Дані й результати задач збережені; стан доступний у застосунку.`,
      valid: false,
      fallback,
    };
  const order = Object.keys(LABELS);
  const highlights = [...decision.highlights].sort(
    (a, b) => order.indexOf(a.kind) - order.indexOf(b.kind),
  );
  const lines = [
    `📊 Тиждень ${dates}`,
    '',
    ...highlights.map((h) => `• ${LABELS[h.kind]}: ${h.text}`),
  ];
  if (decision.actions.length)
    lines.push(
      '',
      'ДАЛІ',
      ...decision.actions.map(
        (/** @type {string} */ action, /** @type {number} */ i) => `${i + 1}. ${action}`,
      ),
    );
  if (quality.missing?.length)
    lines.push('', 'Дані неповні. Причини й доступні підсумки — у деталях огляду.');
  const text = lines.join('\n');
  if (text.length > WEEKLY_OVERVIEW_MAX_CHARS)
    throw new Error('Weekly overview exceeds its bounded contract');
  return {
    text,
    valid: true,
    fallback,
    decision: {
      highlights,
      actions: decision.actions,
      ...('sections' in decision ? { sections: decision.sections } : {}),
    },
  };
}
