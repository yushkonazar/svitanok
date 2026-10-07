import { describe, expect, it, vi } from 'vitest';
import { curateNewsGroups } from '../web/core/brief/news-curation.mjs';
import { workerEnv } from './helpers/env.js';
const now = Date.parse('2026-10-06T12:00:00Z');
const entry = (id: string, title: string, at = '2026-10-06T10:00:00Z') => ({
  title,
  url: `https://example.test/${id}`,
  publishedAt: at,
  excerpt: 'Reported details.',
});
const offline = vi.fn(async () => ({ ok: false, error: 'offline' }));
describe('news editorial selection', () => {
  it('allows only known recent event IDs from the history supplied to the editor', async () => {
    const history = [
      {
        storyId: 'known-event',
        observedAt: '2026-10-06T11:00:00Z',
        title: 'Previous report',
        summary: 'Public source details',
      },
    ];
    const editor = async () => ({
      ok: true,
      structured: {
        items: [
          { id: '0', importance: 5, sameEvent: '', previousEvent: 'known-event' },
          { id: '1', importance: 4, sameEvent: '', previousEvent: 'invented' },
        ],
      },
    });
    const r = await curateNewsGroups(
      workerEnv(),
      [
        {
          sourceId: 'bbc-world',
          scope: 'world',
          topic: 'Головне',
          items: [
            entry('update', 'Countries publish new ceasefire conditions'),
            entry('new', 'Space agency announces independent exploration mission'),
          ],
        },
      ],
      now,
      {},
      editor,
      history,
    );
    expect(
      r.groups[0]?.items.find((n: { url: string }) => n.url.endsWith('/update'))?.historyStoryId,
    ).toBe('known-event');
    expect(
      r.groups[0]?.items.find((n: { url: string }) => n.url.endsWith('/new'))?.historyStoryId,
    ).toBeUndefined();
  });
  it('takes only verbatim source evidence for the short summary and retains the raw source for history', async () => {
    const item = {
      ...entry('evidence', 'A meaningful event'),
      excerpt: 'First source sentence with verified information. Another source sentence.',
    };
    const editor = async () => ({
      ok: true,
      structured: {
        items: [
          {
            id: '0',
            importance: 4,
            sameEvent: '',
            excerptQuote: 'First source sentence with verified information.',
          },
        ],
      },
    });
    const r = await curateNewsGroups(
      workerEnv(),
      [{ sourceId: 'bbc-world', scope: 'world', topic: 'Головне', items: [item] }],
      now,
      {},
      editor,
    );
    expect(r.groups[0]?.items[0]).toMatchObject({
      excerpt: 'First source sentence with verified information.',
      sourceExcerpt: item.excerpt,
    });
  });
  it('prioritizes Ukraine/world even when sports are newer and heavily liked', async () => {
    const groups = [
      {
        sourceId: 'sky-football',
        scope: 'world',
        topic: 'Футбол',
        items: [entry('football', 'Football transfer confirmed', '2026-10-06T11:59:00Z')],
      },
      {
        sourceId: 'bbc-world',
        scope: 'world',
        topic: 'Головне',
        items: [entry('world', 'Countries sign ceasefire agreement')],
      },
      {
        sourceId: 'pravda-ua',
        scope: 'ua',
        topic: 'Україна',
        items: [entry('ukraine', 'В Україні ухвалено нове рішення')],
      },
    ];
    const result = await curateNewsGroups(workerEnv(), groups, now, { Футбол: 100 }, offline);
    const picked = result.groups.flatMap((g) => g.items).sort((a, b) => a.rank - b.rank);
    expect(picked.map((n) => n.url).slice(0, 2)).not.toContain('https://example.test/football');
    expect(picked.at(-1)?.url).toBe('https://example.test/football');
  });
  it('considers candidates beyond the first three and keeps supplementary topics represented', async () => {
    const groups = [
      {
        sourceId: 'bbc-world',
        scope: 'world',
        topic: 'Головне',
        items: Array.from({ length: 15 }, (_, i) =>
          entry(`world${i}`, `Country ${i} publishes important policy ${i}`),
        ),
      },
      {
        sourceId: 'pravda-ua',
        scope: 'ua',
        topic: 'Україна',
        items: Array.from({ length: 15 }, (_, i) =>
          entry(`ua${i}`, `В Україні рішення номер ${i}`),
        ),
      },
      ...['Футбол', 'CS2', 'Наука', 'Винаходи й технології'].map((topic, index) => ({
        sourceId: `extra${index}`,
        scope: 'world',
        topic,
        items: Array.from({ length: 15 }, (_, i) =>
          entry(
            `extra${index}-${i}`,
            `${topic} нова важлива подія ${i}`,
            index < 2 ? '2026-10-05T10:00:00Z' : '2026-10-06T11:00:00Z',
          ),
        ),
      })),
    ];
    const result = await curateNewsGroups(workerEnv(), groups, now, {}, offline);
    expect(result.editorial.candidates).toBe(90);
    expect(result.groups.flatMap((g) => g.items).length).toBeLessThanOrEqual(18);
    expect(result.groups[0]?.items.length).toBeGreaterThan(3);
    for (const topic of ['Футбол', 'CS2', 'Наука', 'Винаходи й технології'])
      expect(result.groups.find((g) => g.topic === topic)?.items.length).toBeGreaterThan(0);
  });
  it('merges corroborating event reports and rejects invented editor ids', async () => {
    const editor = vi.fn(async () => ({
      ok: true,
      structured: {
        items: [
          { id: '0', importance: 4, sameEvent: '' },
          { id: '1', importance: 4, sameEvent: '0' },
          { id: '999', importance: 5, sameEvent: '' },
        ],
      },
    }));
    const result = await curateNewsGroups(
      workerEnv(),
      [
        {
          sourceId: 'bbc-world',
          scope: 'world',
          topic: 'Головне',
          items: [
            entry('a', 'World leaders announce a new ceasefire agreement'),
            entry('b', 'New ceasefire agreement announced by world leaders'),
          ],
        },
      ],
      now,
      {},
      editor,
    );
    const articles = result.groups.flatMap((g) => g.items);
    expect(articles).toHaveLength(1);
    expect(articles[0]?.related).toHaveLength(1);
  });
  it('does not conflate similar headlines with different numbered events; reuses editorial cache', async () => {
    const env = workerEnv();
    const editor = vi.fn(async () => ({ ok: true, structured: { items: [] } }));
    const groups = [
      {
        sourceId: 'bbc-world',
        scope: 'world',
        topic: 'Головне',
        items: [
          entry('a', 'Rocket mission 12 launches from space centre today'),
          entry('b', 'Rocket mission 13 launches from space centre today'),
        ],
      },
    ];
    expect((await curateNewsGroups(env, groups, now, {}, editor)).groups[0]?.items).toHaveLength(2);
    await curateNewsGroups(env, groups, now + 60000, {}, editor);
    expect(editor).toHaveBeenCalledTimes(1);
  });
});
