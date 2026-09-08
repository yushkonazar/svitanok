// Виконавці calendar.event / invite (етап 5 PR-2 - мінімум для S-1-9/S-1-10):
// після ✅ подія створюється в Google Calendar (нагадування, локація,
// учасники за email або через Contacts); invite без жодного email - відмова;
// кривий payload - відмова до походу в Google; збій Google - помилка, не тиха
// «виконана» пропозиція.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { applyPolicy, resolveProposal, resolveUndo } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-07T07:00:00.000Z');
const FRESH_TOKEN = JSON.stringify({ token: 'tok-1', expMs: Date.now() + 3_600_000 });

function setup() {
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql']);
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
      if (String(url).includes('people.googleapis.com')) {
        return new Response(
          JSON.stringify({
            results: [
              {
                person: {
                  names: [{ displayName: 'Оля' }],
                  emailAddresses: [{ value: 'olya@x.ua' }],
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      if (String(url).includes('/calendars/primary/events')) {
        return new Response(JSON.stringify({ id: 'ev-1' }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    }),
  );
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(new Map([['googleToken', FRESH_TOKEN]])),
    GOOGLE_CLIENT_ID: 'c',
    GOOGLE_CLIENT_SECRET: 's',
    GOOGLE_REFRESH_TOKEN: 'r',
  });
  return { env, calls };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Дія за політикою в однаковій формі, який би рівень вона не мала.
 * ⚠️ Від 08.09 подія БЕЗ гостей - T0 (виконується одразу, «↩» її видаляє), а з
 * гостями лишається T1 (це вже лист іншій людині). Тест має перевіряти
 * ВИКОНАВЦЯ, а не рівень, тож обидві гілки зводяться до одного результату;
 * сам рівень перевіряється окремим тестом нижче.
 */
async function approve(env: Env, kind: string, payload: Record<string, unknown>) {
  const out = await applyPolicy(env, { kind, payload, threadId: '99', tainted: false }, NOW);
  if (out.mode === 'error') return { ok: false, error: out.error };
  if (out.mode === 'executed')
    return { ok: true, status: 'approved', executed: true, result: out.result };
  return resolveProposal(env, { id: out.proposal.id, choice: 'ok' }, NOW + 1000);
}

describe('calendar.event', () => {
  it('після ✅ - подія з нагадуванням і локацією; результат несе event_id', async () => {
    const { env, calls } = setup();
    const res = await approve(env, 'calendar.event', {
      title: 'Вийти до «Креденс»',
      startIso: '2026-09-07T15:25:00.000Z',
      endIso: '2026-09-07T16:00:00.000Z',
      reminderMinutes: 5,
      location: 'вул. Вірменська 6',
    });
    expect(res).toMatchObject({
      ok: true,
      status: 'approved',
      executed: true,
      result: { title: 'Вийти до «Креденс»', event_id: 'ev-1', attendees: [] },
    });
    const create = calls.find((c) => c.url.includes('/calendars/primary/events'))!;
    expect(create.body).toEqual({
      summary: 'Вийти до «Креденс»',
      start: { dateTime: '2026-09-07T15:25:00.000Z', timeZone: 'Europe/Kyiv' },
      end: { dateTime: '2026-09-07T16:00:00.000Z', timeZone: 'Europe/Kyiv' },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 5 }] },
      location: 'вул. Вірменська 6',
    });
    expect(create.url).not.toContain('sendUpdates');
  });

  it('reminderMinutes null / відʼємне / дробове - подія без нагадування, не «0 хв»', async () => {
    for (const bad of [null, -5, 2.5, '5']) {
      const { env, calls } = setup();
      await approve(env, 'calendar.event', {
        title: 'X',
        startIso: '2026-09-07T15:00:00.000Z',
        endIso: '2026-09-07T16:00:00.000Z',
        reminderMinutes: bad,
      });
      const create = calls.find((c) => c.url.includes('/calendars/primary/events'))!;
      expect((create.body as { reminders?: unknown }).reminders).toBeUndefined();
    }
  });

  // ⚠️ Помилка на шляху T0 ЛЕТИТЬ назовні, а не вертається полем: applyPolicy
  // виконує T0 без перехоплення, і ловить її вже router (502 tool-failed із
  // причиною). Тиша тут була б гіршою за виняток - модель мусить знати, що
  // події немає.
  it('кривий payload (без title / кінець до початку) - помилка без походу в Google', async () => {
    const { env, calls } = setup();
    await expect(
      approve(env, 'calendar.event', {
        startIso: '2026-09-07T16:00:00.000Z',
        endIso: '2026-09-07T15:00:00.000Z',
      }),
    ).rejects.toThrow(/потрібні title, startIso, endIso/);
    expect(calls.filter((c) => c.url.includes('googleapis.com/calendar'))).toHaveLength(0);
  });

  it('Google відмовив - помилка виконання, не тихий успіх', async () => {
    const { env } = setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"error":"x"}', { status: 403 })),
    );
    await expect(
      approve(env, 'calendar.event', {
        title: 'X',
        startIso: '2026-09-07T15:00:00.000Z',
        endIso: '2026-09-07T16:00:00.000Z',
      }),
    ).rejects.toThrow(/Google не створив подію/);
  });
});

describe('invite', () => {
  it('email-и як є + імена через Contacts; sendUpdates=all; без жодного email - відмова', async () => {
    const { env, calls } = setup();
    const res = await approve(env, 'invite', {
      title: 'Креденс',
      startIso: '2026-09-07T16:00:00.000Z',
      endIso: '2026-09-07T18:00:00.000Z',
      attendees: ['marko@x.ua', 'Оля'],
    });
    expect(res).toMatchObject({
      ok: true,
      executed: true,
      result: { attendees: ['marko@x.ua', 'olya@x.ua'], notes: [] },
    });
    const create = calls.find((c) => c.url.includes('/calendars/primary/events'))!;
    expect(create.url).toContain('sendUpdates=all');
    expect((create.body as { attendees: unknown }).attendees).toEqual([
      { email: 'marko@x.ua' },
      { email: 'olya@x.ua' },
    ]);

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })),
    );
    const none = await approve(env, 'invite', {
      title: 'Креденс',
      startIso: '2026-09-07T16:00:00.000Z',
      endIso: '2026-09-07T18:00:00.000Z',
      attendees: ['Хтось'],
    });
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining('жодного email') });
  });
});

describe('рівень події - за гостями (реліз 08.09)', () => {
  it('без гостей - T0 одразу з «↩»; «↩» видаляє подію з календаря', async () => {
    const { env, calls } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'calendar.event',
        payload: {
          title: 'Своя справа',
          startIso: '2026-09-07T15:00:00.000Z',
          endIso: '2026-09-07T16:00:00.000Z',
        },
        threadId: '99',
        tainted: false,
      },
      NOW,
    );
    expect(out.mode).toBe('executed');
    const undoId = out.mode === 'executed' ? out.undo?.id : undefined;
    expect(undoId).toBeTruthy();
    expect(await resolveUndo(env, String(undoId), NOW + 1000)).toMatchObject({
      ok: true,
      status: 'undone',
    });
    const del = calls.find((c) => c.url.includes('/events/ev-1'));
    expect(del).toBeDefined();
  });

  it('З ГОСТЯМИ - T1: лист іншій людині назад не забереш', async () => {
    const { env } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'calendar.event',
        payload: {
          title: 'Зустріч',
          startIso: '2026-09-07T15:00:00.000Z',
          endIso: '2026-09-07T16:00:00.000Z',
          attendees: ['olya@x.ua'],
        },
        threadId: '99',
        tainted: false,
      },
      NOW,
    );
    expect(out).toMatchObject({ mode: 'proposed', proposal: { level: 'T1' } });
  });

  it('порожній список гостей - це «без гостей», не T1', async () => {
    const { env } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'calendar.event',
        payload: {
          title: 'Х',
          startIso: '2026-09-07T15:00:00.000Z',
          endIso: '2026-09-07T16:00:00.000Z',
          attendees: ['  '],
        },
        threadId: '99',
        tainted: false,
      },
      NOW,
    );
    expect(out.mode).toBe('executed');
  });
});
