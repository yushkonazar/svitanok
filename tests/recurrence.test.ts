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
  alignFirst,
} from '../web/core/reminders/recurrence.mjs';
import {
  runRemindersCreate,
  runRemindersCancel,
  runRemindersUpdate,
} from '../web/core/tools/reminders.mjs';
import { decideLevel } from '../web/core/policy/core.mjs';
import { EXECUTORS } from '../web/core/policy/proposals.mjs';
import { deliverDueReminders } from '../web/core/reminders/deliver.mjs';
import { listActiveReminders, snoozeReminder } from '../web/core/reminders/store.mjs';
import { activeRemindersForList } from '../web/commands.mjs';
import { formatRemindersListMessage } from '../web/reminders-core.mjs';
import { runDataRead } from '../web/core/tools/read.mjs';
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

  it('звичайне речення зі словом «що» повтором НЕ стає', () => {
    // ⚠️ Найдорожча помилка парсера: сполучник «що» + слово про час робив із
    // одноразового наміру вічний ряд, ще й з'їдав слово з тексту нагадування.
    for (const phrase of [
      'нагадай, що дні здачі звіту вже завтра о 9',
      'нагадай, що день народження в Олі завтра о 9',
      'нагадай, що місяць закінчується, завтра о 9',
      'нагадай по середині дня о 14',
    ])
      expect(parseRecurrence(phrase), phrase).toBeNull();
  });

  it('день тижня після інтервалу: «раз на два тижні в пʼятницю»', () => {
    expect(parseRecurrence('раз на два тижні в пʼятницю о 9')).toMatchObject({
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
      rest: 'о 9',
    });
    // Без тижневого правила голий день лишається конкретною датою.
    expect(parseRecurrence('в пʼятницю о 9')).toBeNull();
  });

  it('«кожного тижня» і «кожного місяця» - як «щотижня» і «щомісяця»', () => {
    expect(parseRecurrence('кожного тижня о 9')?.rrule).toBe('FREQ=WEEKLY');
    expect(parseRecurrence('кожного місяця о 9')?.rrule).toBe('FREQ=MONTHLY');
  });

  it('число 29-31 приймається (у короткому місяці підтягнеться)', () => {
    expect(parseRecurrence('щомісяця 31-го о 9')?.rrule).toBe('FREQ=MONTHLY;BYMONTHDAY=31');
  });

  it('розмовні форми, які власник справді вживає', () => {
    // ⚠️ Кожен рядок тут - окрема знахідка ревʼю: усі ці фрази мовчки давали
    // ОДНОРАЗОВЕ нагадування замість ряду.
    const cases: [string, string][] = [
      ['що два тижні о 9', 'FREQ=WEEKLY;INTERVAL=2'], // «що» окремо, але з числом
      ['що три дні о 9', 'FREQ=DAILY;INTERVAL=3'],
      ['щотижнево о 9', 'FREQ=WEEKLY'], // GLUED зафіксував був лише «щотижня»
      ['кожного дня о 9', 'FREQ=DAILY'], // родовий відмінок «дня»
      ['кожен день о 9', 'FREQ=DAILY'], // «кожен», не «кожні»
      ['щоп’ятниці о 9', 'FREQ=WEEKLY;BYDAY=FR'], // апостроф U+2019 з iOS
      ['по п’ятницях о 9', 'FREQ=WEEKLY;BYDAY=FR'],
    ];
    for (const [phrase, rrule] of cases) expect(parseRecurrence(phrase)?.rrule, phrase).toBe(rrule);
  });

  it('перелік днів: усі дні в правилі, сполучник - геть із тексту', () => {
    // Доти виживав лише ПЕРШИЙ день, а решта разом зі сполучником ставала
    // текстом нагадування.
    expect(parseRecurrence('по понеділках і четвергах о 9')).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TH',
      rest: 'о 9',
    });
    expect(parseRecurrence('щовівторка і щочетверга о 8 зарядка')).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=TU,TH',
      rest: 'о 8 зарядка',
    });
  });

  it('слова повтору вирізаються ЦІЛКОМ, текст не калічиться', () => {
    // «дні» стояло в альтернації перед «днів», тож хвіст «в» їхав у текст.
    expect(parseRecurrence('кожні 5 днів о 9 поливати квіти')?.rest).toBe('о 9 поливати квіти');
    // Число місяця не вигризається з середини року.
    expect(parseRecurrence('щомісяця нагадуй про рахунок за 2026-го о 9')).toEqual({
      rrule: 'FREQ=MONTHLY',
      rest: 'нагадуй про рахунок за 2026-го о 9',
    });
  });

  it('чужі слова, схожі на повтор, ним не стають', () => {
    for (const phrase of [
      'нагадай, що дні здачі звіту вже завтра о 9',
      'нагадай по середині дня о 14',
      'купити щоденник завтра о 9',
      'в четвертому кварталі о 9',
      'зустріч у середу о 14',
    ])
      expect(parseRecurrence(phrase), phrase).toBeNull();
    // ⚠️ Найковарніший випадок: тижневе правило ВЖЕ є, тож прийменник «в»
    // приймається - і жадібна основа зробила б із «в четвертому» четвер, ще й
    // вигризла б слово з тексту.
    expect(parseRecurrence('раз на два тижні звіряй план в четвертому розділі о 9')).toEqual({
      rrule: 'FREQ=WEEKLY;INTERVAL=2',
      rest: 'звіряй план в четвертому розділі о 9',
    });
    // Голий день після ТИЖНЕВОГО правила - навпаки, частина правила.
    expect(parseRecurrence('раз на два тижні в пʼятницю о 9')?.rrule).toBe(
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=FR',
    );
  });

  it('щомісяця + день тижня: слова лишаються в тексті, а не тихо зникають', () => {
    // Такої комбінації підмножина RFC не має. Мовчазне «щомісяця 10-го» було б
    // гіршим за видиме непорозуміння.
    expect(parseRecurrence('щомісяця по понеділках о 9')).toEqual({
      rrule: 'FREQ=MONTHLY',
      rest: 'по понеділках о 9',
    });
  });

  it('криве правило - null, а не здогад', () => {
    expect(parseRrule('FREQ=YEARLY')).toBeNull();
    expect(parseRrule('FREQ=DAILY;INTERVAL=99')).toBeNull();
    expect(parseRrule('FREQ=MONTHLY;BYMONTHDAY=32')).toBeNull();
    // ⚠️ Невідомий день - null, а не тихий відсів: інакше вийшов би звичайний
    // тижневий ряд із підписом «щотижня», тобто здогад замість відмови.
    expect(parseRrule('FREQ=WEEKLY;BYDAY=XX')).toBeNull();
    expect(parseRrule('FREQ=DAILY;BYHOUR=25')).toBeNull();
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

  it('щопонеділка з вівторка - найближчий понеділок, а не через тиждень', () => {
    // NOW - вівторок 08.09: наступна поява має бути 14.09, тобто через 6 днів.
    const next = nextOccurrence('FREQ=WEEKLY;BYDAY=MO', NOW)!;
    expect(kyiv(next)).toContain('14.09');
    expect(kyiv(next)).toContain('09:00');
    // З самого понеділка - рівно через тиждень.
    const monday = Date.parse('2026-09-07T06:00:00.000Z');
    expect(kyiv(nextOccurrence('FREQ=WEEKLY;BYDAY=MO', monday)!)).toContain('14.09');
  });

  it('щомісяця 31-го: короткий місяць підтягується, але ряд не зʼїжджає', () => {
    // ⚠️ Пастка: 31 лютого Date.parse НЕ відкидає, а перекочує на 3 березня -
    // і ряд, читаючи число з попередньої появи, назавжди їхав би на 3-тє.
    let at = Date.parse('2026-01-31T07:00:00.000Z'); // 31.01 09:00 Київ
    const rule = 'FREQ=MONTHLY;BYMONTHDAY=31;BYHOUR=9;BYMINUTE=0';
    const chain: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      at = nextOccurrence(rule, at)!;
      chain.push(kyiv(at));
    }
    expect(chain).toEqual([
      expect.stringContaining('28.02'),
      expect.stringContaining('31.03'),
      expect.stringContaining('30.04'),
      expect.stringContaining('31.05'),
    ]);
    expect(chain.every((c) => c.includes('09:00'))).toBe(true);
  });

  it('весняне переведення: ряд повертається на свою годину', () => {
    // ⚠️ 29.03.2026 київської 03:30 не існує - той день з'їде на 04:30. Але
    // година живе в ПРАВИЛІ (BYHOUR), тож 30.03 ряд знову о 03:30.
    const rule = 'FREQ=DAILY;BYHOUR=3;BYMINUTE=30';
    let at = Date.parse('2026-03-28T01:30:00.000Z'); // 28.03 03:30 Київ
    const chain: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      at = nextOccurrence(rule, at)!;
      chain.push(kyiv(at));
    }
    expect(chain).toEqual([
      expect.stringContaining('04:30'),
      expect.stringContaining('03:30'),
      expect.stringContaining('03:30'),
    ]);
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

  it('секунди у базі не перестрибують місяць', () => {
    // ⚠️ Відносна фраза («через 2 години») несе секунди, а kyivHm їх обнуляє:
    // порівняння «>=» без округлення відкидало першу появу на місяць уперед.
    const base = Date.parse('2026-09-15T07:00:37.000Z'); // 15.09 10:00:37 Київ
    expect(kyiv(alignFirst('FREQ=MONTHLY;BYMONTHDAY=15', base))).toContain('15.09');
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
    // Множина через plural(): доти виходило «раз на 5 дні».
    expect(recurrenceText('FREQ=DAILY;INTERVAL=5')).toBe('раз на 5 днів');
    expect(recurrenceText('FREQ=WEEKLY;INTERVAL=5')).toBe('раз на 5 тижнів');
    expect(recurrenceText('FREQ=MONTHLY;INTERVAL=5')).toBe('раз на 5 місяців');
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
    // Годину прибито до правила: далі ряд рахується від НЕЇ, а не від того,
    // що вийшло минулого разу.
    const row = db.prepare('SELECT rrule, recur_count FROM reminders').get();
    expect(row).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9;BYMINUTE=0',
      recur_count: 0,
    });
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

  it('простій воркера: одна поява, а не черга прострочених', async () => {
    const { env, db, sent } = setup();
    await runRemindersCreate(env, { text: 'зарядка', when: 'щодня о 09:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    // Воркер мовчав три доби. Пропущене - пропущене: наступна поява має бути
    // В МАЙБУТНЬОМУ, інакше кожен тік доставляв би ще одну прострочену.
    const late = NOW + 3.5 * 24 * 60 * 60_000;
    expect(await deliverDueReminders(env, late)).toMatchObject({ sent: 1 });
    expect(sent.filter((b) => String(b.text ?? '').includes('зарядка'))).toHaveLength(1);
    const active = await listActiveReminders(env);
    expect(active).toHaveLength(1);
    expect(Date.parse(active[0]!.dueAt)).toBeGreaterThan(late);
    // Наступний тік нічого не доставляє - черги прострочених немає.
    expect(await deliverDueReminders(env, late + 60_000)).toMatchObject({ sent: 0 });
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 2 });
  });

  it('повторна доставка тієї самої ланки не створює ДРУГОГО ряду', async () => {
    const { env, db } = setup();
    await runRemindersCreate(env, { text: 'зарядка', when: 'щодня о 09:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    const fired = NOW + 24 * 60 * 60_000;
    await deliverDueReminders(env, fired);
    const row = db.prepare(`SELECT id, rrule FROM reminders WHERE status = 'sent'`).get() as {
      id: string;
      rrule: string | null;
    };
    expect(row.rrule).toBeNull(); // естафету передано - правило знято
    // ⚠️ Моделюємо збій між INSERT і зняттям правила: строка лишилась носієм
    // правила й повернулась у доставку через «+10 хв». Другого ряду бути не
    // має - id наступної ланки детермінований.
    db.prepare(`UPDATE reminders SET rrule = 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' WHERE id = ?`).run(
      row.id,
    );
    await snoozeReminder(env, row.id, fired + 10 * 60_000);
    await deliverDueReminders(env, fired + 10 * 60_000);
    expect(db.prepare(`SELECT count(*) AS n FROM reminders`).get()).toEqual({ n: 2 });
    // ⚠️ Не лише кількість: естафета має пройти ЧИСТО. Без `INSERT OR IGNORE`
    // батч падає на дублі первинного ключа цілком, правило лишається на
    // доставленій строці - і ряд далі здатен роздвоїтись.
    expect(db.prepare(`SELECT rrule FROM reminders WHERE id = ?`).get(row.id)).toEqual({
      rrule: null,
    });
  });

  it('«↩» після правки знімає і час, і ПОВТОР', async () => {
    const { env, db } = setup();
    const { result } = await runRemindersCreate(
      env,
      { text: 'стоматолог', when: 'завтра о 9' },
      NOW,
      { chatId: 555, threadId: null },
    );
    const id = String(result.id);
    // Модель робить із одноразового вічний ряд...
    const snap = await EXECUTORS['reminders.update']!.execute!(
      env,
      { id, when: 'щодня о 3:00' },
      NOW,
      {},
    );
    expect(db.prepare(`SELECT rrule FROM reminders WHERE id = ?`).get(id)).toEqual({
      rrule: 'FREQ=DAILY;BYHOUR=3;BYMINUTE=0',
    });
    // ...а «↩» має повернути ВСЕ, інакше кнопка бреше і ряд лишається назавжди.
    await EXECUTORS['reminders.update']!.undo!(env, snap.prev, NOW);
    expect(db.prepare(`SELECT rrule FROM reminders WHERE id = ?`).get(id)).toEqual({
      rrule: null,
    });
  });

  it('«↩» повертає ПОПЕРЕДНІЙ графік, а не просто знімає повтор', async () => {
    const { env, db } = setup();
    const { result } = await runRemindersCreate(
      env,
      { text: 'зарядка', when: 'щодня о 09:00' },
      NOW,
      { chatId: 555, threadId: null },
    );
    const id = String(result.id);
    // ⚠️ Саме заради цього випадку знімок несе `rrule`: без нього «↩» лишало б
    // нагадування взагалі БЕЗ повтору, хоч до правки воно повторювалось щодня.
    const snap = await EXECUTORS['reminders.update']!.execute!(
      env,
      { id, when: 'щовівторка о 8:00' },
      NOW,
      {},
    );
    await EXECUTORS['reminders.update']!.undo!(env, snap.prev, NOW);
    expect(db.prepare(`SELECT rrule FROM reminders WHERE id = ?`).get(id)).toEqual({
      rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
    });
  });

  it('правка лише часу тримає ГРАФІК, а не найближчу добу', async () => {
    const { env } = setup();
    // ⚠️ День правила навмисно НЕ збігається з днем NOW (вівторок 08.09):
    // інакше «найближча доба з такою годиною» і «день за графіком» - те саме,
    // і тест не розрізняє вирівняного від невирівняного.
    const { result } = await runRemindersCreate(
      env,
      { text: 'зарядка', when: 'щочетверга о 8:00' },
      NOW,
      { chatId: 555, threadId: null },
    );
    const moved = await runRemindersUpdate(env, { id: String(result.id), when: 'о 10:30' }, NOW);
    expect(moved.result.repeat).toBe('щочетверга');
    // Без вирівнювання парсер часу дав би СЬОГОДНІ 10:30 (вівторок) - доставка
    // повз власний графік власника.
    expect(kyiv(Date.parse(String(moved.result.when)))).toContain('10.09');
    expect(kyiv(Date.parse(String(moved.result.when)))).toContain('10:30');
  });

  it('повтор у tainted-сесії просить ✅, одноразове - ні', () => {
    // ⚠️ «↩» живе 10 хв, а перша поява буває й через тиждень: інʼєкція з листа
    // не має ставити власнику вічний ряд без підтвердження.
    expect(decideLevel('reminders.create', true, { when: 'щодня о 3:00', text: 'x' })).toEqual({
      level: 'T1',
    });
    expect(decideLevel('reminders.create', true, { when: 'завтра о 9', text: 'x' })).toEqual({
      level: 'T0',
    });
    expect(decideLevel('reminders.create', false, { when: 'щодня о 3:00', text: 'x' })).toEqual({
      level: 'T0',
    });
    // ⚠️ update ТЕЖ: інакше барʼєр обходився двома кроками - створити
    // одноразове (T0) і одразу «оновити» його на щоденне (теж T0).
    expect(decideLevel('reminders.update', true, { id: 'r1', when: 'щодня о 3:00' })).toEqual({
      level: 'T1',
    });
    expect(decideLevel('reminders.update', true, { id: 'r1', when: 'о 10:00' })).toEqual({
      level: 'T0',
    });
  });

  it('правку теж розуміє: новий повтор і новий час у наявному ряді', async () => {
    const { env, db } = setup();
    const { result } = await runRemindersCreate(
      env,
      { text: 'зарядка', when: 'щодня о 09:00' },
      NOW,
      { chatId: 555, threadId: null },
    );
    const id = String(result.id);
    // Новий графік з фрази.
    const upd = await runRemindersUpdate(env, { id, when: 'щовівторка о 8:00' }, NOW);
    expect(upd.result.repeat).toBe('щовівторка');
    expect(db.prepare(`SELECT rrule FROM reminders WHERE id = ?`).get(id)).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=8;BYMINUTE=0',
    });
    // Просто новий час - повтор лишається, але година в правилі оновлюється.
    const moved = await runRemindersUpdate(env, { id, when: 'о 10:30' }, NOW);
    expect(moved.result.repeat).toBe('щовівторка');
    expect(db.prepare(`SELECT rrule FROM reminders WHERE id = ?`).get(id)).toEqual({
      rrule: 'FREQ=WEEKLY;BYDAY=TU;BYHOUR=10;BYMINUTE=30',
    });
  });

  it('мозок теж бачить повтор, а не лише /reminders', async () => {
    const { env } = setup();
    await runRemindersCreate(env, { text: 'полити квіти', when: 'щопонеділка о 9:00' }, NOW, {
      chatId: 555,
      threadId: null,
    });
    // ⚠️ Без цього модель бачила ряд як разове нагадування і не могла виконати
    // власну ж інструкцію «щоб припинити повтор - скасуй нагадування».
    const { result } = await runDataRead(env, { scope: 'reminders' }, NOW);
    expect(String(result)).toContain('щопонеділка');
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
