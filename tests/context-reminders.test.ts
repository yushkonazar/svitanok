import { afterEach, describe, expect, it, vi } from 'vitest';
import { d1FromSqlite } from './helpers/d1.js';
import { ALL_MIGRATIONS } from './helpers/migrations.js';
import { workerEnv } from './helpers/env.js';
import {
  parseContextIntent,
  currentWorkContext,
  createContextReminder,
  queueContextDelivery,
  renderContextDelivery,
  changeContextReminder,
  listContextReminders,
  editContextReminder,
} from '../web/core/reminders/context-store.mjs';
import {
  routeContextReminder,
  contextReminderCallback,
} from '../web/core/reminders/context-router.mjs';
import { drainOutbox } from '../web/core/tg/outbox.mjs';
import { actionDigest, prerouteMessage, handleBrainCallback } from '../web/core/prerouter.mjs';
import { BACKUP_TABLES, buildBackupDocument, restoreSql } from '../web/core/backup/core.mjs';
import { dumpTables } from '../web/core/backup/task.mjs';
import { FORGET_ALL_TABLES } from '../web/core/export/forget-all.mjs';
import { applyRule, RETENTION } from '../web/core/retention/cleanup.mjs';
import { savePendingVoice } from '../web/core/voice.mjs';

const NOW = Date.parse('2026-10-05T09:00:00Z');
const target = { chatId: 42, threadId: null, fromId: 42, messageId: 1 };
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const { db, stub } = d1FromSqlite(ALL_MIGRATIONS);
  // Faithful D1 batch transaction, including rollback of all statements.
  const original = stub.batch;
  let tail = Promise.resolve();
  stub.batch = (statements) => {
    const pending = tail.then(async () => {
      db.exec('BEGIN');
      try {
        const rows = await original(statements);
        db.exec('COMMIT');
        return rows;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    });
    tail = pending.then(
      () => {},
      () => {},
    );
    return pending;
  };
  const env = workerEnv({
    DB: stub,
    TELEGRAM_BOT_TOKEN: 'synthetic',
    TELEGRAM_OWNER_USER_ID: String(target.fromId),
    ASSISTANT_V2: 'on',
    ASSISTANT_HOME: 'dm',
  });
  const calls: {
    text: string;
    message_id?: number;
    reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
  }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (!url.startsWith('https://api.telegram.org/'))
        throw new Error('LLM/external requests forbidden');
      const body = JSON.parse(String(init.body));
      calls.push(body);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 100 + calls.length } }));
    }),
  );
  return { db, stub, env, calls };
}
async function seed(env: Env, text = 'заїхати в Сільпо', key = 'source-1', at = NOW) {
  return createContextReminder(env, target, { text }, key, at);
}
function scalar(db: ReturnType<typeof setup>['db'], sql: string) {
  return db.prepare(sql).get() as Record<string, unknown>;
}

describe('context reminder intent is deterministic', () => {
  it('keeps no invented due time and accepts explicit tomorrow', () => {
    expect(parseContextIntent('Нагадай після роботи заїхати в Сільпо.', NOW)).toEqual({
      kind: 'create',
      text: 'заїхати в Сільпо',
      date: null,
    });
    expect(parseContextIntent('Нагадай мені завтра після роботи забрати посилку', NOW)?.date).toBe(
      '2026-10-06',
    );
  });
  it.each([
    'Не їду додому',
    'Завтра їду додому',
    'Їду додому на перерву',
    'Він сказав: «їду додому»',
    'Якщо закінчив працювати, що далі?',
    'Повертаюсь додому з подорожі',
  ])('does not fire for %s', (text) => {
    expect(parseContextIntent(text, NOW)).toBeNull();
  });
  it.each([
    'їду додому',
    'Я йду додому!',
    'Закінчив працювати',
    'Роботу завершено',
    'Почав працювати',
  ])('recognizes %s', (text) => expect(parseContextIntent(text, NOW)).not.toBeNull());
  it('does not pretend recurrence is implemented', () =>
    expect(parseContextIntent('Нагадай щодня після роботи читати', NOW)?.kind).toBe('recurring'));
  it('understands tomorrow after the anchor, rejects contradictory dates and suffix recurrence', () => {
    expect(parseContextIntent('Нагадай після роботи завтра купити воду', NOW)).toEqual({
      kind: 'create',
      text: 'купити воду',
      date: '2026-10-06',
    });
    expect(parseContextIntent('Нагадай сьогодні після роботи завтра купити воду', NOW)?.kind).toBe(
      'invalid',
    );
    expect(parseContextIntent('Нагадай після роботи читати щодня', NOW)?.kind).toBe('recurring');
  });
});

describe('durable contexts, atomic claims and delivery receipts', () => {
  it('concurrent registrations cannot overfill the group', async () => {
    const { env, db } = setup();
    const results = await Promise.allSettled(
      Array.from({ length: 21 }, (_, n) => seed(env, String(n), `capacity-${n}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(20);
    expect(scalar(db, 'SELECT COUNT(*) n FROM context_reminders').n).toBe(20);
    expect(scalar(db, 'SELECT COUNT(*) n FROM outbox').n).toBe(20);
  });
  it('does not move a task into a full tomorrow group', async () => {
    const { env } = setup();
    const a = await seed(env);
    const group = await queueContextDelivery(env, a.context_id, NOW, true);
    for (let n = 0; n < 20; n++)
      await createContextReminder(
        env,
        target,
        { text: `tomorrow ${n}`, date: '2026-10-06' },
        `next-${n}`,
        NOW,
      );
    await expect(
      changeContextReminder(env, target, a.id, 'next', NOW + 1, group.id),
    ).rejects.toThrow('context-full');
    expect((await renderContextDelivery(env, group.id)).reply_markup.inline_keyboard).toHaveLength(
      1,
    );
  });
  it('concurrent duplicate registrations and finishers claim once', async () => {
    const { env, db } = setup();
    const rows = await Promise.all([seed(env), seed(env)]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(scalar(db, 'SELECT COUNT(*) n FROM outbox').n).toBe(1);
    const deliveries = await Promise.all([
      queueContextDelivery(env, rows[0].context_id, NOW, true),
      queueContextDelivery(env, rows[0].context_id, NOW, true),
    ]);
    expect(deliveries.filter((r) => r.queued)).toHaveLength(1);
  });
  it('deduplicates a webhook and queues its acknowledgement once', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    const b = await seed(env);
    expect(a.id).toBe(b.id);
    expect(scalar(db, 'SELECT COUNT(*) n FROM context_reminders').n).toBe(1);
    expect(scalar(db, 'SELECT COUNT(*) n FROM outbox').n).toBe(1);
    expect(scalar(db, 'SELECT COUNT(*) n FROM reminders').n).toBe(0);
  });
  it('groups several tasks exactly once, never marks them done', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    await seed(env, 'забрати посилку', 'source-2');
    const group = await queueContextDelivery(env, a.context_id, NOW + 1000, true);
    expect(group.queued).toBe(true);
    expect((await queueContextDelivery(env, a.context_id, NOW + 2000, true)).queued).toBe(false);
    const card = await renderContextDelivery(env, group.id);
    expect(card.text).toContain('заїхати в Сільпо');
    expect(card.text).toContain('забрати посилку');
    expect(card.reply_markup.inline_keyboard).toHaveLength(2);
    expect(
      card.reply_markup.inline_keyboard
        .flat()
        .every((b) => new TextEncoder().encode(b.callback_data).length <= 64),
    ).toBe(true);
    expect(scalar(db, "SELECT COUNT(*) n FROM context_reminders WHERE status='done'").n).toBe(0);
    expect(scalar(db, 'SELECT COUNT(*) n FROM context_deliveries').n).toBe(1);
  });
  it('rolls back the finish, task claim and outbox together on enqueue failure', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    db.exec(
      "CREATE TRIGGER break_queue BEFORE INSERT ON outbox WHEN NEW.id LIKE 'context-delivery-%' BEGIN SELECT RAISE(ABORT,'synthetic queue failure'); END",
    );
    await expect(queueContextDelivery(env, a.context_id, NOW, true)).rejects.toThrow();
    expect(scalar(db, 'SELECT finished_at FROM work_contexts').finished_at).toBeNull();
    expect(scalar(db, 'SELECT status FROM context_reminders').status).toBe('pending');
    expect(scalar(db, 'SELECT COUNT(*) n FROM context_deliveries').n).toBe(0);
  });
  it('repairs creator/finish races at the next outbox drain', async () => {
    const { env, db, calls } = setup();
    const a = await seed(env);
    db.prepare('UPDATE work_contexts SET finished_at=? WHERE id=?').run(
      new Date(NOW).toISOString(),
      a.context_id,
    );
    await drainOutbox(env, { nowMs: NOW, sleep: async () => {} });
    expect(calls.filter((x) => x.text.startsWith('Перед дорогою додому:'))).toHaveLength(1);
    expect(scalar(db, 'SELECT status FROM context_reminders').status).toBe('notified');
  });
  it('keeps an overnight shift, but tomorrow is separate', async () => {
    const { env } = setup();
    const before = Date.parse('2026-10-05T19:30:00Z');
    const a = await seed(env, 'посилка', 'night', before);
    expect((await currentWorkContext(env, target, Date.parse('2026-10-05T23:00:00Z')))?.id).toBe(
      a.context_id,
    );
    const tomorrow = await createContextReminder(
      env,
      target,
      { text: 'завтра', date: '2026-10-06' },
      'tomorrow',
      before,
    );
    expect((await currentWorkContext(env, target, Date.parse('2026-10-05T23:00:00Z')))?.id).toBe(
      a.context_id,
    );
    await queueContextDelivery(env, a.context_id, before + 1, true);
    expect(
      (await listContextReminders(env, target)).find((r) => r.id === tomorrow.id)?.status,
    ).toBe('pending');
  });
  it('asks scope for a late task rather than replays previous tasks', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    await queueContextDelivery(env, a.context_id, NOW, true);
    const late = await seed(env, 'нова справа', 'late', NOW + 1000);
    expect(late.status).toBe('awaiting_scope');
    await changeContextReminder(env, target, late.id, 'now', NOW + 1001);
    expect(scalar(db, 'SELECT COUNT(*) n FROM context_deliveries').n).toBe(2);
    const second = scalar(
      db,
      'SELECT snapshot_json FROM context_deliveries ORDER BY created_at DESC LIMIT 1',
    );
    expect(JSON.parse(String(second.snapshot_json)).map((r: { id: string }) => r.id)).toEqual([
      late.id,
    ]);
  });
  it('not now stays pending for the human, and repeated/stale taps cannot revive a done task', async () => {
    const { env } = setup();
    const a = await seed(env);
    const group = await queueContextDelivery(env, a.context_id, NOW, true);
    await changeContextReminder(env, target, a.id, 'later', NOW + 1, group.id);
    expect((await listContextReminders(env, target))[0].status).toBe('deferred');
    expect((await renderContextDelivery(env, group.id)).text).toContain('не зараз');
    await changeContextReminder(env, target, a.id, 'done', NOW + 2, group.id);
    expect(await changeContextReminder(env, target, a.id, 'next', NOW + 3, group.id)).toBeNull();
    expect(await listContextReminders(env, target)).toHaveLength(0);
  });
  it('moving to tomorrow disables old group buttons and preserves an explicit date', async () => {
    const { env } = setup();
    const a = await seed(env);
    const group = await queueContextDelivery(env, a.context_id, NOW, true);
    const moved = await changeContextReminder(env, target, a.id, 'next', NOW + 1, group.id);
    expect(moved?.work_date).toBe('2026-10-06');
    expect(await changeContextReminder(env, target, a.id, 'done', NOW + 2, group.id)).toBeNull();
    expect((await renderContextDelivery(env, group.id)).reply_markup.inline_keyboard).toHaveLength(
      0,
    );
  });
  it('binds edit explicitly and expires it, escaping HTML', async () => {
    const { env } = setup();
    const a = await seed(env);
    await changeContextReminder(env, target, a.id, 'edit', NOW);
    const updated = await editContextReminder(env, target, '<нова & справа>', NOW + 1);
    expect(updated?.text).toBe('<нова & справа>');
    expect(await editContextReminder(env, target, 'друга', NOW + 2)).toBeNull();
    await changeContextReminder(env, target, a.id, 'edit', NOW);
    expect(await editContextReminder(env, target, 'прострочено', NOW + 11 * 60_000)).toBeNull();
    const group = await queueContextDelivery(env, a.context_id, NOW, true);
    expect((await renderContextDelivery(env, group.id)).text).toContain(
      '&lt;нова &amp; справа&gt;',
    );
  });
  it('enforces active capacity without preventing duplicate webhook retries', async () => {
    const { env } = setup();
    for (let n = 0; n < 20; n++) await seed(env, String(n), String(n));
    await expect(seed(env, 'extra', 'extra')).rejects.toThrow('context-full');
    expect((await seed(env, '0', '0')).id).toBeTruthy();
  });
  it('never retries an unknown network delivery and exposes uncertainty in the receipt', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    const group = await queueContextDelivery(env, a.context_id, NOW, true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (JSON.parse(String(init.body)).text.startsWith('Перед дорогою додому:'))
          throw new Error('timeout');
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
      }),
    );
    await drainOutbox(env, { nowMs: NOW, sleep: async () => {} });
    expect(scalar(db, "SELECT status FROM outbox WHERE id LIKE 'context-delivery-%'").status).toBe(
      'uncertain',
    );
    const count = vi.mocked(fetch).mock.calls.length;
    await drainOutbox(env, { nowMs: NOW + 60_000, sleep: async () => {} });
    expect(vi.mocked(fetch).mock.calls.length).toBe(count);
    expect((await renderContextDelivery(env, group.id)).text).toContain('не підтверджено');
  });
  it('does retry a known Telegram 429 rejection', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    await queueContextDelivery(env, a.context_id, NOW, true);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        JSON.parse(String(init.body)).text.startsWith('Перед дорогою додому:')
          ? new Response(JSON.stringify({ parameters: { retry_after: 2 } }), { status: 429 })
          : new Response(JSON.stringify({ ok: true, result: { message_id: 1 } })),
      ),
    );
    await drainOutbox(env, { nowMs: NOW, sleep: async () => {} });
    expect(scalar(db, "SELECT status FROM outbox WHERE id LIKE 'context-delivery-%'").status).toBe(
      'pending',
    );
  });
  it('does not replay a crashed sending claim with unknown outcome', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    const group = await queueContextDelivery(env, a.context_id, NOW, true);
    db.prepare("UPDATE outbox SET status='sending' WHERE id=?").run(`context-delivery-${group.id}`);
    await drainOutbox(env, { nowMs: NOW + 30 * 60_000, sleep: async () => {} });
    expect(scalar(db, "SELECT status FROM outbox WHERE id LIKE 'context-delivery-%'").status).toBe(
      'uncertain',
    );
  });
});

describe('owner interaction and lifecycle', () => {
  it('undo last does not accidentally roll back an older unrelated write', async () => {
    const { env, db, calls } = setup();
    await seed(env);
    db.prepare(
      `INSERT INTO proposals(id,level,kind,payload_json,thread_id,expires_at,status,created_at) VALUES('old','T0','undo:reminders.create','{}','dm',?,'open',?)`,
    ).run(new Date(NOW + 60_000).toISOString(), new Date(NOW - 60_000).toISOString());
    await prerouteMessage(env, { ...target, kind: 'message', text: 'Відміни останнє' }, NOW + 1);
    expect(scalar(db, "SELECT status FROM proposals WHERE id='old'").status).toBe('open');
    expect(calls.some((c) => c.text.includes('Старіші дії не відкочував'))).toBe(true);
  });
  it('a tomorrow reminder created yesterday is usable after more than 20 hours', async () => {
    const { env } = setup();
    const before = Date.parse('2026-10-05T10:00:00Z');
    const task = await createContextReminder(
      env,
      target,
      { text: 'завтрашня справа', date: '2026-10-06' },
      'planned',
      before,
    );
    const next = Date.parse('2026-10-06T15:00:00Z');
    expect((await currentWorkContext(env, target, next))?.id).toBe(task.context_id);
    await routeContextReminder(env, { ...target, messageId: 2 }, 'почав працювати', next);
    expect((await currentWorkContext(env, target, next + 1))?.id).toBe(task.context_id);
  });
  it('finish button transforms the acknowledgement into a group and stale taps do nothing', async () => {
    const { env, calls } = setup();
    const a = await seed(env);
    await seed(env, 'друга справа', 'second');
    const data = `er:f:${a.context_id}`;
    expect(await contextReminderCallback(env, { ...target, messageId: 500, data }, NOW)).toBe(
      'Готово.',
    );
    expect(
      calls.some((c) => c.message_id === 500 && c.text.startsWith('Перед дорогою додому:')),
    ).toBe(true);
    expect(
      await contextReminderCallback(env, { ...target, messageId: 500, data }, NOW + 1),
    ).toContain('вже завершено');
  });
  it('rejects a partial context restore instead of breaking references', async () => {
    const { env } = setup();
    await seed(env);
    const tables = await dumpTables(env);
    const doc = buildBackupDocument({ createdMs: NOW, envName: 'synthetic', tables, kv: {} });
    delete doc.d1.context_deliveries;
    expect(() => restoreSql(doc)).toThrow('неповний набір контекстних нагадувань');
  });
  it('new work after a completed shift has a new identity, even on the same date', async () => {
    const { env } = setup();
    const a = await seed(env);
    await queueContextDelivery(env, a.context_id, NOW, true);
    await routeContextReminder(env, { ...target, messageId: 2 }, 'почав працювати', NOW + 1000);
    const second = await seed(env, 'інша зміна', 'second-shift', NOW + 2000);
    expect(second.context_id).not.toBe(a.context_id);
    expect(second.status).toBe('pending');
  });
  it('confirmed voice uses the same deterministic route and durable source id', async () => {
    const { env, db, calls } = setup();
    const id = await savePendingVoice(
      env,
      {
        kind: 'transcript',
        text: 'Нагадай після роботи заїхати в Сільпо',
        durationS: 4,
        chatId: target.chatId,
        threadId: null,
      },
      NOW,
    );
    const result = await handleBrainCallback(
      env,
      { ...target, messageId: 700, data: `v:${id}:ok` },
      NOW,
    );
    expect(result).toBeTruthy();
    expect(scalar(db, 'SELECT COUNT(*) n FROM context_reminders').n).toBe(1);
    expect(scalar(db, 'SELECT source_key FROM context_reminders').source_key).toContain('700');
    expect(calls.some((c) => c.text.includes('Після роботи'))).toBe(true);
    expect(
      await handleBrainCallback(env, { ...target, messageId: 700, data: `v:${id}:ok` }, NOW),
    ).toContain('Застаріло');
  });
  it('planned finish time alone never fires; explicit start makes home unambiguous', async () => {
    const { env, db, calls } = setup();
    await seed(env);
    await drainOutbox(env, { nowMs: NOW + 5 * 60 * 60_000, sleep: async () => {} });
    expect(scalar(db, 'SELECT finished_at FROM work_contexts').finished_at).toBeNull();
    await routeContextReminder(env, { ...target, messageId: 2 }, 'почав працювати', NOW + 1);
    await routeContextReminder(env, { ...target, messageId: 3 }, 'їду додому', NOW + 2);
    expect(calls.some((c) => c.text.startsWith('Роботу завершив?'))).toBe(false);
    expect(calls.filter((c) => c.text.startsWith('Перед дорогою додому:'))).toHaveLength(1);
  });
  it('a draft work block cannot silently confirm a home trigger', async () => {
    const { env, db, calls } = setup();
    await seed(env);
    db.prepare("INSERT INTO day_plans(date,status,created_at) VALUES('2026-10-05','draft',?)").run(
      new Date(NOW).toISOString(),
    );
    db.exec(
      "INSERT INTO plan_items(id,date,title,role) VALUES('synthetic-work','2026-10-05','робота','work')",
    );
    await routeContextReminder(env, { ...target, messageId: 2 }, 'їду додому', NOW);
    expect(calls.some((c) => c.text.startsWith('Роботу завершив?'))).toBe(true);
    expect(scalar(db, 'SELECT finished_at FROM work_contexts').finished_at).toBeNull();
  });
  it('routes text before generic reminder questions without an LLM', async () => {
    const { env, calls } = setup();
    expect(
      await prerouteMessage(
        env,
        { ...target, kind: 'message', text: 'Нагадай після роботи заїхати в Сільпо' },
        NOW,
      ),
    ).toBe(true);
    expect(calls[0]!.text).toContain('Після роботи');
    expect(calls[0]!.text).not.toContain('Коли нагадати');
    expect(await actionDigest(env, NOW, target)).toContain('заїхати в Сільпо');
  });
  it('asks ambiguous home with yes/no, survives an interruption, updates the same question', async () => {
    const { env, calls } = setup();
    await seed(env);
    await routeContextReminder(env, { ...target, messageId: 2 }, 'їду додому', NOW);
    const question = calls.find((x) => x.text.startsWith('Роботу завершив?'))!;
    const data = question.reply_markup.inline_keyboard[0]![0]!.callback_data;
    await routeContextReminder(
      env,
      { ...target, messageId: 3 },
      'Нагадай після роботи забрати посилку',
      NOW + 1,
    );
    expect(await contextReminderCallback(env, { ...target, messageId: 500, data }, NOW + 2)).toBe(
      'Готово.',
    );
    expect(calls.find((x) => x.message_id === 500)?.text).toContain('Перед дорогою додому:');
    expect(calls.filter((x) => x.text.startsWith('Перед дорогою додому:'))).toHaveLength(1);
    expect(await contextReminderCallback(env, { ...target, messageId: 500, data }, NOW + 3)).toBe(
      'Це вже вирішено.',
    );
  });
  it('no confirmation preserves tasks; expired and foreign target callbacks do nothing', async () => {
    const { env, calls, db } = setup();
    await seed(env);
    await routeContextReminder(env, { ...target, messageId: 2 }, 'їду додому', NOW);
    const question = calls.find(
      (x) => x.reply_markup?.inline_keyboard[0]?.[0]?.text === 'Так, завершив',
    )!;
    const yes = question.reply_markup.inline_keyboard[0]![0]!.callback_data;
    const no = question.reply_markup.inline_keyboard[0]![1]!.callback_data;
    expect(await contextReminderCallback(env, { ...target, chatId: 99, data: yes }, NOW + 1)).toBe(
      'Це вже вирішено.',
    );
    expect(
      await contextReminderCallback(env, { ...target, data: yes }, NOW + 11 * 60_000),
    ).toContain('минуло');
    expect(
      await contextReminderCallback(env, { ...target, messageId: 10, data: no }, NOW + 1),
    ).toBe('Готово.');
    expect(scalar(db, 'SELECT finished_at FROM work_contexts').finished_at).toBeNull();
    expect(await contextReminderCallback(env, { ...target, fromId: 1, data: yes }, NOW + 2)).toBe(
      'Це кнопка власника.',
    );
  });
  it('acknowledges a button promptly while message delivery is deferred', async () => {
    const { env, calls } = setup();
    const a = await seed(env);
    const deferred: (() => Promise<void>)[] = [];
    const toast = await handleBrainCallback(
      env,
      { ...target, messageId: 90, data: `er:i:${a.id}:cancel` },
      NOW,
      (work) => deferred.push(work),
    );
    expect(toast).toBe('Готово.');
    expect(calls).toHaveLength(0);
    await deferred[0]!();
    expect(calls.some((x) => x.message_id === 90 && x.text.includes('Скасовано'))).toBe(true);
  });
  it('round-trips new tables in backup/export scope and includes them in forget', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    await queueContextDelivery(env, a.context_id, NOW, true);
    const tables = await dumpTables(env);
    for (const name of ['work_contexts', 'context_reminders', 'context_deliveries']) {
      expect(BACKUP_TABLES).toContain(name);
      expect(FORGET_ALL_TABLES).toContain(name);
      expect(tables[name]).toHaveLength(1);
    }
    const doc = buildBackupDocument({ createdMs: NOW, envName: 'synthetic', tables, kv: {} });
    const restored = d1FromSqlite(ALL_MIGRATIONS);
    restored.db.exec(restoreSql(doc));
    expect(scalar(restored.db, 'SELECT text FROM context_reminders').text).toBe('заїхати в Сільпо');
    db.close();
    restored.db.close();
  });
  it('retains unfinished tasks and purges completed history after the retention window', async () => {
    const { env, db } = setup();
    const a = await seed(env);
    await seed(env, 'active', 'active');
    await changeContextReminder(env, target, a.id, 'cancel', NOW);
    const rule = RETENTION.find((r) => r.table === 'context_reminders')!;
    expect(await applyRule(env, rule, NOW + 800 * 24 * 60 * 60_000)).toBe(1);
    expect(scalar(db, 'SELECT COUNT(*) n FROM context_reminders').n).toBe(1);
  });
});
