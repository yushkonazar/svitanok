// Block[] -> масив HTML-повідомлень (§9). Розбиття на МЕЖІ блоків (блок не
// рветься). Один блок > ліміту: спершу прибрати detail, далі entity-safe
// обрізати summary. Лічильник довжини — string.length (UTF-16, як Telegram).

import type { Block } from './types.js';
import { escapeHtml, fitEscaped, visibleLength } from './telegram.js';

const SEP = '\n\n'; // тонкий роздільник між блоками (today/weather не впритул, §9)

export interface RenderOptions {
  maxChars: number;
  /** Готовий безпечний рядок-заголовок (дата+день тижня) — у першому повідомленні. */
  header?: string;
  /** Тихий день: лише summary, без detail (§6). */
  quiet?: boolean;
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
export function formatKyivDateHeader(date: Date): string {
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });
  const s = fmt.format(date);
  const cap = s.charAt(0).toUpperCase() + s.slice(1);
  return `<b>${escapeHtml(cap)}</b>`;
}

/** Зібрати блоки у повідомлення, розбиваючи на межі блоків за лімітом. */
export function renderBriefing(blocks: Block[], options: RenderOptions): string[] {
  const { maxChars, header, quiet = false } = options;
  const sorted = [...blocks].sort((a, b) => a.priority - b.priority);
  const parts = sorted.map((b) => renderBlock(b, maxChars, quiet));

  const messages: string[] = [];
  let cur = header ?? '';

  for (const part of parts) {
    const candidate = cur ? cur + SEP + part : part;
    if (visibleLength(candidate) <= maxChars) {
      cur = candidate;
    } else {
      if (cur) messages.push(cur);
      cur = part; // part гарантовано <= maxChars (renderBlock це забезпечує)
    }
  }
  if (cur) messages.push(cur);
  return messages;
}
