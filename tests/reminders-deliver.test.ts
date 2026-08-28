// Доставка нагадувань із D1 (етап 2 PR-7). Перевіряється те, чим ця гілка
// відрізняється від легасі-крону: claim перед відправкою (два тіки не шлють
// двічі), черга outbox замість прямого tgCall, адреса створення і тихі години,
// які НЕ зсувають статус.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { deliverDueReminders } from '../web/core/reminders/deliver.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-08-28T09:00:00.000Z'); // 12:00 у Києві
const MIGRATIONS = ['0001_base.sql', '0002_assistant.sql', '0010_reminders_address.sql'];

type Seed = {
  id: string;
  text: string;
  dueAtMs: number;
  status?: string;
  chatId?: string | null;
  threadId?: string | null;
};

function makeEnv(seed: Seed[] = [], settings: Record<string, unknown> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  for (const r of seed) {
    d1.db
      .prepare(
        `INSERT INTO reminders (id, due_at, text, status, snooze_count, chat_id, thread_id)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        r.id,
        new Date(r.dueAtMs).toISOString(),
        r.text,
        r.status ?? 'pending',
        r.chatId ?? null,
        r.threadId ?? null,
      );
  }
  const kv = new Map<string, string>();
  kv.set('settings', JSON.stringify(settings));
  return {
    d1,
    env: workerEnv({
      DB: d1.stub,
      BRIEFING: memoryKv(kv),
      TELEGRAM_BOT_TOKEN: 'bot-token',
      TELEGRAM_CHAT_ID: '555',
      TOPIC_ASSISTANT: '99',
    }),
  };
}

/** Що реально пішло в Telegram: драйн outbox робить справжні виклики. */
function fetchStub() {
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        method: String(url).split('/').pop() ?? '',
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    }),
  );
  return calls;
}

const statusOf = (d1: ReturnType<typeof d1FromSqlite>, id: string) =>
  (d1.db.prepare('SELECT status FROM reminders WHERE id = ?').get(id) as { status: string }).status;

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('deliverDueReminders', () => {
  it('шле прострочене за адресою створення і позначає sent', async () => {
    const calls = fetchStub();
    const { d1, env } = makeEnv([
      { id: 'r1', text: 'купити хліб', dueAtMs: NOW - 60_000, chatId: '777', threadId: '42' },
    ]);

    expect(await deliverDueReminders(env, NOW)).toEqual({ sent: 1 });
    const sent = calls.find((c) => c.method === 'sendMessage')!;
    expect(sent.body.chat_id).toBe('777');
    expect(sent.body.message_thread_id).toBe('42');
    expect(String(sent.body.text)).toContain('купити хліб');
    expect(statusOf(d1, 'r1')).toBe('sent');
  });

  it('без адреси - фолбек на спільний чат і тему «Асистент»', async () => {
    const calls = fetchStub();
    const { env } = makeEnv([{ id: 'r1', text: 'x', dueAtMs: NOW - 1000 }]);
    await deliverDueReminders(env, NOW);
    const sent = calls.find((c) => c.method === 'sendMessage')!;
    expect(sent.body.chat_id).toBe('555');
    expect(sent.body.message_thread_id).toBe('99');
  });

  it('майбутнє не чіпає, надіслане не шле вдруге', async () => {
    const calls = fetchStub();
    const { d1, env } = makeEnv([
      { id: 'future', text: 'потім', dueAtMs: NOW + 600_000 },
      { id: 'already', text: 'було', dueAtMs: NOW - 600_000, status: 'sent' },
    ]);
    expect(await deliverDueReminders(env, NOW)).toEqual({ sent: 0 });
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect(statusOf(d1, 'future')).toBe('pending');
  });

  it('два тіки поспіль шлють РІВНО один раз (claim перед відправкою)', async () => {
    const calls = fetchStub();
    const { env } = makeEnv([{ id: 'r1', text: 'одне', dueAtMs: NOW - 1000 }]);

    await deliverDueReminders(env, NOW);
    await deliverDueReminders(env, NOW + 1000);

    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(1);
  });

  it('тихі години: не шлемо і статус НЕ рухаємо - піде першим тіком після вікна', async () => {
    const calls = fetchStub();
    // 12:00 у Києві всередині вікна 09:00-14:00.
    // Форма налаштувань - як у normalizeSettings: quiet.{enabled,from,to}.
    const { d1, env } = makeEnv([{ id: 'r1', text: 'тиша', dueAtMs: NOW - 1000 }], {
      quiet: { enabled: true, from: '09:00', to: '14:00' },
    });

    expect(await deliverDueReminders(env, NOW)).toMatchObject({ sent: 0, quiet: true });
    expect(calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    // Головне: нагадування лишилось активним, а не «згоріло» в тиші.
    expect(statusOf(d1, 'r1')).toBe('pending');
  });

  it('без привʼязки DB - тихий no-op, а не виняток у тіку планувальника', async () => {
    const env = workerEnv({ TELEGRAM_CHAT_ID: '555' });
    expect(await deliverDueReminders(env, NOW)).toEqual({ sent: 0 });
  });
});
