// Детермінований шар персональної аналітики (4D).
//
// Він навмисно НЕ рахує кореляції: це вже робить щотижневий cron у
// levers-core.mjs. Тут лише надається одна чесна форма для API й асистента,
// де не змішуються: факти-метрики, статистичні патерни, наперед задані
// гіпотези та рекомендації. Жодної мережі, KV або LLM у цьому модулі.

import { LEVER_FEATURES, LEVER_HYPOTHESES } from './levers-core.mjs';

const FEATURE_BY_KEY = new Map(LEVER_FEATURES.map((feature) => [feature.key, feature]));
const MAX_ROWS = 12;
const MAX_ASSISTANT_DIGEST = 1450;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} value @param {number} [fallback] */
const finite = (value, fallback = 0) =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
/** @param {unknown} value */
const nonNegativeInt = (value) => Math.max(0, Math.round(finite(value)));
/** @param {unknown} value @param {number} length */
const clip = (value, length) => {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text;
};
/** @param {string} from @param {string} to @param {number} lag */
const rowKey = (from, to, lag) => `${from}->${to}@${lag}`;

/** @param {unknown} key */
function feature(key) {
  if (typeof key !== 'string') return null;
  const item = FEATURE_BY_KEY.get(key);
  return item ? { key: item.key, label: item.label, unit: item.unit, domain: item.domain } : null;
}

/** @param {unknown} raw */
function safeEffect(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const value = /** @type {any} */ (raw);
  const high = finite(value.high, NaN);
  const low = finite(value.low, NaN);
  const d = finite(value.d, NaN);
  if (![high, low, d].every(Number.isFinite)) return null;
  return {
    high,
    low,
    nHigh: nonNegativeInt(value.nHigh),
    nLow: nonNegativeInt(value.nLow),
    cohensD: d,
  };
}

/** Збережений `levers` → тільки перевірені рядки, без довільного KV payload. */
/** @param {unknown} raw */
function safePatterns(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const value = /** @type {any} */ (raw);
  // Без мітки тижня результат не має перевірюваного часу походження. Не
  // показуємо навіть математично схожі рядки з битого cache.
  if (value.ready !== true || !DATE_KEY_RE.test(value.weekOf) || !Array.isArray(value.rows))
    return [];
  return value.rows
    .map((/** @type {any} */ row) => {
      const driver = feature(row?.from);
      const outcome = feature(row?.to);
      const lagWeeks = nonNegativeInt(row?.lag);
      const rho = finite(row?.rho, NaN);
      const rhoDiff = finite(row?.rhoDiff, NaN);
      const pValue = finite(row?.p, NaN);
      if (
        !driver ||
        !outcome ||
        !Number.isFinite(rho) ||
        !Number.isFinite(rhoDiff) ||
        !Number.isFinite(pValue)
      )
        return null;
      return {
        id: rowKey(driver.key, outcome.key, lagWeeks),
        kind: 'statistical_pattern',
        driver,
        outcome,
        lagWeeks,
        correlation: rho,
        differenceCorrelation: rhoDiff,
        pValue,
        samples: nonNegativeInt(row?.n),
        differenceSamples: nonNegativeInt(row?.nDiff),
        effect: safeEffect(row?.effect),
        // Це суттєвий інваріант API: рядок пережив обидві поправки, але все
        // одно не є причинним висновком або порадою «робити X».
        interpretation: 'association_not_causation',
      };
    })
    .filter(Boolean)
    .slice(0, MAX_ROWS);
}

/** @param {unknown} raw @param {any[]} patterns */
function analysisStatus(raw, patterns) {
  if (!raw || typeof raw !== 'object') {
    return { state: 'not_computed', reason: 'weekly_job_has_not_run' };
  }
  const value = /** @type {any} */ (raw);
  if (!DATE_KEY_RE.test(value.weekOf)) {
    return { state: 'not_computed', reason: 'weekly_job_has_not_run' };
  }
  const weeks = nonNegativeInt(value.weeks);
  const weeksNeeded = nonNegativeInt(value.weeksNeeded);
  if (value.ready !== true) {
    return {
      state: 'waiting_for_data',
      weekOf: value.weekOf,
      computedAt:
        typeof value.computedAt === 'string' && value.computedAt.length <= 40
          ? value.computedAt
          : null,
      weeks,
      weeksNeeded,
      tested: nonNegativeInt(value.tested),
      shown: 0,
    };
  }
  return {
    state: patterns.length ? 'patterns_available' : 'no_pattern_shown',
    weekOf: value.weekOf,
    computedAt:
      typeof value.computedAt === 'string' && value.computedAt.length <= 40
        ? value.computedAt
        : null,
    weeks,
    weeksNeeded,
    tested: nonNegativeInt(value.tested),
    shown: patterns.length,
  };
}

/** @param {any} agg */
function buildFacts(agg) {
  const goal = agg?.goal ?? {};
  const telemetry = agg?.learningTelemetry ?? {};
  return [
    {
      id: 'applications_this_week',
      kind: 'fact',
      label: 'Подачі цього тижня',
      value: nonNegativeInt(goal.weeklyApplied),
      target: nonNegativeInt(goal.weeklyTarget),
      periodDays: 7,
      source: 'deterministic_stats',
    },
    {
      id: 'briefing_open_streak',
      kind: 'fact',
      label: 'Поточний стрік відкриттів',
      value: nonNegativeInt(agg?.streaks?.openDays),
      unit: 'days',
      source: 'deterministic_stats',
    },
    {
      id: 'mock_practice_streak',
      kind: 'fact',
      label: 'Поточний стрік практики',
      value: nonNegativeInt(agg?.mock?.streak),
      unit: 'days',
      source: 'deterministic_stats',
    },
    {
      id: 'reported_learning_outcomes',
      kind: 'fact',
      label: 'Явно повідомлені результати навчання',
      value: nonNegativeInt(telemetry.attempts),
      periodDays: nonNegativeInt(telemetry.windowDays),
      outcomes: {
        correct: nonNegativeInt(telemetry?.outcomes?.correct),
        incorrect: nonNegativeInt(telemetry?.outcomes?.incorrect),
        unsure: nonNegativeInt(telemetry?.outcomes?.unsure),
      },
      byTopic: (Array.isArray(telemetry.byTopic) ? telemetry.byTopic : [])
        .filter(
          (/** @type {any} */ row) =>
            typeof row?.topic === 'string' && row.topic.length > 0 && row.topic.length <= 48,
        )
        .slice(0, 8)
        .map((/** @type {any} */ row) => ({
          topic: row.topic,
          attempts: nonNegativeInt(row.attempts),
          correct: nonNegativeInt(row.correct),
          incorrect: nonNegativeInt(row.incorrect),
          unsure: nonNegativeInt(row.unsure),
        })),
      source: 'owner_reported',
    },
  ];
}

/** @param {any} status @param {any[]} patterns */
function buildHypotheses(status, patterns) {
  const supported = new Set(patterns.map((/** @type {any} */ row) => row.id));
  return LEVER_HYPOTHESES.map((hypothesis) => {
    const driver = feature(hypothesis.from);
    const outcome = feature(hypothesis.to);
    const id = rowKey(hypothesis.from, hypothesis.to, hypothesis.lag);
    let evidenceState = 'not_computed';
    if (status.state === 'waiting_for_data') evidenceState = 'waiting_for_data';
    else if (status.state !== 'not_computed')
      evidenceState = supported.has(id) ? 'supported_by_current_data' : 'not_shown';
    return {
      id,
      kind: 'hypothesis',
      driver,
      outcome,
      lagWeeks: hypothesis.lag,
      evidenceState,
      // `not_shown` не означає «ефекту немає»: він просто не пройшов усі
      // поточні гейти, тому в API не приписуємо гіпотезі негативний висновок.
      causalClaim: false,
    };
  });
}

/** @param {any[]} patterns */
function buildRecommendations(patterns) {
  return patterns.map((/** @type {any} */ pattern) => ({
    id: `observe:${pattern.id}`,
    kind: 'recommendation',
    basedOn: [pattern.id],
    title: `Перевірити зв’язок «${pattern.driver.label} → ${pattern.outcome.label}»`,
    action: 'continue_measurement_for_one_full_week',
    // Лише запропонувати спостереження: без автоматичної зміни плану, без
    // «збільш X» і без удавання, що кореляція довела причинність.
    text: 'Продовж спостереження ще один повний тиждень у звичному режимі; це асоціація, не доказ причини.',
    requiresOwnerChoice: true,
    autoApply: false,
  }));
}

/**
 * Єдиний API-представник 4D. `agg` уже має бути результатом aggregateStats,
 * а `levers` — snapshot щотижневого розрахунку; цей модуль не читає сирі дані.
 */
/** @param {{ agg?: any, levers?: any }} [input] */
export function buildAnalyticsSnapshot({ agg, levers } = {}) {
  const patterns = safePatterns(levers);
  const status = analysisStatus(levers, patterns);
  return {
    version: 1,
    policy: {
      facts: 'deterministic_aggregates',
      patterns: 'precomputed_statistics_not_causation',
      hypotheses: 'pre_registered_not_personal_facts',
      recommendations: 'measurement_only_owner_chooses',
    },
    analysis: status,
    facts: buildFacts(agg),
    patterns,
    hypotheses: buildHypotheses(status, patterns),
    recommendations: buildRecommendations(patterns),
  };
}

/** Компактний, даними-обмежений зріз для legacy assistant transcript. */
/** @param {any} snapshot */
export function formatAnalyticsForAssistant(snapshot) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : buildAnalyticsSnapshot();
  const facts = Array.isArray(source.facts) ? source.facts : [];
  const patterns = Array.isArray(source.patterns) ? source.patterns : [];
  const status = source.analysis?.state ?? 'not_computed';
  const lines = [
    `Аналітика (лише агрегати; кореляція не є причиною): стан=${status}.`,
    ...facts.map((/** @type {any} */ fact) => {
      if (fact.id === 'applications_this_week')
        return `Факт: подачі ${fact.value}/${fact.target} за 7 днів.`;
      if (fact.id === 'reported_learning_outcomes')
        return [
          `Факт: явні результати навчання ${fact.value} за ${fact.periodDays} днів (правильно ${fact.outcomes?.correct ?? 0}, помилок ${fact.outcomes?.incorrect ?? 0}, не впевнений ${fact.outcomes?.unsure ?? 0}).`,
          ...(Array.isArray(fact.byTopic) && fact.byTopic.length
            ? [
                `За темами: ${fact.byTopic
                  .map(
                    (/** @type {any} */ row) =>
                      `${clip(row.topic, 48)} — ${nonNegativeInt(row.attempts)} (помилок ${nonNegativeInt(row.incorrect)})`,
                  )
                  .join('; ')}.`,
              ]
            : []),
        ].join(' ');
      return `Факт: ${fact.label} — ${fact.value}${fact.unit ? ` ${fact.unit}` : ''}.`;
    }),
    ...patterns.map(
      (/** @type {any} */ pattern) =>
        `Патерн: ${pattern.driver.label} → ${pattern.outcome.label}, lag ${pattern.lagWeeks} тиж., rho ${pattern.correlation}, p ${pattern.pValue}; не причинність.`,
    ),
  ];
  return clip(lines.join(' '), MAX_ASSISTANT_DIGEST);
}

/**
 * `data.read` має повертати цілий JSON навіть коли викликач зменшив cap.
 * Рядкове slice перетворило б відповідь на битий JSON саме у вузькому
 * профілі, де мозку особливо потрібна чесна ознака скорочення.
 * @param {any} snapshot @param {number} cap
 */
export function serializeAnalyticsSnapshot(snapshot, cap) {
  const source = snapshot && typeof snapshot === 'object' ? snapshot : buildAnalyticsSnapshot();
  const full = JSON.stringify(source);
  if (full.length <= cap) return full;

  const compact = {
    ...source,
    truncated: true,
    patterns: (Array.isArray(source.patterns) ? source.patterns : []).map(
      (/** @type {any} */ row) => ({
        id: row.id,
        kind: row.kind,
        driver: row.driver?.key,
        outcome: row.outcome?.key,
        lagWeeks: row.lagWeeks,
        interpretation: row.interpretation,
      }),
    ),
    hypotheses: (Array.isArray(source.hypotheses) ? source.hypotheses : []).map(
      (/** @type {any} */ row) => ({
        id: row.id,
        kind: row.kind,
        evidenceState: row.evidenceState,
      }),
    ),
    recommendations: (Array.isArray(source.recommendations) ? source.recommendations : []).map(
      (/** @type {any} */ row) => ({
        id: row.id,
        kind: row.kind,
        action: row.action,
        autoApply: false,
      }),
    ),
  };
  const compactText = JSON.stringify(compact);
  if (compactText.length <= cap) return compactText;

  // Мінімальна, але валідна форма. Вона явно каже, що дані скорочено, і не
  // перетворює cap на тиху втрату змісту або недійсний JSON.
  return JSON.stringify({
    scope: 'analytics',
    truncated: true,
    analysis: source.analysis ?? { state: 'not_computed' },
    facts: (Array.isArray(source.facts) ? source.facts : []).map((/** @type {any} */ fact) => ({
      id: fact.id,
      value: fact.value,
    })),
  });
}
