import { describe, it, expect, vi } from 'vitest';
import {
  normalizeLeisureFeedback,
  leisureFeedbackChoices,
  leisureFeedbackScopes,
} from '../web/core/leisure/feedback.mjs';
import {
  leisureIdentity,
  leisureDecisionIndex,
  leisureReactionHidden,
} from '../web/core/leisure/identity.mjs';
import { normalizeLeisureItem } from '../web/core/leisure/model.mjs';
import {
  upsertLeisureItems,
  executeLeisureCommand,
  readLeisureWorkspace,
  publishLeisureEdition,
} from '../web/core/leisure/store.mjs';
import {
  queueLeisureDigest,
  leisureDigestCurrent,
  queueLeisurePlanAlerts,
  leisurePlanAlertCurrent,
} from '../web/core/leisure/notifications.mjs';
import { compactLeisureCatalog } from '../web/core/leisure/store.mjs';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { handleLeisure } from '../web/api-leisure.mjs';
import { buildInitData } from './helpers/init-data.js';
const now = Date.parse('2026-10-19T06:00Z');
const makeItem = async (extra: Record<string, unknown> = {}) =>
  (await normalizeLeisureItem(
    {
      title: 'Музей',
      category: 'place',
      source: 'Видавець',
      sourceUrl: 'https://lviv.travel/ua/events/test',
      ...extra,
    },
    now,
  ))!;
function setup() {
  const d1 = d1FromSqlite(['0002_assistant.sql', '0039_leisure.sql'], { atomicBatch: true });
  const DB = {
    ...d1.stub,
    prepare: (sql: string) => {
      const s = d1.stub.prepare(sql);
      return { ...s, ...s.bind() };
    },
  };
  return {
    ...d1,
    env: workerEnv({
      DB,
      ASSISTANT_HOME: 'dm',
      TELEGRAM_OWNER_USER_ID: '42',
      TELEGRAM_BOT_TOKEN: 'test-token',
      TELEGRAM_BOT_USERNAME: 'test_bot',
    }),
  };
}
const command = (
  op: string,
  id: string | undefined,
  payload: Record<string, unknown>,
  commandId = crypto.randomUUID(),
) => ({ op, id, payload, commandId });
describe('durable leisure choices', () => {
  it('projects older clients safely while format five receives unclassified events', async () => {
    const { env, db } = setup();
    try {
      const item = await makeItem(),
        food = await makeItem({
          category: 'food',
          sourceUrl: 'https://lviv.travel/ua/events/food',
        });
      const unclassified = await makeItem({
        category: 'concert',
        title: 'Невідомий вечір',
        sourceUrl: 'https://example.com/unknown-event',
      });
      await publishLeisureEdition(env, [item, food, unclassified], [], now);
      await executeLeisureCommand(
        env,
        command('draft', undefined, {
          title: 'Чернетка',
          stops: [{ itemId: item.id, startAt: '2026-10-22T15:00Z', endAt: '2026-10-22T17:00Z' }],
        }),
        now,
      );
      const init = await buildInitData(42, 'test-token');
      for (const format of ['3', '4', '5']) {
        const response = await handleLeisure(
          new Request('https://app.test/api/leisure?history=all', {
            headers: { 'X-Telegram-Init-Data': init, 'X-Leisure-Format': format },
          }),
          env,
        );
        const body = (await response.json()) as {
          workspace: {
            items: { category: string }[];
            settings: { telegram: boolean };
            records: { kind: string }[];
          };
        };
        expect(response.status).toBe(200);
        expect(body.workspace.records.some((r) => r.kind === 'draft')).toBe(format !== '3');
        expect(body.workspace.items.some((i) => i.category === 'place')).toBe(format !== '3');
        expect(body.workspace.settings.telegram).toBe(format !== '3');
        expect(body.workspace.items.some((i) => i.category === 'event')).toBe(format === '5');
        expect(body.workspace.items.some((i) => i.category === 'meetup')).toBe(format === '4');
        expect(response.headers.get('cache-control')).toBe('private, no-store');
      }
    } finally {
      db.close();
    }
  });
  it.each([
    'food',
    'place',
    'trip',
    'cinema',
    'concert',
    'festival',
    'show',
    'exhibition',
    'meetup',
    'podcast',
  ])('offers nine distinct applicable reasons for %s', (category) => {
    for (const positive of [true, false]) {
      const choices = leisureFeedbackChoices(category, positive);
      expect(choices).toHaveLength(9);
      expect(new Set(choices.map((c) => c.code)).size).toBe(9);
    }
    if (['food', 'place', 'trip'].includes(category))
      expect(leisureFeedbackChoices(category).some((c) => c.code === 'genre')).toBe(false);
  });
  it('keeps the weekly shortlist across repeated catalogue updates instead of refilling it after choices', async () => {
    const { env, db } = setup();
    try {
      const films = await Promise.all(
        Array.from({ length: 9 }, (_, n) =>
          makeItem({
            category: 'cinema',
            title: 'Фільм ' + n,
            source: 'Видавець ' + n,
            sourceUrl: 'https://planetakino.ua/movie/frozen-' + n + '/',
          }),
        ),
      );
      const first = await publishLeisureEdition(env, films, [], now);
      expect(first.highlightIds).toHaveLength(3);
      const firstId = first.highlightIds[0];
      await executeLeisureCommand(
        env,
        command('reaction', firstId, { verdict: 'interested' }),
        now + 1000,
      );
      const second = await publishLeisureEdition(env, films, [], now + 2000);
      expect(second.highlightIds).toEqual(first.highlightIds);
      expect((await readLeisureWorkspace(env, now + 2000)).edition.highlightIds).toEqual(
        first.highlightIds,
      );
    } finally {
      db.close();
    }
  });
  it('keeps legacy likes, validates category reasons and preserves detail when priority changes', () => {
    const current = {
      verdict: 'interested',
      interestLevel: 'interested',
      reasonCodes: ['topic'],
      reason: 'Хочу нову експозицію',
      revisit: true,
    };
    expect(
      normalizeLeisureFeedback(
        { category: 'place' },
        { verdict: 'interested', interestLevel: 'priority' },
        current,
        now,
      ),
    ).toMatchObject({
      interestLevel: 'priority',
      reasonCodes: ['topic'],
      reason: current.reason,
      revisit: true,
    });
    expect(
      normalizeLeisureFeedback({ category: 'cinema' }, { verdict: 'interested' }, null, now)
        .interestLevel,
    ).toBe('interested');
    expect(leisureFeedbackScopes({ verdict: 'interested', reasonCode: 'other' })).toBeNull();
    expect(() =>
      normalizeLeisureFeedback(
        { category: 'trip' },
        { verdict: 'uninterested', reasonCodes: ['genre'] },
        null,
        now,
      ),
    ).toThrow();
    expect(() =>
      normalizeLeisureFeedback(
        { category: 'cinema' },
        { verdict: 'interested', reasonCodes: ['plot', 'genre', 'cast', 'director'] },
        null,
        now,
      ),
    ).toThrow();
    expect(
      leisureFeedbackScopes({
        category: 'concert',
        verdict: 'uninterested',
        reasonCodes: ['price', 'genre'],
      }),
    ).toEqual(['genre']);
  });
  it('snoozes only to an explicit future date; manual postponement persists across editions', () => {
    const r = normalizeLeisureFeedback({ category: 'food' }, { verdict: 'later' }, null, now);
    expect(leisureReactionHidden({ verdict: 'later', ...r }, now + 60 * 86400000)).toBe(true);
    const until = new Date(now + 86400000).toISOString();
    expect(
      normalizeLeisureFeedback(
        { category: 'food' },
        { verdict: 'later', snoozeUntil: until },
        null,
        now,
      ).snoozeUntil,
    ).toBe(until);
    expect(leisureReactionHidden({ verdict: 'later', snoozeUntil: until }, now + 86400001)).toBe(
      false,
    );
    expect(() =>
      normalizeLeisureFeedback(
        { category: 'food' },
        { verdict: 'later', snoozeUntil: 'invalid' },
        null,
        now,
      ),
    ).toThrow();
  });
  it('merges exact film aliases and event instants but keeps remakes, occurrences and branches distinct', () => {
    const film = {
      category: 'cinema',
      title: 'Назва',
      sourceUrl: 'https://planetakino.ua/movie/example/',
    };
    expect(leisureIdentity(film)).toBe(
      leisureIdentity({ ...film, sourceUrl: film.sourceUrl + '?cinema=forum-lviv' }),
    );
    expect(
      leisureIdentity({ ...film, sourceUrl: 'https://planetakino.ua/movie/remake/' }),
    ).not.toBe(leisureIdentity(film));
    const e = {
      category: 'concert',
      title: 'Гурт',
      venue: 'Клуб',
      startAt: '2026-10-22T18:00:00+03:00',
    };
    expect(leisureIdentity(e)).toBe(
      leisureIdentity({ ...e, startAt: '2026-10-22T15:00:00Z', sourceUrl: 'different-listing' }),
    );
    expect(leisureIdentity(e)).not.toBe(leisureIdentity({ ...e, startAt: '2026-10-23T15:00:00Z' }));
    expect(leisureIdentity({ placeId: 'branch-1' })).not.toBe(
      leisureIdentity({ placeId: 'branch-2' }),
    );
    const index = leisureDecisionIndex(
      [{ id: 'a', ...film }],
      [
        {
          kind: 'discovery',
          identityKey: leisureIdentity(film),
          verdict: 'uninterested',
          at: '2026-10-18T10:00Z',
        },
        { kind: 'reaction', itemId: 'a', verdict: 'clear', at: '2026-10-19T10:00Z' },
      ],
    );
    expect(index.get(leisureIdentity(film)).verdict).toBe('clear');
  });
  it('retains the original card and reaction across listing updates, and rejects stale edits', async () => {
    const { env, db } = setup();
    try {
      const i = await makeItem({
        category: 'concert',
        title: 'Гурт',
        venue: 'Клуб',
        startAt: '2026-10-22T18:00:00+03:00',
      });
      await upsertLeisureItems(env, [i]);
      const cmd = command('reaction', i.id, {
        verdict: 'interested',
        interestLevel: 'priority',
        reasonCodes: ['artist'],
      });
      expect(await executeLeisureCommand(env, cmd, now)).toMatchObject({ revision: 1 });
      expect(await executeLeisureCommand(env, cmd, now)).toMatchObject({ revision: 1 });
      await expect(
        executeLeisureCommand(
          env,
          command('reaction', i.id, { verdict: 'interested', revision: 0 }),
          now,
        ),
      ).rejects.toThrow('змінився');
      const alias = await makeItem({
        category: 'concert',
        title: 'Гурт',
        venue: 'Клуб',
        sourceUrl: 'https://concert.ua/uk/event/alias',
        startAt: '2026-10-22T15:00:00Z',
      });
      await upsertLeisureItems(env, [alias]);
      const result = await readLeisureWorkspace(env, now, true);
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe(i.id);
      expect(result.records[0]).toMatchObject({ interestLevel: 'priority', revision: 1 });
      expect(result.items[0].firstDiscoveredAt).toBe(new Date(now).toISOString());
    } finally {
      db.close();
    }
  });
  it('persists a draft with no calendar work and enforces revision on discard', async () => {
    const { env, db } = setup();
    try {
      const i = await makeItem();
      await upsertLeisureItems(env, [i]);
      const payload = {
        title: 'Наш вечір',
        calendar: false,
        stops: [{ itemId: i.id, startAt: '2026-10-22T15:00Z', endAt: '2026-10-22T17:00Z' }],
      };
      const result = await executeLeisureCommand(env, command('draft', undefined, payload), now);
      expect((await readLeisureWorkspace(env, now, true)).records[0]).toMatchObject({
        kind: 'draft',
        calendar: false,
      });
      await expect(
        executeLeisureCommand(env, command('discard-draft', result.id, { revision: 0 }), now),
      ).rejects.toThrow();
      await executeLeisureCommand(env, command('discard-draft', result.id, { revision: 1 }), now);
      expect((await readLeisureWorkspace(env, now, true)).records[0].discarded).toBe(true);
    } finally {
      db.close();
    }
  });
  it('undoes a quick choice exactly after a legacy concert becomes a workshop, and rejects a stale undo', async () => {
    const { env, db } = setup();
    try {
      const item = await makeItem({ category: 'concert', title: 'Гурт' });
      await upsertLeisureItems(env, [item]);
      await executeLeisureCommand(
        env,
        command('reaction', item.id, {
          verdict: 'interested',
          interestLevel: 'priority',
          reasonCodes: ['artist'],
          reason: 'Старий вибір',
        }),
        now,
      );
      await upsertLeisureItems(env, [
        { ...item, title: 'Серія занять з декоративної кераміки', eventFormat: null },
      ]);
      await executeLeisureCommand(
        env,
        command('reaction', item.id, {
          verdict: 'uninterested',
          reasonCode: 'this-option',
          revision: 1,
        }),
        now + 1000,
      );
      const undo = { verdict: 'interested', restorePrevious: true, revision: 2 };
      await executeLeisureCommand(env, command('reaction', item.id, undo), now + 2000);
      const workspace = await readLeisureWorkspace(env, now + 2000, true);
      expect(workspace.items[0]).toMatchObject({
        id: item.id,
        category: 'meetup',
        eventFormat: 'workshop',
      });
      expect(workspace.records.find((r) => r.kind === 'reaction')).toMatchObject({
        revision: 3,
        verdict: 'interested',
        interestLevel: 'priority',
        reasonCodes: ['artist'],
        reason: 'Старий вибір',
      });
      await expect(
        executeLeisureCommand(env, command('reaction', item.id, undo), now + 3000),
      ).rejects.toThrow('змінився');
      await expect(
        executeLeisureCommand(
          env,
          command('reaction', item.id, { verdict: 'uninterested', restorePrevious: true }),
          now + 3000,
        ),
      ).rejects.toThrow('змінився');
    } finally {
      db.close();
    }
  });
});
describe('weekly leisure digest outbox', () => {
  it('flags a cancelled approved event, preserves its snapshot, and queues one optional owner notice', async () => {
    const { env, db } = setup();
    try {
      const item = await makeItem({
        category: 'concert',
        title: 'Гурт',
        startDate: '2026-10-22',
        endDate: '2026-10-22',
        startAt: '2026-10-22T15:00Z',
        endAt: '2026-10-22T17:00Z',
      });
      await upsertLeisureItems(env, [item]);
      const result = await executeLeisureCommand(
        env,
        command('plan', undefined, {
          title: 'Наш вечір',
          calendar: false,
          calendarUnavailableConfirmed: true,
          stops: [{ itemId: item.id, startAt: '2026-10-22T15:00Z', endAt: '2026-10-22T17:00Z' }],
        }),
        now,
      );
      await upsertLeisureItems(env, [{ ...item, status: 'cancelled', title: 'Оновлена назва' }]);
      const workspace = await readLeisureWorkspace(env, now, true),
        plan = workspace.records.find((r) => r.id === result.id);
      expect(plan.alerts.join(' ')).toContain('скасовано');
      expect(plan.stops[0].title).toBe('Гурт');
      expect(await queueLeisurePlanAlerts(env, now)).toBe(1);
      expect(await queueLeisurePlanAlerts(env, now)).toBe(0);
      const notice = JSON.parse(
        String(db.prepare('SELECT payload_json FROM outbox').get()!.payload_json),
      ).leisure_plan_alert;
      expect(await leisurePlanAlertCurrent(env, notice, now)).toBe(true);
      await executeLeisureCommand(env, command('settings', undefined, { planAlerts: false }), now);
      expect(await leisurePlanAlertCurrent(env, notice, now)).toBe(false);
    } finally {
      db.close();
    }
  });
  it('queues once after the update hour, respects opt-out on delivery, and has no direct send', async () => {
    const { env, db } = setup(),
      fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const i = await makeItem();
      await publishLeisureEdition(env, [i], [], now);
      expect(await queueLeisureDigest(env, now - 2 * 3600000)).toBe(false);
      expect(await queueLeisureDigest(env, now)).toBe(true);
      expect(await queueLeisureDigest(env, now)).toBe(false);
      expect(db.prepare('SELECT count(*) AS n FROM outbox').get()!.n).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
      const payload = JSON.parse(
        String(db.prepare('SELECT payload_json FROM outbox').get()!.payload_json),
      );
      expect(payload.reply_markup.inline_keyboard[0][0].url).toBe(
        'https://t.me/test_bot?startapp=leisure',
      );
      expect(await leisureDigestCurrent(env, payload.leisure_digest, now)).toBe(true);
      await executeLeisureCommand(env, command('settings', undefined, { telegram: false }), now);
      expect(await leisureDigestCurrent(env, payload.leisure_digest, now)).toBe(false);
      expect(await queueLeisureDigest(env, now + 7 * 86400000)).toBe(false);
    } finally {
      fetch.mockRestore();
      db.close();
    }
  });
  it('does not notify when all fresh cards already have decisions', async () => {
    const { env, db } = setup();
    try {
      const i = await makeItem();
      await publishLeisureEdition(env, [i], [], now);
      await executeLeisureCommand(env, command('reaction', i.id, { verdict: 'interested' }), now);
      expect(await queueLeisureDigest(env, now)).toBe(false);
    } finally {
      db.close();
    }
  });
});
describe('provider updates and later occurrences', () => {
  it('keeps a decision across rescheduling and treats the next annual festival as new', async () => {
    const { env, db } = setup();
    try {
      const item = await makeItem({
        category: 'festival',
        startDate: '2026-10-22',
        endDate: '2026-10-22',
      });
      await upsertLeisureItems(env, [item]);
      await executeLeisureCommand(
        env,
        command('reaction', item.id, { verdict: 'interested' }),
        now,
      );
      const moved = await makeItem({
        category: 'festival',
        startDate: '2026-10-23',
        endDate: '2026-10-23',
      });
      await upsertLeisureItems(env, [moved]);
      let data = await readLeisureWorkspace(env, now, true);
      expect(data.items).toHaveLength(1);
      expect(
        leisureDecisionIndex(data.items, data.records).get(data.items[0].identityKey)?.verdict,
      ).toBe('interested');
      const annual = await makeItem({
        category: 'festival',
        startDate: '2027-10-23',
        endDate: '2027-10-23',
      });
      await upsertLeisureItems(env, [annual]);
      data = await readLeisureWorkspace(env, now, true);
      expect(data.items).toHaveLength(2);
      const next = data.items.find((i) => i.startDate === '2027-10-23');
      expect(next.id).not.toBe(item.id);
      expect(leisureDecisionIndex(data.items, data.records).get(next.identityKey)).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it('retains occurrence identity after descriptions have been compacted', async () => {
    const { env, db } = setup();
    try {
      const old = await makeItem({
        category: 'festival',
        startDate: '2025-10-22',
        endDate: '2025-10-22',
      });
      await upsertLeisureItems(env, [old]);
      await executeLeisureCommand(
        env,
        command('reaction', old.id, { verdict: 'uninterested', reasonCodes: ['this-option'] }),
        now,
      );
      await compactLeisureCatalog(env, now);
      const annual = await makeItem({
        category: 'festival',
        startDate: '2026-10-22',
        endDate: '2026-10-22',
      });
      await upsertLeisureItems(env, [annual]);
      const data = await readLeisureWorkspace(env, now, true);
      expect(data.items[0].id).not.toBe(old.id);
      expect(data.edition).toBeNull();
      expect(
        leisureDecisionIndex(data.items, [...data.records, ...data.discoveryDecisions]).get(
          data.items[0].identityKey,
        ),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
