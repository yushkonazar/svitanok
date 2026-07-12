// Notifier: відправка в Telegram (parse_mode HTML), HTML-escape, entity-safe
// обрізання, fail-notify (§8, §9). Лічильник довжини — UTF-16 code units, як
// рахує Telegram (string.length у JS підходить; емодзі = сурогатна пара).

import type { Logger } from './types.js';

export const TELEGRAM_HARD_LIMIT = 4096;

/** Escape ВСІХ динамічних полів для HTML parse mode (§8). Включно з `"` —
 *  інакше URL/текст із лапкою ламає атрибут href у link() (400 від Telegram). */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

// callback_data (Блок P1, вебхук): `v1:<dateKey>:<action>`. МАЄ збігатися символ-у-
// символ з дзеркалом web/tg-core.mjs (буквально та сама версія/формат) — інакше
// Worker не розпарсить кнопки, надіслані Actions-раном.
export const CB_VERSION = 'v1';

/** Закодувати callback_data; ≤64 байти (UTF-8, Telegram-ліміт) — інакше null (кнопку відкидаємо). */
export function buildCallbackData(dateKey: string, action: string): string | null {
  const s = `${CB_VERSION}:${dateKey}:${action}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

// pd:a:<id>/pd:c:<id> (Блок P2b, окремий простір від v1:<dateKey>:...) — TS-
// дзеркало web/agent-core.mjs (`PROPOSAL_CB_PREFIX`/`buildProposalCallbackData`).
// МАЄ збігатися символ-у-символ — той самий webhook-обробник
// (`resolveProposalCallback`, web/worker.js) резолвить пропозиції незалежно
// від того, ХТО їх записав (Worker-агент чи, Блок P2c, orchestrator).
export const PROPOSAL_CB_PREFIX = 'pd:';

/** `pd:a:<id>` (прийняти) / `pd:c:<id>` (скасувати); ≤64 байти (Telegram-ліміт). */
export function buildProposalCallbackData(action: 'a' | 'c', id: string): string | null {
  const s = `${PROPOSAL_CB_PREFIX}${action}:${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

export type TgButton =
  | { text: string; callback_data: string }
  | { text: string; web_app: { url: string } }
  | { text: string; url: string };

/**
 * Кнопка запуску Mini App. Telegram Bot API: `web_app`-кнопки в inline_keyboard
 * дозволені ЛИШЕ в приватних чатах з ботом — у групі/супергрупі Telegram
 * відповідає `BUTTON_TYPE_INVALID` (400), і повідомлення НЕ надсилається
 * (проявилось на проді 2026-07-12: щоденний брифінг падав щоранку, бо
 * TELEGRAM_CHAT_ID тепер id супергрупи, §4.3 «Блок Теми»).
 *
 * Пріоритет вибору типу кнопки:
 * 1. **botUsername заданий** -> Direct Link Mini App: `https://t.me/<username>
 *    ?startapp` (Telegram Bot API, розділ Web Apps). Цей формат ЗАВЖДИ
 *    launch-ить повноцінний Mini App із `Telegram.WebApp.initData` — і з
 *    групи, і з приватного чату (обходить обмеження `web_app`-кнопки).
 *    Потребує ОДНОРАЗОВОГО owner-кроку: @BotFather -> Bot Settings ->
 *    Configure Mini App -> URL = те саме значення, що MINI_APP_URL
 *    (`.env.example`). Без цього кроку посилання відкриє «звичайний» сайт
 *    без ін'єкції Telegram.WebApp (як і фолбек нижче).
 * 2. **botUsername не заданий** (owner ще не зробив крок 1) -> фолбек за
 *    знаком chatId (стандартна конвенція Telegram: групи/супергрупи/канали —
 *    ВІД'ЄМНИЙ chat_id, приватні чати — додатний): chatId < 0 (група) ->
 *    звичайна `url`-кнопка (завжди валідна, БЕЗ initData -> дашборд
 *    деградує на SAMPLE-фолбек, §H1); інакше -> `web_app` (initData є, бо
 *    приватний чат — єдиний контекст, де ця кнопка легальна).
 */
export function buildMiniAppButton(
  text: string,
  url: string,
  chatId?: string | number | null,
  botUsername?: string | null,
): TgButton {
  const username = botUsername?.trim().replace(/^@/, '');
  if (username) {
    return { text, url: `https://t.me/${username}?startapp` };
  }
  const isGroup = chatId != null && Number(chatId) < 0;
  return isGroup ? { text, url } : { text, web_app: { url } };
}

export interface OutboundMessage {
  text: string;
  buttons?: TgButton[][]; // reply_markup.inline_keyboard
}

export interface Notifier {
  send(messages: (string | OutboundMessage)[]): Promise<void>;
  /** Мінімальне попередження власнику напряму (top-level catch, §4.1). */
  failNotify(text: string): Promise<void>;
}

type FetchImpl = typeof fetch;

export interface NotifierOptions {
  token: string;
  chatId: string;
  /** thread_id теми forum-супергрупи (Блок «Теми»); не задано -> дефолтна тема/DM. */
  threadId?: string;
  log?: Logger;
  fetchImpl?: FetchImpl;
  timeoutMs?: number;
}

export function createNotifier(opts: NotifierOptions): Notifier {
  const { token, chatId, threadId, log, fetchImpl = fetch, timeoutMs = 30000 } = opts;

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
    async send(messages: (string | OutboundMessage)[]): Promise<void> {
      for (const raw of messages) {
        const msg: OutboundMessage = typeof raw === 'string' ? { text: raw } : raw;
        // Ліміт Telegram — за ВИДИМИМ текстом (href у <a> не рахується, §9).
        const vis = visibleLength(msg.text);
        if (vis > TELEGRAM_HARD_LIMIT) {
          log?.warn(
            `повідомлення ${vis} (видимих) > ${TELEGRAM_HARD_LIMIT} — render мав чанкувати`,
          );
        }
        const body: Record<string, unknown> = {
          chat_id: chatId,
          text: msg.text,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        };
        if (threadId) body.message_thread_id = threadId;
        if (msg.buttons && msg.buttons.length > 0) {
          body.reply_markup = { inline_keyboard: msg.buttons };
        }
        await call('sendMessage', body);
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
