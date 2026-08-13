import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// @ts-expect-error — JS-модуль Worker'а без типів
import worker from '../web/worker.js';
// @ts-expect-error — JS-модуль Worker'а без типів
import { STATUS_KEY } from '../web/api-status.mjs';

/* GET /api/status — ПУБЛІЧНИЙ ендпоінт для зовнішнього бейджа «живий сервіс».
 *
 * ⚠️ ГОЛОВНИЙ ІНВАРІАНТ: усе, що він віддає, віддається ВСІМ. Автентифікації
 * немає, тож тіло мусить містити рівно одне поле — мітку часу останнього
 * брифінгу. Ні ідентифікаторів, ні статистики, ні вмісту брифінгу.
 *
 * Саме тому значення живе в ОКРЕМОМУ KV-ключі, а не в блобі `state`: читати
 * заради одного поля блоб, у якому лежать нагадування, прогрес роадмепу й
 * стан асистента, означало б тримати весь приватний стан за один баг від
 * публічної відповіді.
 */

const envWith = (value: string | null) => ({
  BRIEFING: {
    get: async (key: string) => (key === STATUS_KEY ? value : null),
  },
  // Фолбек статики: усе, що не збіглося з маршрутом, воркер віддає сюди. Без
  // цієї заглушки «маршрут не спрацював» виглядало б як падіння, а не як
  // провал у статику — тобто тест не відрізняв би одне від одного.
  ASSETS: { fetch: async () => new Response('not found', { status: 404 }) },
});

const call = (env: unknown, path = '/api/status', method = 'GET') =>
  worker.fetch(new Request(`https://svitanok.yushko.dev${path}`, { method }), env, {
    waitUntil: () => {},
  });

describe('GET /api/status — контракт тіла', () => {
  it('віддає РІВНО один ключ і нічого більше', async () => {
    const res = await call(envWith(JSON.stringify({ lastBriefingAt: '2026-08-13T06:05:00.000Z' })));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['lastBriefingAt']);
    expect(body.lastBriefingAt).toBe('2026-08-13T06:05:00.000Z');
  });

  it('зайві поля у KV-записі назовні НЕ просочуються', async () => {
    // Ключ пише інший процес (оркестратор). Якщо він колись почне класти туди
    // більше, публічна відповідь не має це підхопити автоматично.
    const res = await call(
      envWith(JSON.stringify({ lastBriefingAt: '2026-08-13T06:05:00.000Z', chatId: 12345 })),
    );
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['lastBriefingAt']);
    expect(JSON.stringify(body)).not.toContain('12345');
  });

  it('ключа ще немає -> null, а не падіння', async () => {
    const res = await call(envWith(null));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lastBriefingAt: null });
  });

  it('битий JSON у ключі -> null, а не 500', async () => {
    const res = await call(envWith('не-json'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lastBriefingAt: null });
  });

  it('запис без очікуваного поля -> null', async () => {
    const res = await call(envWith(JSON.stringify({ somethingElse: 1 })));
    expect(await res.json()).toEqual({ lastBriefingAt: null });
  });

  it('нерядкове значення не віддається як є', async () => {
    const res = await call(envWith(JSON.stringify({ lastBriefingAt: 1755065100000 })));
    expect(await res.json()).toEqual({ lastBriefingAt: null });
  });
});

describe('GET /api/status — заголовки', () => {
  it('JSON, звужений origin і пʼятихвилинний кеш', async () => {
    const res = await call(envWith(JSON.stringify({ lastBriefingAt: '2026-08-13T06:05:00.000Z' })));
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    // Звужений origin, а не '*': ендпоінт мінімальний, але це нічого не коштує.
    expect(res.headers.get('access-control-allow-origin')).toBe('https://yushko.dev');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('заголовки ті самі й коли значення ще немає', async () => {
    // Інакше бейдж на порожньому старті впирався б у CORS замість «нічого не показувати».
    const res = await call(envWith(null));
    expect(res.headers.get('access-control-allow-origin')).toBe('https://yushko.dev');
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });
});

describe('GET /api/status — доступ', () => {
  it('працює БЕЗ будь-якої автентифікації', async () => {
    // Жодного initData/секрету в запиті — і це навмисно: бейдж зовнішній.
    const res = await call(envWith(JSON.stringify({ lastBriefingAt: '2026-08-13T06:05:00.000Z' })));
    expect(res.status).toBe(200);
  });

  it('шлях лишається під наявним rate-limit-правилом /api/*', () => {
    // Правило WAF — starts_with(http.request.uri.path, "/api/") з винятками
    // /api/telegram і /api/agent-step. Тест пришпилює саме те, що ламається
    // мовчки: якби маршрут назвали /status або /api/telegram-status, він би
    // випав із-під ліміту (у другому випадку — через префікс винятку).
    const path = '/api/status';
    expect(path.startsWith('/api/')).toBe(true);
    for (const exempt of ['/api/telegram', '/api/agent-step']) {
      expect(path.startsWith(exempt)).toBe(false);
    }
  });

  it('не-GET не обслуговується цим маршрутом — падає у статику', async () => {
    const res = await call(envWith(null), '/api/status', 'POST');
    expect(res.status).toBe(404);
    // І, головне, не отримує публічних заголовків: гілка просто не спрацювала.
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

/* ⚠️ МЕХАНІЧНИЙ ЗАМОК НА НАЗВУ КЛЮЧА.
 *
 * Пише мітку оркестратор (src/orchestrator.ts, TS-світ), читає воркер
 * (web/api-status.mjs, .mjs-світ) — імпортувати одне в інше нічим, тож назва
 * ключа існує у двох місцях. Розійдуться — ендпоінт мовчки віддаватиме null
 * НАЗАВЖДИ: жодного винятку, жодного падіння тесту, просто бейдж, який ніколи
 * не оживає. Саме той різновид поломки, який без механічної перевірки живе
 * місяцями.
 *
 * Тому звіряємо джерело напряму: у файлі запису мусить бути рівно та назва,
 * яку читає ендпоінт. */
describe('ключ статусу — одна назва на обох боках', () => {
  const orchestrator = readFileSync(join(__dirname, '..', 'src', 'orchestrator.ts'), 'utf8');

  it('оркестратор пише саме той ключ, який читає ендпоінт', () => {
    expect(orchestrator).toContain(`'${STATUS_KEY}'`);
    // І щоб тест не проходив «просто тому, що рядок десь є»: назва мусить
    // стояти саме в аргументах запису в KV. Без регексу — його екранування у
    // шаблонному рядку вже раз дало зламаний патерн, що мовчки нічого не
    // перевіряв би.
    const callsWithKey = orchestrator
      .split('writeKvJson(')
      .slice(1)
      .filter((tail) => tail.slice(0, 80).includes(`'${STATUS_KEY}'`));
    expect(callsWithKey).toHaveLength(1);
  });

  it('запис іде ПІСЛЯ відправки — рядок стоїть нижче за send щоденного', () => {
    // Порядок у файлі — не доказ порядку виконання, але зсув запису ВГОРУ, за
    // межі успішного send, помітно саме так. Поведінковий бік перевіряє
    // flow.test.ts («провал відправки -> мітки немає»).
    const sendAt = orchestrator.indexOf('notifier.send([dailyMessage])');
    const writeAt = orchestrator.indexOf(`'${STATUS_KEY}'`);
    expect(sendAt).toBeGreaterThan(0);
    expect(writeAt).toBeGreaterThan(sendAt);
  });
});
