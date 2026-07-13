// Чиста логіка «own-data» дайджестів асистент-агента (Блок CC3, 🤖Асистент):
// стискає власні дані користувача (нагадування / воронка вакансій / активність /
// сьогоднішній брифінг) у компактний текст для LLM-промпту (бюджет
// MAX_PROMPT_LEN=4000 на хості ділиться між системним промптом, транскриптом і
// цим дайджестом). Без I/O — Worker читає KV (loadState/loadStats/`latest`) і
// агрегує (aggregateStats/totalProgress), сюди передає вже готові обʼєкти.
//
// Дайджест — це ДАНІ для LLM, не інструкції: вміст (текст нагадувань, назви
// вакансій, заголовки новин) може містити щось схоже на команду — системний
// промпт асистента (agent-core.mjs) явно позначає own-data як «лише дані».
// Тому тут — жодного HTML/розмітки, лише плоский текст (у Telegram іде вже
// відповідь LLM, не сам дайджест).

import { listActive } from './reminders-core.mjs';

// Сумарний кап дайджесту — бюджет промпту хоста (4000) ділиться між системним
// промптом (~1.5к), транскриптом розмови й цим дайджестом.
export const MAX_DIGEST_LEN = 1800;
const MAX_SUMMARY_LEN = 140; // на один блок брифінгу
const MAX_REMINDER_LEN = 60; // на текст одного нагадування
const MAX_LIST_ITEMS = 8;

/** Обрізати рядок до n символів із «…» (щоб дайджест не роздув промпт). */
function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t;
}

/** Київський "DD.MM HH:MM" абсолютного моменту. */
function kyivDayTime(ms) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(ms));
}

/** Дайджест активних нагадувань (найближче спершу, той самий listActive, що /reminders). */
export function digestReminders(reminders) {
  const active = listActive(reminders).slice(0, MAX_LIST_ITEMS);
  if (active.length === 0) return 'Нагадування: активних немає.';
  const items = active.map(
    (r, i) => `${i + 1}) ${kyivDayTime(r.whenMs)} ${clip(r.text, MAX_REMINDER_LEN)}`,
  );
  return `Нагадування (активні): ${items.join('; ')}.`;
}

/** Дайджест воронки вакансій (вхід — вихід aggregateStats). */
export function digestJobs(agg) {
  const f = agg?.funnel ?? {};
  const g = agg?.goal ?? {};
  const parts = [
    `Вакансії — воронка: збережено ${f.saved ?? 0}, подано ${f.applied ?? 0}, ` +
      `співбесіда ${f.interview ?? 0}, оферів ${f.offer ?? 0}`,
  ];
  if (g.weeklyTarget) parts.push(`ціль тижня ${g.weeklyApplied ?? 0}/${g.weeklyTarget} подач`);
  if (typeof agg?.avgFitApplied === 'number') {
    parts.push(`середній fit поданих ${agg.avgFitApplied}%`);
  }
  return parts.join('; ') + '.';
}

/** Дайджест активності/навчання: стрік відкриттів, прогрес роадмепу, слабкі mock-теми. */
export function digestProgress(agg, roadmap) {
  const st = agg?.streaks ?? {};
  const parts = [
    `Активність: стрік відкриттів ${st.openDays ?? 0} дн (рекорд ${st.bestOpenDays ?? 0})`,
  ];
  if (roadmap && roadmap.total) {
    parts.push(`роадмеп ${roadmap.done ?? 0}/${roadmap.total} пройдено`);
  }
  const weak = Array.isArray(agg?.mock?.weakTopics)
    ? agg.mock.weakTopics.filter((t) => t && t.value > 0).slice(0, 4)
    : [];
  if (weak.length) {
    const list = weak.map((t) => `${clip(t.name, 24)} ${t.value}%`).join(', ');
    parts.push(`слабкі теми (mock): ${list}`);
  }
  return parts.join('; ') + '.';
}

/** Дайджест сьогоднішнього брифінгу — усі блоки (погода/курс/новини/факт/...) з їх summary. */
export function digestBriefing(latest) {
  const blocks = Array.isArray(latest?.blocks) ? latest.blocks : [];
  const lines = blocks
    .map((b) => {
      // summary модулів багаторядковий (календар/погода/onthisday) — плющимо в " / ".
      const sum = clip(String(b?.summary ?? '').replace(/\s*\n+\s*/g, ' / '), MAX_SUMMARY_LEN);
      if (!sum) return null;
      const label = [b?.icon, b?.title].filter(Boolean).join(' ').trim() || b?.id || 'блок';
      return `${label}: ${sum}`;
    })
    .filter(Boolean);
  if (lines.length === 0) return 'Сьогоднішній брифінг: даних поки немає.';
  return `Сьогоднішній брифінг — ${lines.join('; ')}.`;
}

// Області own-data, які модель може запросити (dataScope у readOwnData, CC4).
export const OWN_DATA_SCOPES = ['all', 'briefing', 'jobs', 'progress', 'reminders'];

/** Нормалізувати dataScope (невідоме/відсутнє -> 'all'). */
export function normalizeScope(scope) {
  return OWN_DATA_SCOPES.includes(scope) ? scope : 'all';
}

/**
 * Зібрати own-data дайджест за scope. Worker передає вже прочитані/агреговані
 * джерела; секції для відсутніх даних граційно деградують (не кидають).
 * Результат обрізаний до MAX_DIGEST_LEN (бюджет промпту хоста).
 */
export function buildOwnDataDigest({ scope, reminders, agg, roadmap, latest }) {
  const s = normalizeScope(scope);
  const sections = [];
  if (s === 'all' || s === 'briefing') sections.push(digestBriefing(latest));
  if (s === 'all' || s === 'jobs') sections.push(digestJobs(agg));
  if (s === 'all' || s === 'progress') sections.push(digestProgress(agg, roadmap));
  if (s === 'all' || s === 'reminders') sections.push(digestReminders(reminders));
  return clip(sections.join('\n'), MAX_DIGEST_LEN);
}
