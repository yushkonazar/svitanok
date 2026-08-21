import { describe, it, expect } from 'vitest';
import {
  readJsonBody,
  json,
  MAX_REQUEST_BODY_BYTES,
  MAX_WEBHOOK_BODY_BYTES,
} from '../web/http-core.mjs';

/* Межа входу КОЖНОГО `/api/*`.
 *
 * Доти вона не мала жодного тесту, хоч через неї проходить усе, що надсилає
 * Mini App і Telegram. Перевіряються рівно три її обіцянки:
 *
 *   1. стеля розміру — і по Content-Length (дешевий ранній відсів), і по
 *      РЕАЛЬНИХ байтах (заголовку не віримо);
 *   2. байти, а не символи — кирилиця в UTF-8 важить удвічі, і перевірка по
 *      .length пропускала б удвічі більше за задекларовану межу;
 *   3. тіло — плоский обʼєкт. `JSON.parse` радо віддає масив чи рядок, а кожен
 *      викликач далі індексує результат як обʼєкт: `'x'.type` тихо дає
 *      undefined, і помилковий запит їхав би далі замість зупинитись тут.
 */

const CAP = 16 * 1024;

const post = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://svitanok.example/api/event', { method: 'POST', body, headers });

describe('readJsonBody — форма тіла', () => {
  it('плоский обʼєкт проходить', async () => {
    const r = await readJsonBody(post(JSON.stringify({ type: 'open', n: 1 })));
    expect(r).toEqual({ ok: true, body: { type: 'open', n: 1 } });
  });

  it('порожній обʼєкт — теж легальне тіло', async () => {
    expect(await readJsonBody(post('{}'))).toEqual({ ok: true, body: {} });
  });

  for (const [label, raw] of [
    ['масив', '[]'],
    ['масив із обʼєктами', '[{"type":"open"}]'],
    ['рядок', '"open"'],
    ['число', '42'],
    ['null', 'null'],
    ['true', 'true'],
  ] as const) {
    it(`${label} -> 400, а не «обʼєкт без полів»`, async () => {
      expect(await readJsonBody(post(raw))).toEqual({
        ok: false,
        status: 400,
        error: 'bad-json',
      });
    });
  }

  it('битий JSON -> 400', async () => {
    expect(await readJsonBody(post('{нє JSON'))).toMatchObject({ status: 400, error: 'bad-json' });
  });

  it('порожнє тіло (DELETE без нього) -> 400, викликач це передбачає', async () => {
    expect(await readJsonBody(post(''))).toMatchObject({ status: 400, error: 'bad-json' });
  });
});

describe('readJsonBody — стеля розміру', () => {
  it('завеликий Content-Length відсікається ДО читання тіла', async () => {
    // Заголовок бреше про розмір, тіло крихітне: важливо, що відмова настає
    // все одно — це дешевий ранній відсів, а не перевірка вмісту.
    const r = await readJsonBody(post('{}', { 'content-length': String(CAP + 1) }));
    expect(r).toEqual({ ok: false, status: 413, error: 'body-too-large' });
  });

  it('брехливо МАЛИЙ Content-Length не рятує: рахуються реальні байти', async () => {
    const huge = JSON.stringify({ x: 'a'.repeat(CAP) });
    const r = await readJsonBody(post(huge, { 'content-length': '10' }));
    expect(r).toEqual({ ok: false, status: 413, error: 'body-too-large' });
  });

  it('кирилиця міряється БАЙТАМИ, не символами', async () => {
    // ~9 тис. кириличних символів — це ~18 КБ у UTF-8. Перевірка по .length
    // пропустила б це тіло, перевірка по байтах — ні.
    const cyrillic = JSON.stringify({ x: 'я'.repeat(9000) });
    expect(cyrillic.length).toBeLessThan(CAP);
    expect(new TextEncoder().encode(cyrillic).length).toBeGreaterThan(CAP);
    expect(await readJsonBody(post(cyrillic))).toMatchObject({ status: 413 });
  });

  it('тіло рівно під стелею проходить', async () => {
    const body = { x: 'a'.repeat(CAP - 20) };
    const raw = JSON.stringify(body);
    expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(CAP);
    expect(await readJsonBody(post(raw))).toEqual({ ok: true, body });
  });
});

describe('json — відповідь', () => {
  it('за замовчуванням 200 і JSON-заголовок', async () => {
    const res = json({ ok: true });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it('статус передається', () => {
    expect(json({ ok: false }, 503).status).toBe(503);
  });
});

/* Стеля має бути МЕЖЕЮ, а не лічильником.
 *
 * Доти тіло читалось через `request.text()` — тобто матеріалізувалось ЦІЛКОМ, і
 * лише потім його можна було зміряти. Для запиту без Content-Length (chunked)
 * це означало, що вартість задає той, хто шле: Worker буферизує скільки
 * завгодно, а 413 віддає вже після того, як памʼять витрачено.
 *
 * Тест міряє не статус (він був правильний і раніше), а СКІЛЬКИ прочитано.
 */
describe('readJsonBody — стеля зупиняє читання, а не лише відповідь', () => {
  const CHUNK = 4 * 1024;

  function streamed(chunks: number, pulled: { n: number }) {
    const piece = new Uint8Array(CHUNK).fill(0x61); // 'a'
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= chunks) return void controller.close();
        sent++;
        pulled.n++;
        controller.enqueue(piece);
      },
    });
    // duplex обовʼязковий для потокового тіла; у типах Node його немає.
    return new Request('https://svitanok.example/api/event', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
  }

  it('4 МБ без Content-Length -> 413, прочитано ~стелю, а не все', async () => {
    const pulled = { n: 0 };
    const res = await readJsonBody(streamed(1024, pulled)); // 1024 × 4КБ = 4МБ
    expect(res).toEqual({ ok: false, status: 413, error: 'body-too-large' });
    // 16КБ стелі = 4 шматки; пʼятий переводить лічильник за межу й читання
    // припиняється. Головне тут — що це НЕ 1024.
    expect(pulled.n).toBeLessThanOrEqual(6);
  });

  it('тіло під стелею дочитується повністю', async () => {
    const pulled = { n: 0 };
    // 2 шматки по 4КБ = 8КБ сирих 'a' — не JSON, тож 400; важливо, що не 413.
    const res = await readJsonBody(streamed(2, pulled));
    expect(res).toMatchObject({ status: 400, error: 'bad-json' });
    expect(pulled.n).toBe(2);
  });
});

describe('стеля вебхука Telegram — окрема від /api/*', () => {
  /* 16КБ менші за максимальний ЗАКОННИЙ апдейт: 4096 символів кирилиці — це
   * ~8КБ, а якщо повідомлення є відповіддю, у тому ж апдейті їде вкладений
   * reply_to_message такого самого розміру. Бот відповідав би 413 і не обробляв
   * повідомлення власника взагалі. */
  const bigUpdate = JSON.stringify({
    update_id: 1,
    message: {
      message_id: 2,
      chat: { id: 1 },
      from: { id: 1 },
      text: 'я'.repeat(4096),
      reply_to_message: { message_id: 1, text: 'я'.repeat(4096) },
    },
  });

  it('реалістичний апдейт справді переходить за стелю /api/*', () => {
    const bytes = new TextEncoder().encode(bigUpdate).length;
    expect(bytes).toBeGreaterThan(MAX_REQUEST_BODY_BYTES);
    expect(bytes).toBeLessThan(MAX_WEBHOOK_BODY_BYTES);
  });

  it('зі стелею вебхука такий апдейт проходить', async () => {
    const res = await readJsonBody(post(bigUpdate), MAX_WEBHOOK_BODY_BYTES);
    expect(res.ok).toBe(true);
  });

  it('той самий апдейт на /api/* — 413, стеля не послаблена глобально', async () => {
    expect(await readJsonBody(post(bigUpdate))).toMatchObject({ status: 413 });
  });
});
