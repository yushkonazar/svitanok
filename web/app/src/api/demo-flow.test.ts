import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
vi.mock('../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
import { fetchStats, fetchSaved, postEvent, postSettings, fetchSettings } from './client.ts';
describe('local preview flows stay isolated and consistent', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('Demo must not call live services');
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());
  it('a confirmed check-in feeds the selected day and the same graph values', async () => {
    await postEvent('checkin', {
      slot: 'morning',
      sleepKind: 'slept',
      sleepH: 7.5,
      energy: 2,
      mood: 4,
      confirmed: true,
    });
    const s = (await fetchStats()).stats,
      point = s.checkinSeries.at(-1)!;
    expect(s.checkinToday?.morning).toMatchObject({ energy: 2, mood: 4, confirmed: true });
    expect(s.checkinRaw.records[point.d]?.morning).toMatchObject({
      energy: 2,
      mood: 4,
      confirmed: true,
    });
    expect(point).toMatchObject({
      energy: 2,
      energyCurve: [2, null, null],
      moodCurve: [4, null, null],
      sleepH: 7.5,
      slots: 1,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('saving and removing a news item survives rereading the archive', async () => {
    const before = await fetchSaved(0, 1000);
    await postEvent('save_news', { url: 'https://www.bbc.com/news/demo', title: 'Demo article' });
    const saved = await fetchSaved(0, 1000);
    expect(saved.total).toBe(before.total + 1);
    expect(saved.items[0]).toMatchObject({
      kind: 'news',
      id: 'https://www.bbc.com/news/demo',
      title: 'Demo article',
    });
    expect((await fetchStats()).stats.savedCount).toBe(saved.total);
    await postEvent('unsave_news', { url: 'https://www.bbc.com/news/demo' });
    expect((await fetchSaved(0, 1000)).total).toBe(before.total);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('news preferences and module toggles persist in the local preview', async () => {
    const next = {
      quiet: { enabled: false, from: '22:00', to: '08:00' },
      modules: { weather: false },
      mutedTopics: [],
      news: { sources: ['HLTV'] as 'HLTV'[], intervalHours: 6 as const },
    };
    await postSettings(next);
    expect((await fetchSettings()).settings).toEqual(next);
    expect(fetch).not.toHaveBeenCalled();
  });
});
