// Текстові хелпери брифінгу: заголовок дати, короткий рядок дня, недільний
// підсумок. Усе — плоскі рядки для Telegram-повідомлення.
//
// ЧОГО ТУТ БІЛЬШЕ НЕМАЄ (аудит B20/F5). Тут жив рендерер Block[] -> кілька
// HTML-повідомлень з inline-кнопками. Він не викликався: orchestrator будує
// денне повідомлення з заголовка й рядка дня, а весь вміст блоків їде лише в
// briefing.json (рішення власника — дашборд як єдине місце перегляду). Тобто
// ~180 рядків і їхні тести підтримувались заради поведінки, яка не може
// статись, а кнопки 🔖 «Зберегти» (stoic/fact/jobs) щоразу будувались і мовчки
// викидались. Збереження живе в Mini App.

import { escapeHtml } from './telegram.js';

/** Дата + день тижня українською (uk-UA), як безпечний bold-заголовок (§9). */
/** Плейн-рядок дати «Вівторок, 30 червня» (uk-UA, Київ) — для briefing.json. */
export function formatKyivDateLabel(date: Date): string {
  const s = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function formatKyivDateHeader(date: Date): string {
  return `<b>${escapeHtml(formatKyivDateLabel(date))}</b>`;
}

/** Об'єднати непорожні сегменти короткого рядка дня (Фаза B3) " · "-роздільником;
 *  усі порожні -> ''. */
export function joinSummarySegments(segments: (string | null | undefined)[]): string {
  return segments.filter((s): s is string => !!s).join(' · ');
}

export interface WeeklyReviewData {
  newsCount: number;
  roadmapDone: number;
  weakTopics: string[];
}

/**
 * Недільне повідомлення підсумку тижня (Фаза B5, тема Брифінг) — узгоджена
 * конвенція з web/tg-core.mjs formatStatsMessage (bold-заголовок, порожній
 * рядок-роздільник, емодзі-мітки, escapeHtml на динаміку). roadmapDone —
 * загальний лічильник (не лише за тиждень, §weekly-review.ts коментар).
 */
export function formatWeeklyReviewMessage(d: WeeklyReviewData): string {
  const lines = ['📊 <b>Підсумок тижня</b>', '', `🗞 Новин показано: ${d.newsCount}`];
  if (d.roadmapDone > 0) lines.push(`🗺 Роадмеп: ${d.roadmapDone} пунктів позначено (загалом)`);
  if (d.weakTopics.length > 0) {
    lines.push(`🎤 Слабкі теми mock: ${d.weakTopics.map(escapeHtml).join(', ')}`);
  }
  return lines.join('\n');
}
