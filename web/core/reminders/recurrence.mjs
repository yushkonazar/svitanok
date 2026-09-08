// Повторювані нагадування (§3.1 релізного плану): «щопонеділка о 9»,
// «щодня о 23:00», «щомісяця 1-го», «раз на два тижні в пʼятницю».
//
// ⚠️ ЧОМУ ПІДМНОЖИНА RFC 5545, А НЕ ПОВНИЙ RRULE. Побутовий повтор - це
// «щодня», «по днях тижня» і «раз на місяць числом». Усе, що складніше
// («останній робочий день кварталу»), власник однаково скаже словами, і
// чесна відмова там краща за мовчазне «зрозумів інакше». Формат лишається
// стандартним, щоб рядок у базі читався без словника:
//   FREQ=DAILY|WEEKLY|MONTHLY[;INTERVAL=n][;BYDAY=MO,TU][;BYMONTHDAY=n]
//
// ⚠️ ЧАС РАХУЄ ЯДРО, не модель (той самий інваріант, що для одноразових):
// модель дає природний текст, парсер тут дістає і правило, і першу появу.
//
// ⚠️ НАСТУПНА ПОЯВА РАХУЄТЬСЯ ВІД ПОПЕРЕДНЬОЇ, а не «now + період»: інакше
// нагадування щодня о 9:00 повзло б уперед на секунди затримки планувальника
// і за місяць з'їхало б на іншу годину.

import { addDaysToDateKey } from '../../reminders-core.mjs';

/** Дні тижня в порядку RFC 5545 (SU=0, як у Date#getUTCDay). */
const RFC_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Українські назви днів → RFC. Ключ - основа, щоб ловити відмінки.
 *  @type {[string, string][]} */
const DAY_WORDS = [
  ['понеділ', 'MO'],
  ['вівтор', 'TU'],
  ['середу', 'WE'],
  ['середа', 'WE'],
  ['серед', 'WE'],
  ['четвер', 'TH'],
  ['пʼятниц', 'FR'],
  ["п'ятниц", 'FR'],
  ['пятниц', 'FR'],
  ['субот', 'SA'],
  ['неділ', 'SU'],
];

/** Людські назви для показу власнику. @type {Record<string, string>} */
const DAY_HUMAN = {
  MO: 'понеділка',
  TU: 'вівторка',
  WE: 'середи',
  TH: 'четверга',
  FR: 'пʼятниці',
  SA: 'суботи',
  SU: 'неділі',
};

/** Числівники, які трапляються в «раз на два тижні». @type {Record<string, number>} */
const NUM_WORDS = { два: 2, дві: 2, три: 3, чотири: 4 };

/** Українська літера. ⚠️ Не `\w`: у JS це [A-Za-z0-9_], і «щопонеділка» такий
 *  шаблон обривав на «щопонеділ», лишаючи «ка» в тексті часу. */
const L = "[а-яіїєґА-ЯІЇЄҐ'ʼ]";

/** Стеля інтервалу: більше - це вже не побутовий повтор, а планування року. */
const MAX_INTERVAL = 12;

const EVERY_RE = new RegExp(
  `(?:раз\\s+на|кожн[іи]|що)\\s*(\\d+|два|дві|три|чотири)?\\s*(день|дні|днів|доб[ауи]|тижн${L}*|місяц${L}*)`,
  'i',
);

/**
 * Дістати правило повтору з фрази. Повертає `rrule` і текст БЕЗ слів про
 * повторюваність - його далі розбирає звичайний парсер часу, тож «щопонеділка
 * о 9» стає «о 9» і дає базову годину штатним шляхом.
 *
 * null - повтору у фразі немає (або він незрозумілий, і тоді краще одноразове
 * нагадування, ніж вигаданий графік).
 * @param {unknown} raw
 * @returns {{ rrule: string, rest: string } | null}
 */
export function parseRecurrence(raw) {
  const text = String(raw ?? '');
  if (!text.trim()) return null;

  /** @type {string[]} */
  const eaten = [];

  // «раз на два тижні», «раз на 3 дні», «кожні два тижні», «щотижня»
  let interval = 1;
  /** @type {'DAILY' | 'WEEKLY' | 'MONTHLY' | null} */
  let freq = null;
  const every = text.match(EVERY_RE);
  if (every) {
    eaten.push(every[0]);
    const n = every[1];
    if (n) interval = /^\d+$/.test(n) ? Number(n) : (NUM_WORDS[n.toLowerCase()] ?? 1);
    const unit = (every[2] ?? '').toLowerCase();
    freq = unit.startsWith('тижн') ? 'WEEKLY' : unit.startsWith('місяц') ? 'MONTHLY' : 'DAILY';
  }

  // «щодня», «щовечора», «щоранку» - завжди DAILY
  const daily = text.match(/(?<![а-яіїєґ])(щодня|щоденно|щоранку|щовечора|щоночі)(?![а-яіїєґ])/i);
  if (daily) {
    eaten.push(daily[0]);
    freq = 'DAILY';
  }

  // «щомісяця» окремим словом
  const monthly = text.match(/(?<![а-яіїєґ])щомісяця(?![а-яіїєґ])/i);
  if (monthly) {
    eaten.push(monthly[0]);
    freq = 'MONTHLY';
  }

  // «щопонеділка», «по понеділках», «кожного вівторка».
  // ⚠️ Голе «понеділок» без «що/по/кожного» - це КОНКРЕТНИЙ день, не повтор:
  // «нагадай у понеділок» не має раптом стати щотижневим рядом.
  /** @type {string[]} */
  const days = [];
  for (const pair of DAY_WORDS) {
    const re = new RegExp(`(що|по\\s+|кожн${L}+\\s+)?${pair[0]}${L}*`, 'i');
    const m = text.match(re);
    if (!m || !m[1]) continue;
    if (!days.includes(pair[1])) days.push(pair[1]);
    eaten.push(m[0]);
  }
  if (days.length > 0 && freq !== 'MONTHLY') freq = 'WEEKLY';

  // Число місяця - лише для місячного правила («1-го», «15 числа»).
  let monthDay = null;
  if (freq === 'MONTHLY') {
    const md = text.match(/(\d{1,2})\s*(?:-?го|числа)/i);
    if (md) {
      const n = Number(md[1]);
      if (n >= 1 && n <= 28) {
        monthDay = n;
        eaten.push(md[0]);
      }
    }
  }

  if (!freq) return null;
  if (interval < 1 || interval > MAX_INTERVAL) return null;

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === 'WEEKLY' && days.length > 0) parts.push(`BYDAY=${days.join(',')}`);
  if (freq === 'MONTHLY' && monthDay != null) parts.push(`BYMONTHDAY=${monthDay}`);

  let rest = text;
  for (const m of eaten) rest = rest.replace(m, ' ');
  rest = rest.replace(/\s{2,}/g, ' ').trim();
  return { rrule: parts.join(';'), rest };
}

/**
 * Перша поява, вирівняна за правилом.
 *
 * ⚠️ Навіщо. Годину з фрази дає штатний парсер, і для «щопонеділка о 9»,
 * сказаного у вівторок, він поверне ЗАВТРА о 9 - найближчий момент із такою
 * годиною. Але власник просив понеділок. Тут база котиться вперед до першого
 * дня, що задовольняє правило; для DAILY нічого не змінюється.
 * @param {unknown} rrule
 * @param {number} baseMs
 * @returns {number} baseMs, якщо правило вже виконано або нечитабельне
 */
export function alignFirst(rrule, baseMs) {
  const rule = parseRrule(rrule);
  if (!rule) return baseMs;
  const { dateKey, hh, mm } = kyivParts(baseMs);
  if (rule.freq === 'WEEKLY' && rule.days.length > 0) {
    const wanted = new Set(rule.days);
    for (let step = 0; step <= 7; step += 1) {
      const key = addDaysToDateKey(dateKey, step);
      if (wanted.has(RFC_DAYS[weekdayOf(key)] ?? '')) return kyivHm(key, hh, mm);
    }
    return baseMs;
  }
  if (rule.freq === 'MONTHLY' && rule.monthDay != null) {
    if (Number(dateKey.slice(8, 10)) === rule.monthDay) return baseMs;
    const [y, m] = dateKey.split('-').map(Number);
    const at = (/** @type {number} */ yy, /** @type {number} */ mo) =>
      kyivHm(
        `${yy}-${String(mo).padStart(2, '0')}-${String(rule.monthDay).padStart(2, '0')}`,
        hh,
        mm,
      );
    const thisMonth = at(y ?? 0, m ?? 1);
    if (thisMonth > baseMs) return thisMonth;
    const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + 1;
    return at(Math.floor(total / 12), (total % 12) + 1);
  }
  return baseMs;
}

/**
 * Розібрати рядок правила назад у поля. Невідоме/криве - null: краще
 * зупинити повтор, ніж повторювати за здогадом.
 * @param {unknown} raw
 * @returns {{ freq: 'DAILY'|'WEEKLY'|'MONTHLY', interval: number,
 *   days: string[], monthDay: number | null } | null}
 */
export function parseRrule(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  /** @type {Record<string, string>} */
  const kv = {};
  for (const part of text.split(';')) {
    const [k, v] = part.split('=');
    if (k && v) kv[k.toUpperCase()] = v.toUpperCase();
  }
  const freq = kv.FREQ;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null;
  const interval = kv.INTERVAL ? Number(kv.INTERVAL) : 1;
  if (!Number.isInteger(interval) || interval < 1 || interval > MAX_INTERVAL) return null;
  const days = kv.BYDAY ? kv.BYDAY.split(',').filter((d) => RFC_DAYS.includes(d)) : [];
  const monthDay = kv.BYMONTHDAY ? Number(kv.BYMONTHDAY) : null;
  if (monthDay != null && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 28)) {
    return null;
  }
  return { freq, interval, days, monthDay };
}

/**
 * Коли повтор спрацює НАСТУПНОГО разу після `prevMs`.
 *
 * Година й хвилина беруться з `prevMs` за Києвом і переносяться на нову дату
 * тим самим шляхом, що й у парсері часу: інакше перехід на зимовий час зсував
 * би нагадування на годину назавжди.
 * @param {unknown} rrule
 * @param {number} prevMs
 * @returns {number | null} null = правило нечитабельне
 */
export function nextOccurrence(rrule, prevMs) {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  const { dateKey, hh, mm } = kyivParts(prevMs);

  if (rule.freq === 'DAILY') {
    return kyivHm(addDaysToDateKey(dateKey, rule.interval), hh, mm);
  }
  if (rule.freq === 'WEEKLY') {
    if (rule.days.length === 0) {
      return kyivHm(addDaysToDateKey(dateKey, 7 * rule.interval), hh, mm);
    }
    // Найближчий наступний день зі списку. У межах того самого тижня -
    // інтервал не застосовується (він рахує ТИЖНІ, а не появи).
    const wanted = new Set(rule.days);
    for (let step = 1; step <= 7; step += 1) {
      const key = addDaysToDateKey(dateKey, step);
      if (wanted.has(RFC_DAYS[weekdayOf(key)] ?? '')) {
        // Перескочили на новий тиждень - додаємо решту інтервалу.
        const extra = rule.interval > 1 && weekStarted(dateKey, key) ? 7 * (rule.interval - 1) : 0;
        return kyivHm(addDaysToDateKey(key, extra), hh, mm);
      }
    }
    return null;
  }
  // MONTHLY: те саме число наступного місяця (BYMONTHDAY ≤ 28, тож
  // «31 лютого» не буває за побудовою).
  const [y, m] = dateKey.split('-').map(Number);
  const day = rule.monthDay ?? Number(dateKey.slice(8, 10));
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + rule.interval;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return kyivHm(`${ny}-${String(nm).padStart(2, '0')}-${String(day).padStart(2, '0')}`, hh, mm);
}

/**
 * Правило людською - для підтвердження й для списку.
 * @param {unknown} rrule
 * @returns {string} порожньо, якщо правила немає або воно нечитабельне
 */
export function recurrenceText(rrule) {
  const rule = parseRrule(rrule);
  if (!rule) return '';
  const every = rule.interval > 1 ? `раз на ${rule.interval} ` : '';
  if (rule.freq === 'DAILY') return rule.interval > 1 ? `${every}дні` : 'щодня';
  if (rule.freq === 'WEEKLY') {
    if (rule.days.length === 0) return rule.interval > 1 ? `${every}тижні` : 'щотижня';
    const names = rule.days.map((d) => DAY_HUMAN[d] ?? d);
    // «щопонеділка і щочетверга», а не «щопонеділка, четверга»: підпис має
    // читатись так само, як власник це сказав.
    return rule.interval > 1 ? `${every}тижні: ${names.join(', ')}` : `що${names.join(' і що')}`;
  }
  const day = rule.monthDay != null ? ` ${rule.monthDay}-го` : '';
  return rule.interval > 1 ? `${every}місяці${day}` : `щомісяця${day}`;
}

/** Київські дата/година/хвилина моменту. @param {number} ms */
function kyivParts(ms) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const get = (/** @type {string} */ t) => f.find((p) => p.type === t)?.value ?? '';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    hh: Number(get('hour')),
    mm: Number(get('minute')),
  };
}

/** Київський «dateKey HH:MM» → мс UTC (той самий двопрохідний зсув, що в
 *  reminders-core: офсет береться на ЦІЛЬОВІЙ даті, не на «зараз»).
 *  @param {string} dateKey @param {number} hh @param {number} mm */
function kyivHm(dateKey, hh, mm) {
  const naive = Date.parse(
    `${dateKey}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`,
  );
  if (!Number.isFinite(naive)) return NaN;
  const off1 = kyivOffsetMin(naive);
  const first = naive - off1 * 60_000;
  const off2 = kyivOffsetMin(first);
  return off2 === off1 ? first : naive - off2 * 60_000;
}

/** Зсув Києва у хвилинах на момент ms. @param {number} ms */
function kyivOffsetMin(ms) {
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    timeZoneName: 'longOffset',
  })
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'timeZoneName')?.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name ?? '');
  if (!m) return 0;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Індекс дня тижня (0=нд) для київської дати. @param {string} dateKey */
function weekdayOf(dateKey) {
  return new Date(`${dateKey}T12:00:00Z`).getUTCDay();
}

/** Чи `to` вже в наступному тижні відносно `from` (тиждень із понеділка).
 *  @param {string} from @param {string} to */
function weekStarted(from, to) {
  const mondayOf = (/** @type {string} */ key) => {
    const wd = weekdayOf(key);
    return addDaysToDateKey(key, -(wd === 0 ? 6 : wd - 1));
  };
  return mondayOf(to) > mondayOf(from);
}
