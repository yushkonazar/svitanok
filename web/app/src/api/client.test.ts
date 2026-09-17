import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* M3 — клієнтський бік: initData мутацій їде ЗАГОЛОВКОМ.
 *
 * Серверна половина (`tests/mutation-init-data.test.ts`) доводить, що Worker
 * приймає заголовок і поки що терпить поле в тілі. Тут перевіряється те, чого
 * та половина побачити не може: що клієнт заголовок реально СТАВИТЬ — і що
 * initData більше не лишилось у тілі.
 *
 * Друга частина важлива не менше за першу. Фолбек на тілі навмисно тимчасовий;
 * якби клієнт продовжував дублювати поле, прибрати фолбек було б неможливо -
 * зелені тести показували б «усе на заголовку», а прод їхав би на тілі.
 */

const tg = { initData: 'query_id=AAA&user=%7B%22id%22%3A4242%7D&hash=deadbeef' };

vi.mock('../telegram.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../telegram.ts')>();
  return { ...actual, tg, inTelegram: () => true };
});

const {
  postEvent,
  postVote,
  postSettings,
  setWeatherLocation,
  setWeatherLocationExact,
  clearWeatherLocation,
  requestLocatePrompt,
  fetchStats,
  fetchBriefing,
  fetchDeletionReceipts,
  fetchSettings,
  fetchSaved,
} = await import('./client.ts');

const SETTINGS = {
  quiet: { enabled: false, from: '22:00', to: '08:00' },
  modules: {},
  mutedTopics: [],
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Остання відправка: заголовки (нижнім регістром) + розібране тіло. */
function lastCall() {
  const [url, init] = fetchMock.mock.calls.at(-1) as [string, RequestInit];
  const headers = Object.fromEntries(
    Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
      k.toLowerCase(),
      v,
    ]),
  );
  return {
    url,
    method: init.method,
    headers,
    body: typeof init.body === 'string' ? JSON.parse(init.body) : init.body,
  };
}

beforeEach(() => {
  fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          ok: true,
          manualGeo: { name: 'Львів' },
          weight: 1,
          voted: 'up',
          settings: SETTINGS,
          connectors: { google: false, calendar: false, gmail: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const MUTATIONS: [string, () => Promise<unknown>][] = [
  ['postEvent', () => postEvent('open', { n: 1 })],
  ['postVote', () => postVote('tech', 'https://example.com/a')],
  ['postSettings', () => postSettings(SETTINGS)],
  ['setWeatherLocation', () => setWeatherLocation('Львів')],
  [
    'setWeatherLocationExact',
    () => setWeatherLocationExact({ lat: 49.84, lon: 24.03, name: 'Львів' }),
  ],
  ['clearWeatherLocation', () => clearWeatherLocation()],
  ['requestLocatePrompt', () => requestLocatePrompt()],
];

describe('M3 — мутації клієнта автентифікуються заголовком', () => {
  for (const [name, run] of MUTATIONS) {
    it(`${name}: X-Telegram-Init-Data у заголовках`, async () => {
      await run();
      expect(lastCall().headers['x-telegram-init-data']).toBe(tg.initData);
    });

    it(`${name}: initData НЕ дублюється в тілі`, async () => {
      await run();
      const { body } = lastCall();
      expect(body === undefined || !(body as Record<string, unknown>).initData).toBe(true);
    });
  }
});

describe('401/403 у Telegram — не демо, а blocking session-expired сигнал', () => {
  for (const status of [401, 403] as const) {
    it.each([
      ['stats', () => fetchStats()],
      ['briefing', () => fetchBriefing()],
      ['deletions', () => fetchDeletionReceipts()],
      ['settings', () => fetchSettings()],
      ['saved', () => fetchSaved(0)],
    ])('%s: HTTP ' + status + ' не підставляє sample-дані', async (_name, run) => {
      fetchMock.mockResolvedValueOnce(new Response('', { status }));
      await expect(run()).rejects.toMatchObject({
        name: 'SessionExpiredError',
        status,
      });
    });
  }
});

describe('GET /api/deletions — приватна read-only квитанція', () => {
  it('їде з Telegram auth-заголовком, парситься вузько й не пропускає server id', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          retentionDays: 90,
          receipts: [
            {
              id: 'server-private-id',
              requestedAt: '2026-09-16T10:00:00.000Z',
              updatedAt: '2026-09-16T10:02:00.000Z',
              retainedUntil: '2026-12-15T10:00:00.000Z',
              status: 'completed',
              scope: 'all',
              error: null,
              stages: {
                queues: { status: 'completed', count: 2 },
                sdkSessions: { status: 'completed', count: 3 },
                vectors: { status: 'completed', count: 4 },
                backups: { status: 'completed', count: 1 },
                local: { status: 'completed', count: 0, rows: 10, kvKeys: 5 },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const result = await fetchDeletionReceipts();

    expect(lastCall().url).toBe('/api/deletions');
    expect(lastCall().headers['x-telegram-init-data']).toBe(tg.initData);
    expect(JSON.stringify(result)).not.toContain('server-private-id');
    expect(result.receipts[0]?.stages.local).toMatchObject({ rows: 10, kvKeys: 5 });
  });
});
