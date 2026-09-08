// Відправка медіа з байтів у Telegram (етап 7 PR-3): згенеровані зображення
// й відео.
//
// ⚠️ ЧОМУ ПОВЗ OUTBOX. Черга зберігає payload у D1, а рядок D1 не тримає
// мегабайтів: картинка 1-2 МБ у base64 - це вже ~2,7 МБ на рядок. Тому
// медіа йде прямим викликом, а в чергу лягає лише текстовий супровід. Ціна
// рішення чесна й названа: якщо Telegram відмовить, повтору з черги не буде,
// і власник почує, що згенероване не доставилось (гроші вже витрачені).

const TG_API = 'https://api.telegram.org';
const SEND_TIMEOUT_MS = 120_000;

/**
 * sendPhoto / sendVideo з байтами (multipart).
 * @param {Env} env
 * @param {{ chatId: number | string, threadId: number | string | null }} target
 * @param {{ kind: 'photo' | 'video', bytes: Uint8Array, mime: string,
 *   filename: string, caption?: string, buttons?: unknown }} media
 * @returns {Promise<{ ok: true, messageId: number | null }>}
 */
export async function sendMediaBytes(env, target, media) {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN не задано');
  const form = new FormData();
  form.set('chat_id', String(target.chatId));
  if (target.threadId != null) form.set('message_thread_id', String(target.threadId));
  if (media.caption) form.set('caption', media.caption.slice(0, 1024));
  if (media.buttons) form.set('reply_markup', JSON.stringify({ inline_keyboard: media.buttons }));
  form.set(media.kind, new Blob([media.bytes], { type: media.mime }), media.filename);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEND_TIMEOUT_MS);
  try {
    const method = media.kind === 'photo' ? 'sendPhoto' : 'sendVideo';
    const res = await fetch(`${TG_API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
      method: 'POST',
      body: form,
      signal: ctrl.signal,
    });
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      throw new Error(`Telegram ${method} HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    let messageId = null;
    try {
      messageId = JSON.parse(text)?.result?.message_id ?? null;
    } catch {
      // id не критичний - доставку вже підтверджено статусом.
    }
    return { ok: true, messageId };
  } finally {
    clearTimeout(timer);
  }
}
