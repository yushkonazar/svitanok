// Проактивна підказка (етап 3 PR-7, S-0-16): гейт 10:00 Києва, ≤ 1 на добу
// (мітка ставиться і без кандидата), пріоритет trips → subscriptions →
// chains → ideas → security, mute через facts.setting.hint_mute_json,
// доставка в тему «Асистент» через outbox. Реальні міграції у node:sqlite.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  dailyHintTask,
  pickHint,
  formatHint,
  muteHintTopic,
  DAILY_HINT_MARKER_KEY,
  HINT_TOPICS,
} from '../web/core/hints/daily-hint.mjs';
import { runFactsSet } from '../web/core/tools/facts.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0004_ideas_travel.sql',
  '0005_finance.sql',
];
// Пʼятниця 04.09.2026 10:10 Києва = 07:10Z.
const AT_1010 = Date.parse('2026-09-04T07:10:00.000Z');
const AT_0910 = Date.parse('2026-09-04T06:10:00.000Z');
const TODAY = '2026-09-04';

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const d1 = d1FromSqlite(MIGRATIONS);
  const kv = new Map<string, string>();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }),
    ),
  );
  const env = workerEnv({
    DB: d1.stub,
    BRIEFING: memoryKv(kv),
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_BOT_TOKEN: 'tok',
    TOPIC_ASSISTANT: '99',
  });
  const sentTexts = () =>
    (
      d1.db.prepare('SELECT thread_id, payload_json FROM outbox').all() as {
        thread_id: string;
        payload_json: string;
      }[]
    ).map((r) => ({ thread: r.thread_id, text: JSON.parse(r.payload_json).text as string }));
  return { d1, kv, env, sentTexts };
}

describe('dailyHintTask - гейти і дедуп', () => {
  it('поза 10:00 - пропуск; без кандидатів о 10:10 - тиша, але мітка дня стоїть; другий тік - done', async () => {
    const { env, kv, sentTexts } = setup();
    // Свіжий Security Checkup - інакше саме він був би кандидатом.
    await runFactsSet(
      env,
      { kind: 'setting', key: 'security_checkup_at', value: '2026-08-20', source: 'owner' },
      AT_1010,
    );
    expect(await dailyHintTask(env, AT_0910)).toEqual({ skipped: 'hour' });
    expect(await dailyHintTask(env, AT_1010)).toEqual({ sent: false, muted: [] });
    expect(kv.get(DAILY_HINT_MARKER_KEY)).toBe(TODAY);
    expect(sentTexts()).toEqual([]);
    expect(await dailyHintTask(env, AT_1010 + 60_000)).toEqual({ skipped: 'done' });
  });

  it('ідея без руху 30+ діб → одна підказка в тему «Асистент»; наступного дня - не повторюється тією ж міткою', async () => {
    const { d1, env, sentTexts } = setup();
    d1.db
      .prepare(
        `INSERT INTO ideas (id, title, status, created_at, updated_at) VALUES ('i1', 'Експорт у Sheets', 'нова', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
      )
      .run();
    expect(await dailyHintTask(env, AT_1010)).toEqual({ sent: true, topic: 'ideas' });
    const sent = sentTexts();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.thread).toBe('99');
    expect(sent[0]?.text).toContain('Ідея #1 «Експорт у Sheets»');
    expect(sent[0]?.text).toContain('без руху 65 днів');
    expect(sent[0]?.text).toContain('«не нагадуй про ideas»');
  });
});

describe('pickHint - пріоритет і mute', () => {
  it('trips перед subscriptions перед chains перед ideas перед security; свіжі ідеї не рахуються', async () => {
    const { d1, env } = setup();
    d1.db
      .prepare(
        `INSERT INTO ideas (id, title, status, created_at, updated_at) VALUES ('i1', 'Стара', 'у роботі', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
      )
      .run();
    d1.db
      .prepare(
        `INSERT INTO ideas (id, title, status, created_at, updated_at) VALUES ('i2', 'Свіжа', 'нова', '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z')`,
      )
      .run();
    d1.db
      .prepare(
        `INSERT INTO chains (id, kind, status, created_at, updated_at) VALUES ('c1', 'table', 'waiting', '2026-08-20T00:00:00Z', '2026-08-30T00:00:00Z')`,
      )
      .run();
    d1.db
      .prepare(
        `INSERT INTO subscriptions (id, merchant, period, amount, currency, next_at, status, created_at) VALUES ('s1', 'Spotify', 'month', 499, 'USD', '2026-09-06T00:00:00Z', 'active', '2026-08-01T00:00:00Z')`,
      )
      .run();
    d1.db
      .prepare(
        `INSERT INTO trips (id, to_text, date_from, status) VALUES ('t1', 'Львів', '2026-09-08', 'planned')`,
      )
      .run();

    expect(await pickHint(env, TODAY, AT_1010, [])).toEqual({
      topic: 'trips',
      text: 'Поїздка «Львів» через 4 дні - перевір чеклист.',
    });
    expect(await pickHint(env, TODAY, AT_1010, ['trips'])).toEqual({
      topic: 'subscriptions',
      text: 'Списання Spotify 4.99 USD - 06.09.',
    });
    expect((await pickHint(env, TODAY, AT_1010, ['trips', 'subscriptions']))?.topic).toBe('chains');
    const idea = await pickHint(env, TODAY, AT_1010, ['trips', 'subscriptions', 'chains']);
    expect(idea?.topic).toBe('ideas');
    expect(idea?.text).toContain('«Стара»');
    expect(idea?.text).not.toContain('Свіжа');
    const security = await pickHint(env, TODAY, AT_1010, [
      'trips',
      'subscriptions',
      'chains',
      'ideas',
    ]);
    expect(security?.topic).toBe('security');
    expect(await pickHint(env, TODAY, AT_1010, HINT_TOPICS)).toBeNull();
  });

  it('security: свіжий checkup (< 90 діб) - тихо; старий - нагадування', async () => {
    const { env } = setup();
    await runFactsSet(
      env,
      { kind: 'setting', key: 'security_checkup_at', value: '2026-08-01', source: 'owner' },
      AT_1010,
    );
    expect(
      await pickHint(env, TODAY, AT_1010, ['trips', 'subscriptions', 'chains', 'ideas']),
    ).toBeNull();
    await runFactsSet(
      env,
      { kind: 'setting', key: 'security_checkup_at', value: '2026-01-01', source: 'owner' },
      AT_1010,
    );
    expect(
      (await pickHint(env, TODAY, AT_1010, ['trips', 'subscriptions', 'chains', 'ideas']))?.topic,
    ).toBe('security');
  });

  it('hint_mute_json з facts (масив або {topics}) вимикає теми; чужі теми ігноруються', async () => {
    const { d1, env, kv } = setup();
    d1.db
      .prepare(
        `INSERT INTO ideas (id, title, status, created_at, updated_at) VALUES ('i1', 'Стара', 'нова', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
      )
      .run();
    await runFactsSet(
      env,
      { kind: 'setting', key: 'hint_mute_json', value: { topics: ['ideas', 'security', 'зайве'] } },
      AT_1010,
    );
    expect(await dailyHintTask(env, AT_1010)).toEqual({
      sent: false,
      muted: ['ideas', 'security'],
    });
    kv.delete(DAILY_HINT_MARKER_KEY);
    await runFactsSet(
      env,
      { kind: 'setting', key: 'hint_mute_json', value: ['security'] },
      AT_1010,
    );
    expect(await dailyHintTask(env, AT_1010)).toEqual({ sent: true, topic: 'ideas' });
  });

  it('security без записаної дати: нагадує, пише security_hint_at і мовчить наступні 30 днів', async () => {
    const { d1, env, kv } = setup();
    expect(await dailyHintTask(env, AT_1010)).toEqual({ sent: true, topic: 'security' });
    const fact = d1.db
      .prepare(`SELECT value_json FROM facts WHERE key = 'security_hint_at'`)
      .get() as { value_json: string };
    expect(JSON.parse(fact.value_json)).toBe(TODAY);
    kv.delete(DAILY_HINT_MARKER_KEY);
    // Наступного дня - той самий кандидат уже не повторюється.
    expect(await dailyHintTask(env, AT_1010 + 86_400_000)).toEqual({ sent: false, muted: [] });
    // Через 31 день - знову.
    kv.delete(DAILY_HINT_MARKER_KEY);
    expect(await dailyHintTask(env, AT_1010 + 31 * 86_400_000)).toEqual({
      sent: true,
      topic: 'security',
    });
  });

  it('тиха зона власника (settings.quiet) - підказка чекає, мітка не ставиться', async () => {
    const { d1, env, kv } = setup();
    d1.db
      .prepare(
        `INSERT INTO ideas (id, title, status, created_at, updated_at) VALUES ('i1', 'Стара', 'нова', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z')`,
      )
      .run();
    // Тиха зона 09:00-11:00 - 10:10 усередині.
    kv.set('settings', JSON.stringify({ quiet: { enabled: true, from: '09:00', to: '11:00' } }));
    expect(await dailyHintTask(env, AT_1010)).toEqual({ skipped: 'quiet' });
    expect(kv.get(DAILY_HINT_MARKER_KEY)).toBeUndefined();
  });

  it('muteHintTopic: додає тему до hint_mute_json через policy (T0 з «↩»), невідома тема - помилка', async () => {
    const { d1, env } = setup();
    const out = await muteHintTopic(env, 'ideas', { threadId: 'dm', tainted: false }, AT_1010);
    expect(out.mode).toBe('executed');
    const again = await muteHintTopic(env, 'security', { threadId: 'dm', tainted: false }, AT_1010);
    expect(again.mode).toBe('executed');
    const fact = d1.db
      .prepare(`SELECT value_json FROM facts WHERE key = 'hint_mute_json'`)
      .get() as { value_json: string };
    expect(JSON.parse(fact.value_json)).toEqual({ topics: ['ideas', 'security'] });
    await expect(
      muteHintTopic(env, 'погода', { threadId: 'dm', tainted: false }, AT_1010),
    ).rejects.toThrow(/невідома тема/);
    // tainted - пропозиція T1, не запис.
    const tainted = await muteHintTopic(env, 'trips', { threadId: 'dm', tainted: true }, AT_1010);
    expect(tainted.mode).toBe('proposed');
  });

  it('formatHint екранує HTML у тексті кандидата', () => {
    expect(formatHint({ topic: 'ideas', text: 'Ідея <b>x</b> & y' })).toContain(
      '💡 Ідея &lt;b&gt;x&lt;/b&gt; &amp; y',
    );
  });
});
