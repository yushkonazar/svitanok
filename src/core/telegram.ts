// Notifier: відправка в Telegram (parse_mode HTML), HTML-escape, entity-safe
// обрізання, fail-notify (§8, §9). Лічильник довжини — UTF-16 code units, як
// рахує Telegram (string.length у JS підходить; емодзі = сурогатна пара).

import type { Logger } from './types.js';

export const TELEGRAM_HARD_LIMIT = 4096;

/** Escape ВСІХ динамічних полів для HTML parse mode (§8). */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Клікабельне посилання у словах: <a href="url">text</a>. Обидва поля екрануються. */
export function link(url: string, text: string): string {
  return `<a href="${escapeHtml(url)}">${escapeHtml(text)}</a>`;
}

/**
 * ВИДИМА довжина HTML — як рахує Telegram ліміт 4096 («after entities parsing»):
 * теги відкидаємо, кожну HTML-сутність рахуємо як 1 символ. Тобто довгі href у
 * <a> НЕ рахуються (інакше Google News-редіректи дають хибне розбиття).
 */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, '').replace(/&[a-z]+;|&#\d+;/gi, 'x').length;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/**
 * Обрізати ПЛЕЙН-текст під бюджет і лише потім заекранувати — так не лишається
 * «обірваної» HTML-сутності/тега (§9). Сурогат-безпечно. Додає «…» якщо різали.
 * budget — у UTF-16 code units фінального (escaped) рядка.
 */
export function fitEscaped(plain: string, budget: number): string {
  const full = escapeHtml(plain);
  if (full.length <= budget) return full;

  const ELLIPSIS = '…';
  // Найбільше n, для якого escapeHtml(plain[0..n]) + «…» <= budget.
  let lo = 0;
  let hi = plain.length;
  const safeSlice = (n: number): string => {
    let s = plain.slice(0, n);
    if (s.length && isHighSurrogate(s.charCodeAt(s.length - 1))) s = s.slice(0, -1);
    return s;
  };
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escapeHtml(safeSlice(mid)).length + ELLIPSIS.length <= budget) lo = mid;
    else hi = mid - 1;
  }
  return escapeHtml(safeSlice(lo)) + ELLIPSIS;
}

export interface Notifier {
  send(messages: string[]): Promise<void>;
  /** Мінімальне попередження власнику напряму (top-level catch, §4.1). */
  failNotify(text: string): Promise<void>;
}

type FetchImpl = typeof fetch;

export interface NotifierOptions {
  token: string;
  chatId: string;
  log?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export function createNotifier(opts: NotifierOptions): Notifier {
  const { token, chatId, log, fetchImpl = fetch, timeoutMs = 30000 } = opts;

  async function call(method: string, body: Record<string, unknown>): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Telegram ${method} HTTP ${res.status}: ${text}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async send(messages: string[]): Promise<void> {
      for (const msg of messages) {
        if (msg.length > TELEGRAM_HARD_LIMIT) {
          log?.warn(`повідомлення ${msg.length} > ${TELEGRAM_HARD_LIMIT} — render мав чанкувати`);
        }
        await call('sendMessage', {
          chat_id: chatId,
          text: msg,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        });
      }
    },
    async failNotify(text: string): Promise<void> {
      // Без HTML — на випадок проблем із розміткою; обрізати під ліміт.
      const plain =
        text.length > TELEGRAM_HARD_LIMIT ? `${text.slice(0, TELEGRAM_HARD_LIMIT - 1)}…` : text;
      await call('sendMessage', { chat_id: chatId, text: plain });
    },
  };
}
