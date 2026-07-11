import { describe, it, expect, vi } from 'vitest';
import {
  escapeHtml,
  fitEscaped,
  createNotifier,
  buildMiniAppButton,
  TELEGRAM_HARD_LIMIT,
} from '../src/core/telegram.js';

describe('escapeHtml', () => {
  it('екранує &, <, >', () => {
    expect(escapeHtml('a & b < c > <script>')).toBe('a &amp; b &lt; c &gt; &lt;script&gt;');
  });
});

describe('fitEscaped — entity-safe обрізання (§9)', () => {
  it('короткий текст лишається повним', () => {
    expect(fitEscaped('hello', 100)).toBe('hello');
  });

  it('довгий — обрізається з «…» під бюджет', () => {
    const out = fitEscaped('a'.repeat(100), 10);
    expect(out.length).toBeLessThanOrEqual(10);
    expect(out.endsWith('…')).toBe(true);
  });

  it('не лишає обірваної HTML-сутності', () => {
    const out = fitEscaped('&&&&&&&&&&', 8); // кожен & -> &amp; (5 units)
    // кожен '&' у виводі має бути частиною повної &amp;
    expect(out.replace(/&amp;/g, '').includes('&')).toBe(false);
  });

  it('не розриває сурогатну пару (емодзі)', () => {
    expect(fitEscaped('👍👍👍', 3)).toBe('👍…'); // один емодзі (2 units) + …
    const tiny = fitEscaped('👍👍', 2); // не влазить жоден повний емодзі
    expect(tiny).toBe('…');
  });
});

describe('buildMiniAppButton', () => {
  it('будує кнопку web_app (не callback_data)', () => {
    expect(buildMiniAppButton('📊 Відкрити', 'https://svitanok.example.workers.dev')).toEqual({
      text: '📊 Відкрити',
      web_app: { url: 'https://svitanok.example.workers.dev' },
    });
  });
});

describe('createNotifier', () => {
  it('send робить sendMessage з parse_mode HTML', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return new Response('{"ok":true}', { status: 200 });
    });
    const n = createNotifier({
      token: 'T',
      chatId: '42',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await n.send(['<b>hi</b>']);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain('/botT/sendMessage');
    expect(calls[0]!.body).toMatchObject({ chat_id: '42', parse_mode: 'HTML', text: '<b>hi</b>' });
  });

  it('send з buttons -> reply_markup.inline_keyboard; без buttons -> без reply_markup', async () => {
    const calls: unknown[] = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response('{"ok":true}', { status: 200 });
    });
    const n = createNotifier({
      token: 'T',
      chatId: '42',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await n.send([
      { text: 'з кнопками', buttons: [[{ text: '💾', callback_data: 'v1:2026-07-09:js:0' }]] },
      { text: 'без кнопок' },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      text: 'з кнопками',
      reply_markup: { inline_keyboard: [[{ text: '💾', callback_data: 'v1:2026-07-09:js:0' }]] },
    });
    expect(calls[1]).not.toHaveProperty('reply_markup');
  });

  it('send з web_app-кнопкою (Mini App) -> те саме reply_markup.inline_keyboard', async () => {
    const calls: unknown[] = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response('{"ok":true}', { status: 200 });
    });
    const n = createNotifier({
      token: 'T',
      chatId: '42',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await n.send([
      {
        text: 'Субота, 11 липня',
        buttons: [[buildMiniAppButton('📊 Відкрити Mini App', 'https://x/app')]],
      },
    ]);
    expect(calls[0]).toMatchObject({
      text: 'Субота, 11 липня',
      reply_markup: {
        inline_keyboard: [[{ text: '📊 Відкрити Mini App', web_app: { url: 'https://x/app' } }]],
      },
    });
  });

  it('threadId (Блок «Теми») -> message_thread_id у sendMessage; не задано -> відсутнє', async () => {
    const calls: unknown[] = [];
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(init.body as string));
      return new Response('{"ok":true}', { status: 200 });
    });
    const withThread = createNotifier({
      token: 'T',
      chatId: '42',
      threadId: '7',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await withThread.send(['з темою']);
    expect(calls[0]).toMatchObject({ message_thread_id: '7' });

    const withoutThread = createNotifier({
      token: 'T',
      chatId: '42',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await withoutThread.send(['без теми (DM)']);
    expect(calls[1]).not.toHaveProperty('message_thread_id');
  });

  it('failNotify шле плейн-текст (без HTML)', async () => {
    let body: Record<string, unknown> = {};
    const fakeFetch = vi.fn(async (_url: string, init: RequestInit) => {
      body = JSON.parse(init.body as string);
      return new Response('{"ok":true}', { status: 200 });
    });
    const n = createNotifier({
      token: 'T',
      chatId: '42',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await n.failNotify('щось зламалось');
    expect(body.parse_mode).toBeUndefined();
    expect(body.text).toBe('щось зламалось');
  });

  it('кидає на HTTP-помилці', async () => {
    const fakeFetch = vi.fn(async () => new Response('bad', { status: 400 }));
    const n = createNotifier({
      token: 'T',
      chatId: '42',
      fetchImpl: fakeFetch as unknown as typeof fetch,
    });
    await expect(n.send(['x'])).rejects.toThrow(/HTTP 400/);
  });

  it('TELEGRAM_HARD_LIMIT = 4096', () => {
    expect(TELEGRAM_HARD_LIMIT).toBe(4096);
  });
});
