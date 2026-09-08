// Повторювані нагадування (§3.1): «щопонеділка о 9», «щодня о 23:00»,
// «щомісяця 1-го». Тут перевіряється те, на чому такі речі й ламаються:
// відмінки в назвах днів, перехід через межу тижня, зимовий/літній час і те,
// що ряд не множиться і не обривається мовчки.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseRecurrence,
  parseRrule,
  nextOccurrence,
  recurrenceText,
} from '../web/core/reminders/recurrence.mjs';
import { runRemindersCreate, runRemindersCancel } from '../web/core/tools/reminders.mjs';
import { deliverDueReminders } from '../web/core/reminders/deliver.mjs';
import { listActiveReminders, snoozeReminder } from '../web/core/reminders/store.mjs';
import { activeRemindersForList } from '../web/commands.mjs';
import { formatRemindersListMessage } from '../web/reminders-core.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0010_reminders_address.sql',
  '0012_reminders_recurrence.sql',
];
/** Вівторок, 8 вересня 2026, 09:00 за Києвом (06:00 UTC). */
const NOW = Date.parse('2026-09-08T06:00:00.000Z');
/** Київський час моменту - щоб не читати ISO очима. */
const kyiv = (ms: number) =>
  new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ms));

describe('розбір фрази', () => {
  it('дні тижня ловляться у відмінках і лишають час парсеру', () => {
    for (const phrase of ['щопонеділка о 9:00', 'по понеділках о 9:00', 'кожного понеділка о 9:00'])
      expect(parseRecurrence(phrase), phrase).toMatchObject({ rrule: 'FREQ=WEEKLY;BYDAY=MO' });
    // Час лишається в «решті» - його розбирає штатний парсер, не цей.
    expect(parseRecurrence('щопонеділка о 9:00')?.rest).toBe('о 9:00');
  });

  it('щодня, щотижня, щомісяця числом', () => {
    expect(parseRecurrence('щодня о 23:00')?.rrule).toBe('FREQ=DAILY');
    expect(parseRecurrence('щотижня о 10:00')?.rrule).toBe('FREQ=WEEKLY');
    expect(parseRecurrence('щомісяця 1-го о 10:00')?.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=1');
    expect(parseRecurrence('раз на місяць 15 числа о 10:00')?.rrule).toBe(
      'FREQ=MONTHLY;BYMONTHDAY=15',
    );
  });

  it('інтервал словом і числом', () => {
    expect(parseRecurrence('раз на два тижні о 10:00')?.rrule).toBe('FREQ=WEEKLY;INTERVAL=2');
    expect(parseRecurrence('раз на 3 дні о 10:00')?.rrule).toBe('FREQ=DAILY;INTERVAL=3');
  });

  it('кілька днів тижня в одному правилі', () => {
    const r = parseRecurrence('щопонеділка і щочетверга о 8:00');
    expect(r?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO,TH');
  });

  it('одноразове лишається одноразовим', () => {
    // ⚠️ Голий день тижня - це КОНКРЕТНИЙ день, не повтор: «нагадай у
    // понеділок» не має раптом стати щотижневим рядом.
    for (const phrase of ['у понеділок о 9', 'завтра о 9', 'через 20 хв', '24 липня о 18:30'])
      expect(parseRecurrence(phrase), phrase).toBeNull();
  });

  it('криве правило - null, а не здогад', () => {
    expect(parseRrule('FREQ=YEARLY')).toBeNull();
    expect(parseRrule('FREQ=DAILY;INTERVAL=99')).toBeNull();
    expect(parseRrule('FREQ=MONTHLY;BYMONTHDAY=31')).toBeNull(); // 31 лютого не буває
    expect(parseRrule('')).toBeNull();
    expect(parseRrule(null)).toBeNull();
  });
});

describe('наступна поява', () => {
  it('щодня - та сама година наступного дня', () => {
    const next = nextOccurrence('FREQ=DAILY', NOW)!;
    expect(kyiv(next)).toContain('09:00');
    expect(next - NOW).toBe(24 * 60 * 60_000);
  });

  it('щопонеділка з вівторка - наступний понеділок, не через тиждень від вівторка', () => {
    const mondayNine = Date.parse('2026-09-07T06:00:00.000Z'); // пн 07.09 09:00
    const next = nextOccurrence('FREQ=WEEKLY;BYDAY=MO', mondayNine)!;
    expect(kyiv(next)).toContain('14.09');
    expect(kyiv(next)).toContain('09:00');
  });

  it('кілька днів: із понеділка - найближчий четвер, а не наступний понеділок', () => {
    const monday = Date.parse('2026-09-07T06:00:00.000Z');
    expect(kyiv(nextOccurrence('FREQ=WEEKLY;BYDAY=MO,TH', monday)!)).toContain('10.09');
  });

  it('раз на два тижні - через 14 днів, а не через 7', () => {
    const monday = Date.parse('2026-09-07T06:00:00.000Z');
    expect(kyiv(nextOccurrence('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO', monday)!)).toContain('21.09');
  });

  it('щомісяця тим самим числом', () => {
    const first = Date.parse('2026-09-01T07:00:00.000Z'); // 01.09 10:00 Київ
    const next = nextOccurrence('FREQ=MONTHLY;BYMONTHDAY=1', first)!;
    expect(kyiv(next)).toContain('01.10');
    expect(kyiv(next)).toContain('10:00');
  });

  it('перехід на зимовий час НЕ зсуває годину', () => {
    // ⚠️ Головна пастка повторів: 25.10.2026 Київ переходить на UTC+2. Якщо
    // рахувати «+24 години в мілісекундах», нагадування о 9:00 назавжди стане
    // о 8:00. Тут воно має лишитись о 9:00 за Києвом.
    const beforeSwitch = Date.parse('2026-10-24T06:00:00.000Z'); // сб 24.10 09:00 Київ
    const next = nextOccurrence('FREQ=DAILY', beforeSwitch)!;
    expect(kyiv(next)).toContain('25.10');
    expect(kyiv(next)).toContain('09:00');
    expect(next - beforeSwitch).toBe(25 * 60 * 60_000); // доба з переведенням - 25 годин
  });

  it('нечитабельне правило - null (ряд закінчиться, а не піде за здогадом)', () => {
    expect(nextOccurrence('ЩОСЬ', NOW)).toBeNull();
  });
});

describe('людською', () => {
  it('кожне правило має підпис для власника', () => {
    expect(recurrenceText('FREQ=DAILY')).toBe('щодня');
    expect(recurrenceText('FREQ=DAILY;INTERVAL=3')).toBe('раз на 3 дні');
    expect(recurrenceText('FREQ=WEEKLY')).toBe('щотижня');
    expect(recurrenceText('FREQ=WEEKLY;BYDAY=MO')).toBe('щопонеділка');
    expect(recurrenceText('FREQ=WEEKLY;BYDAY=MO,TH')).toBe('щопонеділка і щочетверга');
    expect(recurrenceText('FREQ=WEEKLY;INTERVAL=2;BYDAY=FR')).toBe('раз на 2 тижні: пʼятниці');
    expect(recurrenceText('FREQ=MONTHLY;BYMONTHDAY=1')).toBe('щомісяця 1-го');
    expect(recurrenceText('ЩОСЬ')).toBe('');
  });
});

describe('наскрізь: створення, спрацювання, скасування', () => {
  function setup() {
    const d1 = d1FromSqlite(MIGRATIONS);
    const kv = new Map<string, string>();
    const sent: Record<string, unknown>[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.body) sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
        });
      }),
    );
    const env = workerEnv({
      DB: d1.stub,
      BRIEFING: memoryKv(kv),
      TELEGRAM_BOT_TOKEN: 'bot',
      TELEGRAM_CHAT_ID: '555',
    });
    return { env, db: d1.db, sent };
  }

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('створення: перша поява + правило, і в результаті - людський підпис', async () => {
    const { env, db } = setup();
    const { result } = await runRemindersCreate(
      env,
      { text: 'полити квіти', when: 'щопонеділка о 9:00' },
      NOW,
      { chatId: 555, threadId: null },
    );
    expect(result.repeat).toBe('щопонеділка');
    // Перша поява - найближчий понеділок 14.09, а не «через тиждень від зараз».
    expect(kyiv(Date.parse(String(result.when)))).toContain('14.09');
    const row = db.prepare('SELECT rrule, recur_count FROM reminders').get();
    expect(row).toEqual({ rrule: 'FREQ=WEEKLY;BYDAY=MO', recur_count: 0 });
  });

  it('повтор без часу - чесна відмова з підказкою, а не вигадана година', async () => {
    const { env } = setup();
    await expect(
      runRemindersCreate(env, { text: 'x', when: 'щопонеділка' }, NOW, {}),
    ).rejects.toThrow(/повтор зрозумів, а час - ні/);
  });

  it('спрацювало - зʼявилась НАСТУПНА поява, лічильник виріс', async () => {
    const { env, db, sent } = setup();
    await runRemindersCreate(env, { text: 'зарядка', when: 'щодня о 09:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    // Наступного дня о 09:00 - час доставки.
    const fired = NOW + 24 * 60 * 60_000;
    expect(await deliverDueReminders(env, fired)).toMatchObject({ sent: 1 });
    expect(sent.some((b) => String(b.text ?? '').includes('зарядка'))).toBe(true);
    const rows = db
      .prepare('SELECT status, recur_count FROM reminders ORDER BY recur_count')
      .all() as { status: string; recur_count: number }[];
    expect(rows).toEqual([
      { status: 'sent', recur_count: 0 },
      { status: 'pending', recur_count: 1 },
    ]);
    // Наступна - рівно через добу, о тій самій годині.
    const active = await listActiveReminders(env);
    expect(kyiv(Date.parse(active[0]!.dueAt))).toContain('09:00');
  });

  it('одне спрацювання - одна наступна поява, не дві', async () => {
    const { env, db } = setup();
    await runRemindersCreate(env, { text: 'зарядка', when: 'щодня о 09:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    const fired = NOW + 24 * 60 * 60_000;
    // Два тіки планувальника поспіль на той самий момент: claim пускає лише
    // перший, тож і наступна поява має бути одна.
    await deliverDueReminders(env, fired);
    await deliverDueReminders(env, fired);
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 2 });
  });

  it('відкладене «+10 хв» не роздвоює ряд', async () => {
    const { env, db } = setup();
    await runRemindersCreate(env, { text: 'зарядка', when: 'щодня о 09:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    const fired = NOW + 24 * 60 * 60_000;
    await deliverDueReminders(env, fired);
    const row = db.prepare(`SELECT id FROM reminders WHERE status = 'sent'`).get() as {
      id: string;
    };
    // «+10 хв» зсуває ТУ САМУ появу, а не породжує другий ряд.
    await snoozeReminder(env, row.id, fired + 10 * 60_000);
    await deliverDueReminders(env, fired + 10 * 60_000);
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 2 });
  });

  it('скасування обриває ряд: наступної появи ще немає, скасовувати нема чого', async () => {
    const { env, db } = setup();
    const { result } = await runRemindersCreate(
      env,
      { text: 'зарядка', when: 'щодня о 09:00' },
      NOW,
      { chatId: 555, threadId: null },
    );
    await runRemindersCancel(env, { id: String(result.id) });
    expect(await listActiveReminders(env)).toHaveLength(0);
    // Наступний тік не воскрешає ряд: скасоване не «спрацьовує».
    await deliverDueReminders(env, NOW + 24 * 60 * 60_000);
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 1 });
  });

  it('правило зіпсували в базі - ряд ЗАКІНЧУЄТЬСЯ, а не повторюється навмання', async () => {
    const { env, db } = setup();
    await runRemindersCreate(env, { text: 'зарядка', when: 'щодня о 09:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    db.prepare(`UPDATE reminders SET rrule = 'ЩОСЬ'`).run();
    await deliverDueReminders(env, NOW + 24 * 60 * 60_000);
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 1 });
  });

  it('у списку видно, що це повтор', async () => {
    const { env } = setup();
    await runRemindersCreate(env, { text: 'полити квіти', when: 'щопонеділка о 9:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    const text = formatRemindersListMessage(await activeRemindersForList(env));
    expect(text).toContain('полити квіти');
    expect(text).toContain('щопонеділка');
  });
});
