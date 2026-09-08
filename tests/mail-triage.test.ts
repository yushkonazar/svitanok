// Тріаж пошти в ядрі і знімок календаря (етап 7 PR-2, ADR-027, 07 §7).
//
// ЩО ТУТ ДОВОДИТЬСЯ. Після цього PR у GitHub Secrets більше немає
// GOOGLE_REFRESH_TOKEN, тобто блоки «Пошта» і «Сьогодні в календарі» живуть
// рівно доти, доки ці дві задачі кладуть свої ключі в KV. Тому перевіряються
// не лише щасливі шляхи, а й те, що збій ВИДНО (алерт), що вчорашній знімок
// НЕ видається за сьогоднішній і що запит холодного старту не розійшовся з
// config.yml, за яким брифінг судить листи.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  mailTriageTask,
  mergeCandidates,
  normalizeTriageState,
  MAIL_TRIAGE_KEY,
  MAIL_TRIAGE_QUERY,
  MAIL_TRIAGE_PERIOD_MS,
  MAIL_CANDIDATE_TTL_MS,
  MAIL_CANDIDATES_CAP,
  MAIL_FAIL_ALERT_AT,
} from '../web/core/brief/mail-triage.mjs';
import {
  refreshBriefCalendar,
  parseSnapshot,
  CALENDAR_SNAPSHOT_KEY,
  CALENDAR_SNAPSHOT_MAX_ATTEMPTS,
} from '../web/core/brief/calendar-snapshot.mjs';
import { CORE_SCOPES } from '../web/core/google-scopes.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-08T09:00:00.000Z'); // 12:00 Києва
// ⚠️ expMs - від РЕАЛЬНОГО годинника, не від NOW: свіжість кешу токена
// перевіряє googleAccessToken за Date.now(), тож привʼязка до фіксованого
// NOW робила б тест бомбою сповільненої дії - зеленим уранці й червоним
// пополудні.
const TOKEN_EXP = () => Date.now() + 3_600_000;
const ALL = CORE_SCOPES.join(' ');

function makeEnv(state: Record<string, unknown> = {}, scopes = ALL) {
  const store = new Map<string, string>();
  store.set('googleToken', JSON.stringify({ token: 'tok', expMs: TOKEN_EXP(), scope: scopes }));
  store.set('state', JSON.stringify(state));
  // DB потрібна алертам: sendSystemAlert кладе рядок в outbox (D1), і без
  // привʼязки збій тріажу лишився б лише в консолі.
  const d1 = d1FromSqlite(['0001_base.sql', '0002_assistant.sql', '0003_telemetry.sql']);
  const env = workerEnv({
    DB: d1.stub,
    ASSISTANT_V2: 'on',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    TELEGRAM_BOT_TOKEN: 'bot',
    TELEGRAM_CHAT_ID: '555',
    TOPIC_SYSTEM: '7',
    BRIEFING: memoryKv(store),
  });
  const readState = () => JSON.parse(store.get('state') ?? '{}');
  return { env, store, readState };
}

/** Відповіді Gmail для одного тіка: профіль, історія/пошук, метадані. */
function gmailFetch(opts: {
  historyIds?: string[];
  historyStatus?: number;
  searchIds?: string[];
  meta?: Record<string, { subject: string; from: string; labels?: string[]; atMs?: number }>;
  profileHistoryId?: string;
}) {
  const telegram: { url: string; body: unknown }[] = [];
  const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('api.telegram.org')) {
      telegram.push({ url: u, body: init?.body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }
    if (u.includes('/users/me/profile')) {
      return new Response(JSON.stringify({ historyId: opts.profileHistoryId ?? '200' }), {
        status: 200,
      });
    }
    if (u.includes('/users/me/history')) {
      if (opts.historyStatus && opts.historyStatus !== 200) {
        return new Response('nope', { status: opts.historyStatus });
      }
      return new Response(
        JSON.stringify({
          history: (opts.historyIds ?? []).map((id) => ({ messagesAdded: [{ message: { id } }] })),
          historyId: opts.profileHistoryId ?? '200',
        }),
        { status: 200 },
      );
    }
    if (u.includes('/users/me/messages?') || /\/messages\?/.test(u)) {
      return new Response(
        JSON.stringify({ messages: (opts.searchIds ?? []).map((id) => ({ id })) }),
        { status: 200 },
      );
    }
    const id = u.match(/\/messages\/([^?]+)/)?.[1] ?? '';
    const m = opts.meta?.[id];
    if (!m) return new Response('not found', { status: 404 });
    return new Response(
      JSON.stringify({
        snippet: 'сніпет',
        labelIds: m.labels ?? ['INBOX'],
        internalDate: String(m.atMs ?? NOW - 3_600_000),
        payload: {
          headers: [
            { name: 'Subject', value: m.subject },
            { name: 'From', value: m.from },
          ],
        },
      }),
      { status: 200 },
    );
  });
  return { impl, telegram };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('запит холодного старту не розходиться з брифінгом', () => {
  it('MAIL_TRIAGE_QUERY дослівно дорівнює modules.mail.query у config.yml', () => {
    const yaml = readFileSync('config.yml', 'utf8');
    const line = yaml.split('\n').find((l) => l.trim().startsWith('query:'));
    const fromConfig = String(line)
      .trim()
      .replace(/^query:\s*/, '')
      .replace(/^'|'$/g, '');
    // Розійдуться - ядро збиратиме не ті листи, які брифінг збирався судити,
    // і власник цього не побачить: блок просто стане іншим.
    expect(MAIL_TRIAGE_QUERY).toBe(fromConfig);
  });
});

describe('mergeCandidates', () => {
  const base = { id: 'm1', from: 'a@b', subject: 'т', snippet: 's', atMs: NOW - 1000 };

  it('дедуп за id; свіжа копія перемагає стару', () => {
    const merged = mergeCandidates([base], [{ ...base, subject: 'нова тема' }], {
      nowMs: NOW,
      shown: {},
    });
    expect(merged).toHaveLength(1);
    expect(merged[0]?.subject).toBe('нова тема');
  });

  it('прострочені (понад вікно) випадають', () => {
    const old = { ...base, id: 'old', atMs: NOW - MAIL_CANDIDATE_TTL_MS - 1 };
    expect(mergeCandidates([old], [base], { nowMs: NOW, shown: {} }).map((c) => c.id)).toEqual([
      'm1',
    ]);
  });

  it('уже розглянуті брифінгом (shownMail) не накопичуються', () => {
    expect(mergeCandidates([base], [], { nowMs: NOW, shown: { m1: '2026-09-08' } })).toEqual([]);
  });

  it('стеля списку тримається, найновіші зверху', () => {
    const many = Array.from({ length: MAIL_CANDIDATES_CAP + 10 }, (_, i) => ({
      ...base,
      id: `m${i}`,
      atMs: NOW - i * 1000,
    }));
    const merged = mergeCandidates([], many, { nowMs: NOW, shown: {} });
    expect(merged).toHaveLength(MAIL_CANDIDATES_CAP);
    expect(merged[0]?.id).toBe('m0');
  });
});

describe('mail-triage', () => {
  it('холодний старт: пошук + метадані → кандидати і historyId у KV', async () => {
    const { impl } = gmailFetch({
      searchIds: ['m1', 'm2'],
      meta: {
        m1: { subject: 'Заявка', from: 'hr@acme.com' },
        m2: { subject: 'Знижки', from: 'promo@shop.com', labels: ['CATEGORY_PROMOTIONS'] },
      },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env, readState } = makeEnv();
    const res = await mailTriageTask(env, NOW);
    expect(res).toMatchObject({ added: 1, cold: true });
    const saved = normalizeTriageState(readState()[MAIL_TRIAGE_KEY]);
    // Промо-мітка відсіяна тут, у ядрі: брифінг більше не бачить сирої скриньки.
    expect(saved.candidates.map((c) => c.id)).toEqual(['m1']);
    expect(saved.historyId).toBe('200');
  });

  it('інкремент: від збереженого historyId і без повторного пошуку', async () => {
    const { impl } = gmailFetch({
      historyIds: ['m9'],
      meta: { m9: { subject: 'Нове', from: 'x@y' } },
      profileHistoryId: '321',
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env, readState } = makeEnv({
      [MAIL_TRIAGE_KEY]: { historyId: '100', lastRunMs: 0, fails: 0, candidates: [] },
    });
    const res = await mailTriageTask(env, NOW);
    expect(res).toMatchObject({ added: 1, cold: false });
    expect(normalizeTriageState(readState()[MAIL_TRIAGE_KEY]).historyId).toBe('321');
    const urls = impl.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes('/history'))).toBe(true);
    expect(urls.some((u) => u.includes('/messages?'))).toBe(false);
  });

  it('404 на history (точка відліку застаріла) - НЕ збій, а пересинхронізація', async () => {
    const { impl, telegram } = gmailFetch({
      historyStatus: 404,
      searchIds: ['m5'],
      meta: { m5: { subject: 'Лист', from: 'a@b' } },
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env, readState } = makeEnv({
      [MAIL_TRIAGE_KEY]: { historyId: '1', lastRunMs: 0, fails: 2, candidates: [] },
    });
    expect(await mailTriageTask(env, NOW)).toMatchObject({ added: 1, cold: true });
    expect(normalizeTriageState(readState()[MAIL_TRIAGE_KEY]).fails).toBe(0);
    expect(telegram).toHaveLength(0);
  });

  it('період 15 хв: друга поява в межах вікна нічого не робить', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { env } = makeEnv({
      [MAIL_TRIAGE_KEY]: { historyId: '1', lastRunMs: NOW - 60_000, fails: 0, candidates: [] },
    });
    expect(await mailTriageTask(env, NOW)).toEqual({ skipped: 'period' });
    expect(fetchSpy).not.toHaveBeenCalled();
    // А після вікна - робить.
    expect(await mailTriageTask(env, NOW + MAIL_TRIAGE_PERIOD_MS)).not.toEqual({
      skipped: 'period',
    });
  });

  it('три збої поспіль - алерт у системну тему, четвертий - тиша', async () => {
    const { impl, telegram } = gmailFetch({ historyStatus: 500 });
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env, readState } = makeEnv({
      [MAIL_TRIAGE_KEY]: { historyId: '1', lastRunMs: 0, fails: 0, candidates: [] },
    });
    let at = NOW;
    for (let i = 0; i < MAIL_FAIL_ALERT_AT + 1; i++) {
      await mailTriageTask(env, at);
      at += MAIL_TRIAGE_PERIOD_MS;
    }
    expect(telegram).toHaveLength(1);
    expect(String(telegram[0]?.body)).toContain('Тріаж пошти не працює');
    expect(normalizeTriageState(readState()[MAIL_TRIAGE_KEY]).alerted).toBe(true);
  });

  it('скоуп gmail.readonly знято - жодного запиту до Gmail', async () => {
    const { impl } = gmailFetch({ searchIds: ['m1'] });
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env } = makeEnv({}, CORE_SCOPES.filter((s) => !s.endsWith('gmail.readonly')).join(' '));
    expect(await mailTriageTask(env, NOW)).toEqual({ skipped: 'no-scope' });
    expect(impl.mock.calls.filter((c) => String(c[0]).includes('gmail'))).toHaveLength(0);
  });

  it('ядро НЕ пише shownMail - цей ключ належить брифінгу', async () => {
    const { impl } = gmailFetch({ searchIds: ['m1'], meta: { m1: { subject: 'т', from: 'a@b' } } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env, readState } = makeEnv({ shownMail: { old: '2026-09-01' } });
    await mailTriageTask(env, NOW);
    // Два писарі на один ключ у KV без CAS = втрачені записи; межу тримає тест.
    expect(readState().shownMail).toEqual({ old: '2026-09-01' });
  });
});

describe('знімок календаря', () => {
  function calendarFetch(items: unknown[] | null) {
    const telegram: string[] = [];
    const impl = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('api.telegram.org')) {
        telegram.push(String(init?.body));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }
      if (items === null) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ items }), { status: 200 });
    });
    return { impl, telegram };
  }

  it('пише сьогоднішній знімок із подіями', async () => {
    const { impl } = calendarFetch([
      { summary: 'Стендап', start: { dateTime: '2026-09-08T07:00:00Z' } },
    ]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env, readState } = makeEnv();
    expect(await refreshBriefCalendar(env, NOW)).toEqual({ written: 1 });
    const snap = parseSnapshot(readState()[CALENDAR_SNAPSHOT_KEY]);
    expect(snap).toMatchObject({ date: '2026-09-08', ready: true });
    expect(snap?.events[0]).toMatchObject({ title: 'Стендап', time: '10:00' });
  });

  it('порожній день - теж відповідь: знімок ready, Google удруге не питаємо', async () => {
    const { impl } = calendarFetch([]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env } = makeEnv();
    expect(await refreshBriefCalendar(env, NOW)).toEqual({ written: 0 });
    const before = impl.mock.calls.length;
    expect(await refreshBriefCalendar(env, NOW + 600_000)).toEqual({ skipped: 'done' });
    expect(impl.mock.calls.length).toBe(before);
  });

  it('до 07:00 Києва знімок не робиться', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { env } = makeEnv();
    // 03:00 UTC = 06:00 Києва.
    expect(await refreshBriefCalendar(env, Date.parse('2026-09-08T03:00:00Z'))).toEqual({
      skipped: 'hour',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('після стелі спроб - алерт і тиша до завтра', async () => {
    const { impl, telegram } = calendarFetch(null);
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env } = makeEnv();
    for (let i = 0; i < CALENDAR_SNAPSHOT_MAX_ATTEMPTS; i++) {
      await refreshBriefCalendar(env, NOW + i * 300_000);
    }
    expect(telegram).toHaveLength(1);
    expect(telegram[0]).toContain('Календар на 2026-09-08 не прочитався');
    expect(await refreshBriefCalendar(env, NOW + 3_600_000)).toEqual({ skipped: 'attempts' });
  });

  it('вчорашній знімок не рахується зробленим - ядро перечитує календар', async () => {
    const { impl } = calendarFetch([]);
    vi.spyOn(globalThis, 'fetch').mockImplementation(impl as unknown as typeof fetch);
    const { env, readState } = makeEnv({
      [CALENDAR_SNAPSHOT_KEY]: { date: '2026-09-07', ready: true, events: [], attempts: 1 },
    });
    expect(await refreshBriefCalendar(env, NOW)).toEqual({ written: 0 });
    expect(parseSnapshot(readState()[CALENDAR_SNAPSHOT_KEY])?.date).toBe('2026-09-08');
  });
});
