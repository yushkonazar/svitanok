// Block[] -> масив HTML-повідомлень (§9). Розбиття на МЕЖІ блоків (блок не
// рветься). Один блок > ліміту: спершу прибрати detail, далі entity-safe
// обрізати summary. Лічильник довжини — string.length (UTF-16, як Telegram).

import type { Block, Button } from './types.js';
import {
  escapeHtml,
  fitEscaped,
  visibleLength,
  buildCallbackData,
  type OutboundMessage,
  type TgButton,
} from './telegram.js';

const SEP = '\n\n'; // тонкий роздільник між блоками (today/weather не впритул, §9)

export interface RenderOptions {
  maxChars: number;
  /** Готовий безпечний рядок-заголовок (дата+день тижня) — у першому повідомленні. */
  header?: string;
  /** Тихий день: лише summary, без detail (§6). */
  quiet?: boolean;
  /** "YYYY-MM-DD" — потрібен лише для кодування callback_data кнопок (Блок P1). */
  dateKey?: string;
}

/** Обрізати ГОТОВИЙ HTML по межі рядків (кожен рядок блоку — цілісний HTML-юніт),
 *  щоб не лишити відкритого тега. Якщо й перший рядок не влазить — лише «…». */
function truncateHtmlByLines(html: string, budget: number): string {
  if (html.length <= budget) return html;
  let acc = '';
  for (const ln of html.split('\n')) {
    const next = acc ? `${acc}\n${ln}` : ln;
    if (next.length + 1 > budget) break; // +1 під «…»
    acc = next;
  }
  return acc ? `${acc}\n…` : '…';
}

function renderBlock(b: Block, maxChars: number, quiet: boolean): string {
  const icon = b.icon ? `${b.icon} ` : '';
  const titleLine = `<b>${escapeHtml(icon + b.title)}</b>`;
  const summary = b.summaryHtml ?? escapeHtml(b.summary);
  let html = `${titleLine}\n${summary}`;

  const detail = b.detailHtml ?? (b.detail ? escapeHtml(b.detail) : undefined);
  if (!quiet && detail) {
    html += `\n<blockquote expandable>${detail}</blockquote>`;
  }

  if (visibleLength(html) > maxChars) {
    // 1) прибрати detail
    html = `${titleLine}\n${summary}`;
    if (visibleLength(html) > maxChars) {
      // 2) обрізати summary, щоб блок усе одно йшов окремо (не 400)
      const overhead = titleLine.length + 1; // titleLine + '\n'
      const budget = Math.max(maxChars - overhead, 8);
      const fitted = b.summaryHtml
        ? truncateHtmlByLines(b.summaryHtml, budget)
        : fitEscaped(b.summary, budget);
      html = `${titleLine}\n${fitted}`;
    }
  }
  return html;
}

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

/** Button[][] (короткі коди) -> TgButton[][] (callback_data). Без dateKey/кнопок -> undefined. */
function buildInlineKeyboard(
  buttons: Button[][] | undefined,
  dateKey: string | undefined,
): TgButton[][] | undefined {
  if (!buttons || buttons.length === 0 || !dateKey) return undefined;
  const rows = buttons
    .map((row) =>
      row
        .map((b) => {
          const callback_data = buildCallbackData(dateKey, b.action);
          return callback_data ? { text: b.label, callback_data } : null;
        })
        .filter((x): x is { text: string; callback_data: string } => x !== null),
    )
    .filter((row) => row.length > 0);
  return rows.length > 0 ? rows : undefined;
}

/**
 * Зібрати блоки у повідомлення, розбиваючи на межі блоків за лімітом. Блок із
 * `buttons` ЗАВЖДИ йде окремим повідомленням (клавіатура прив'язана до
 * конкретного sendMessage — не можна «розмазати» на злиті блоки).
 */
export function renderBriefingMessages(blocks: Block[], options: RenderOptions): OutboundMessage[] {
  const { maxChars, header, quiet = false, dateKey } = options;
  // inMessage:false -> блок лише в Mini App, не в Telegram-повідомленні.
  const sorted = blocks
    .filter((b) => b.inMessage !== false)
    .sort((a, b) => a.priority - b.priority);

  const messages: OutboundMessage[] = [];
  let cur = header ?? '';
  const flush = () => {
    if (cur) messages.push({ text: cur });
    cur = '';
  };

  for (const b of sorted) {
    const part = renderBlock(b, maxChars, quiet);
    const keyboard = buildInlineKeyboard(b.buttons, dateKey);
    if (keyboard) {
      flush();
      messages.push({ text: part, buttons: keyboard });
      continue;
    }
    const candidate = cur ? cur + SEP + part : part;
    if (visibleLength(candidate) <= maxChars) {
      cur = candidate;
    } else {
      flush();
      cur = part; // part гарантовано <= maxChars (renderBlock це забезпечує)
    }
  }
  flush();
  return messages;
}

/** Той самий пакінг, лише текст (без кнопок) — для дашборда/тестів/dry-run-виводу. */
export function renderBriefing(blocks: Block[], options: RenderOptions): string[] {
  return renderBriefingMessages(blocks, options).map((m) => m.text);
}
