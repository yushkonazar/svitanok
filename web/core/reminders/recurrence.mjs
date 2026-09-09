// Повторювані нагадування (§3.1 релізного плану): «щопонеділка о 9»,
// «щодня о 23:00», «щомісяця 1-го», «раз на два тижні в пʼятницю».
//
// ⚠️ ЧОМУ ПІДМНОЖИНА RFC 5545, А НЕ ПОВНИЙ RRULE. Побутовий повтор - це
// «щодня», «по днях тижня» і «раз на місяць числом». Усе, що складніше
// («останній робочий день кварталу»), власник однаково скаже словами, і
// чесна відмова там краща за мовчазне «зрозумів інакше». Формат лишається
// стандартним, щоб рядок у базі читався без словника:
//   FREQ=DAILY|WEEKLY|MONTHLY[;INTERVAL=n][;BYDAY=MO,TU][;BYMONTHDAY=n]
//   [;BYHOUR=h;BYMINUTE=m]
//
// ⚠️ ЧАС РАХУЄ ЯДРО, не модель (той самий інваріант, що для одноразових):
// модель дає природний текст, парсер тут дістає і правило, і першу появу.
//
// ⚠️ ГОДИНА ЖИВЕ В ПРАВИЛІ (BYHOUR/BYMINUTE), а не вичитується з попередньої
// появи. Інакше весняне переведення годинника ламало б ряд назавжди: 29.03
// київської 03:30 не існує, момент лягає на 04:30 - і наступна поява, читаючи
// годину з нього, лишалась би о 04:30 до кінця ряду.
//
// ⚠️ НАСТУПНА ПОЯВА РАХУЄТЬСЯ ВІД ПОПЕРЕДНЬОЇ, а не «now + період»: інакше
// нагадування щодня о 9:00 повзло б уперед на секунди затримки планувальника
// і за місяць з'їхало б на іншу годину.

import { addDaysToDateKey } from '../../reminders-core.mjs';
import { plural } from '../tg/phrase.mjs';

/** Дні тижня в порядку RFC 5545 (SU=0, як у Date#getUTCDay). */
const RFC_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** Українська літера. ⚠️ Не `\w`: у JS це [A-Za-z0-9_], і «щопонеділка» такий
 *  шаблон обривав на «щопонеділ», лишаючи «ка» в тексті часу.
 *  Три апострофи навмисно: ʼ (U+02BC), ' (U+0027) і ’ (U+2019) - останній
 *  ставить автозаміна iOS та Telegram, і без нього «щоп’ятниці» мовчки
 *  ставало одноразовим (ревʼю). */
const L = "[а-яіїєґА-ЯІЇЄҐ'ʼ’]";

/**
 * Дні тижня ПОВНИМИ формами: основа + перелік закінчень.
 *
 * ⚠️ НЕ «основа + будь-які літери» (ревʼю). Жадібний хвіст робив із «по
 * середині дня» середу, а з «в четвертому розділі» четвер, ще й вигризав ці
 * слова з тексту нагадування. Закінчення перелічені, а `(?![а-яіїєґ])` не дає
 * зачепити довше слово.
 * @type {[string, string][]}
 */
const DAY_FORMS = [
  ['MO', 'понеділ(?:ок|ка|ку|ки|ках|кам)'],
  ['TU', 'вівтор(?:ок|ка|ку|ки|ках|кам)'],
  ['WE', 'серед(?:а|у|и|і|ах|ам)'],
  ['TH', 'четвер(?:га|гу|ги|гах|гам)?'],
  ['FR', "(?:пʼятниц|п'ятниц|п’ятниц|пятниц)(?:я|ю|і|ях|ям|и)"],
  ['SA', 'субот(?:а|у|и|і|ах|ам)'],
  ['SU', 'неділ(?:я|ю|і|ях|ям)'],
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

/** Стеля інтервалу: більше - це вже не побутовий повтор, а планування року. */
const MAX_INTERVAL = 12;

/** Одиниця періоду. ⚠️ Довші форми ПЕРШИМИ: альтернація в JS не жадібна, і
 *  «дні» перед «днів» лишало хвіст «в» у тексті нагадування (ревʼю). */
const UNIT = `(днів|дні|дня|день|доб${L}*|тижден${L}*|тижн${L}*|місяц${L}*)`;

/** «раз на два тижні», «кожні 3 дні», «кожного місяця», «кожен день». */
const EVERY_RE = new RegExp(
  `(?:раз\\s+на|кож(?:ен|н${L}+))\\s+(\\d+|два|дві|три|чотири)?\\s*${UNIT}`,
  'i',
);

/**
 * «що два тижні», «що три дні» - «що» ОКРЕМО, але ЛИШЕ з числом.
 *
 * ⚠️ Число тут обовʼязкове, і це не примха: саме безумовне `що\\s*(одиниця)`
 * робило з речення «нагадай, що дні здачі звіту вже завтра» вічний ряд. З
 * числом фраза однозначна - звичайний текст «що два тижні» не містить.
 */
const SPACED_RE = new RegExp(`(?<![а-яіїєґ])що\\s+(\\d+|два|дві|три|чотири)\\s+${UNIT}`, 'i');

/**
 * «щодня», «щотижня», «щомісяця» - «що» ЗЛИТЕ з одиницею.
 *
 * ⚠️ Пробіл після «що» заборонений навмисно (ревʼю): доти шаблон приймав
 * `що\s*(день|дні|…)`, і звичайне речення «нагадай, що дні здачі звіту вже
 * завтра» ставало вічним щоденним рядом - зі з'їденим словом «дні» на додачу.
 * ⚠️ «денно», а не «денн…»: інакше «купити щоденник» теж ставало б повтором.
 */
const GLUED_RE =
  /(?<![а-яіїєґ])що(дня|дні|днів|денно|ранку|вечора|ночі|доб[а-яіїєґ]*|тижден[а-яіїєґ]*|тижн[а-яіїєґ]*|місяц[а-яіїєґ]*)(?![а-яіїєґ])/i;

/** Префікси, що РОБЛЯТЬ день тижня повтором. */
const DAY_ANCHOR = `(?:що|по\\s+|кожн${L}+\\s+)`;
/** «в пʼятницю» - день називає вже знайдене тижневе правило, сам собою не повтор. */
const DAY_WEAK = `(?:[ву]\\s+)`;
/** «і четвергах», «, щосереди» - продовження переліку днів. */
const DAY_LIST = `(?:[,;]?\\s*(?:і|й|та)\\s+)`;

/** Одиниця (у будь-якому відмінку) → частота. @param {string} unit */
function freqOfUnit(unit) {
  const u = unit.toLowerCase();
  if (u.startsWith('тижн') || u.startsWith('тижден')) return 'WEEKLY';
  if (u.startsWith('місяц')) return 'MONTHLY';
  return 'DAILY';
}

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

  /** Вирізані шматки - ПОЗИЦІЯМИ, не підрядками. ⚠️ `replace(m, ' ')` шукав
   *  ПЕРШЕ входження рядка, а не те, що збіглося, і при повторі слова різав не
   *  ту копію (ревʼю). `day` - щоб склеїти сусідні дні разом зі сполучником.
   *  @type {{ s: number, e: number, day: boolean }[]} */
  const cuts = [];

  let interval = 1;
  /** @type {'DAILY' | 'WEEKLY' | 'MONTHLY' | null} */
  let freq = null;

  const every = EVERY_RE.exec(text);
  if (every) {
    cuts.push({ s: every.index, e: every.index + every[0].length, day: false });
    const n = every[1];
    if (n) interval = /^\d+$/.test(n) ? Number(n) : (NUM_WORDS[n.toLowerCase()] ?? 1);
    freq = freqOfUnit(every[2] ?? '');
  }

  const spaced = SPACED_RE.exec(text);
  if (spaced) {
    cuts.push({ s: spaced.index, e: spaced.index + spaced[0].length, day: false });
    const n = spaced[1] ?? '';
    interval = /^\d+$/.test(n) ? Number(n) : (NUM_WORDS[n.toLowerCase()] ?? 1);
    freq = freqOfUnit(spaced[2] ?? '');
  }

  const glued = GLUED_RE.exec(text);
  if (glued) {
    cuts.push({ s: glued.index, e: glued.index + glued[0].length, day: false });
    freq = freqOfUnit(glued[1] ?? '');
  }

  // ⚠️ МІСЯЧНЕ ПРАВИЛО ДНІВ ТИЖНЯ НЕ БЕРЕ: «щомісяця по понеділках» - це не
  // наша підмножина RFC. Слова лишаються в тексті, тож власник побачить, що
  // його зрозуміли інакше, замість тихого «щомісяця 10-го» (ревʼю).
  const days = freq === 'MONTHLY' ? [] : collectDays(text, freq === 'WEEKLY', cuts);
  if (days.length > 0) freq = 'WEEKLY';

  // Число місяця - лише для місячного правила («1-го», «15 числа»).
  // 29-31 приймаємо: у коротких місяцях воно підтягується до останнього дня
  // (див. monthKey), тож «щомісяця 31-го» не мовчить і не пропускає лютий.
  // ⚠️ `(?<!\d)` - інакше «за 2026-го» давало BYMONTHDAY=26 і калічило текст.
  let monthDay = null;
  if (freq === 'MONTHLY') {
    const md = /(?<!\d)(\d{1,2})\s*(?:-?го|числа)(?![а-яіїєґ])/i.exec(text);
    if (md) {
      const n = Number(md[1]);
      if (n >= 1 && n <= 31) {
        monthDay = n;
        cuts.push({ s: md.index, e: md.index + md[0].length, day: false });
      }
    }
  }

  if (!freq) return null;
  if (interval < 1 || interval > MAX_INTERVAL) return null;

  const parts = [`FREQ=${freq}`];
  if (interval > 1) parts.push(`INTERVAL=${interval}`);
  if (freq === 'WEEKLY' && days.length > 0) parts.push(`BYDAY=${days.join(',')}`);
  if (freq === 'MONTHLY' && monthDay != null) parts.push(`BYMONTHDAY=${monthDay}`);

  return { rrule: parts.join(';'), rest: cutOut(text, cuts) };
}

/**
 * Дні тижня з фрази. Повертає коди RFC і ДОПИСУЄ вирізані шматки в `cuts`.
 *
 * ⚠️ Голий день тижня повтором НЕ стає: «нагадай у понеділок» - це конкретний
 * день. Приймається він у двох випадках: сам має префікс повторюваності
 * («щопонеділка», «по понеділках»), або тижневе правило вже знайдене чи задане
 * сусіднім днем - тоді «раз на два тижні в пʼятницю» і «по понеділках і
 * четвергах» читаються цілком. Доти виживав лише ПЕРШИЙ день, а решта разом зі
 * сполучником текла в текст нагадування (ревʼю).
 * @param {string} text
 * @param {boolean} weeklyKnown - правило вже тижневе («раз на два тижні …»)
 * @param {{ s: number, e: number, day: boolean }[]} cuts
 * @returns {string[]}
 */
function collectDays(text, weeklyKnown, cuts) {
  /** @type {{ s: number, e: number, code: string, kind: string }[]} */
  const hits = [];
  for (const [code, form] of DAY_FORMS) {
    const re = new RegExp(`(${DAY_ANCHOR}|${DAY_WEAK}|${DAY_LIST})(?:${form})(?![а-яіїєґ])`, 'gi');
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const pre = (m[1] ?? '').toLowerCase();
      const kind = /^(?:що|по\s|кожн)/.test(pre) ? 'anchor' : /^[ву]\s/.test(pre) ? 'weak' : 'list';
      hits.push({ s: m.index, e: m.index + m[0].length, code, kind });
    }
  }
  hits.sort((a, b) => a.s - b.s);
  if (!hits.some((h) => h.kind === 'anchor') && !weeklyKnown) return [];

  /** @type {string[]} */
  const days = [];
  let taken = false;
  for (const h of hits) {
    // «і четвер» без попереднього дня - це не перелік, а звичайний текст.
    if (h.kind === 'list' && !taken) continue;
    if (!days.includes(h.code)) days.push(h.code);
    cuts.push({ s: h.s, e: h.e, day: true });
    taken = true;
  }
  return days;
}

/**
 * Прибрати з фрази вирізані шматки. Проміжок між двома ДНЯМИ, у якому лишився
 * тільки сполучник або кома, зникає разом із ними: «щовівторка і щочетверга о
 * 8 зарядка» має дати текст «зарядка», а не «і зарядка» (ревʼю).
 * @param {string} text
 * @param {{ s: number, e: number, day: boolean }[]} cuts
 */
function cutOut(text, cuts) {
  const sorted = [...cuts].sort((a, b) => a.s - b.s);
  let out = '';
  let pos = 0;
  let prevDay = false;
  for (const c of sorted) {
    if (c.s < pos) continue; // перекриття - перший виграв
    const gap = text.slice(pos, c.s);
    const glue = prevDay && c.day && /^[\s,;]*(?:і|й|та)?[\s,;]*$/i.test(gap);
    out += glue ? '' : `${gap} `;
    pos = c.e;
    prevDay = c.day;
  }
  return (out + text.slice(pos)).replace(/\s{2,}/g, ' ').trim();
}

/**
 * Прибити правило до конкретного моменту першої появи: година, хвилина і - для
 * місячного - число, якщо власник його не назвав.
 *
 * ⚠️ НАВІЩО. Без цього наступна поява читала б годину з попередньої, і будь-який
 * зсув (весняне переведення годинника, коли названої години просто не існує)
 * лишався б у ряді назавжди. Якір робить правило самодостатнім.
 * @param {string} rrule
 * @param {number} atMs
 * @returns {string}
 */
export function anchorRrule(rrule, atMs) {
  const rule = parseRrule(rrule);
  if (!rule) return rrule;
  const { dateKey, hh, mm } = kyivParts(atMs);
  const parts = [`FREQ=${rule.freq}`];
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);
  if (rule.freq === 'WEEKLY' && rule.days.length > 0) parts.push(`BYDAY=${rule.days.join(',')}`);
  if (rule.freq === 'MONTHLY') {
    parts.push(`BYMONTHDAY=${rule.monthDay ?? Number(dateKey.slice(8, 10))}`);
  }
  parts.push(`BYHOUR=${hh}`, `BYMINUTE=${mm}`);
  return parts.join(';');
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
    const [y, m] = dateKey.split('-').map(Number);
    const at = (/** @type {number} */ yy, /** @type {number} */ mo) =>
      kyivHm(monthKey(yy, mo, rule.monthDay ?? 1), hh, mm);
    const thisMonth = at(y ?? 0, m ?? 1);
    // ⚠️ Порівняння з точністю до ХВИЛИНИ (ревʼю). База від відносної фрази
    // («через 2 години») несе секунди, а `kyivHm` їх обнуляє - і «щомісяця
    // 15-го», сказане 15-го о 10:00:37, перестрибувало цілий місяць.
    if (thisMonth >= Math.floor(baseMs / 60_000) * 60_000) return thisMonth;
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
 *   days: string[], monthDay: number | null, hour: number | null,
 *   minute: number | null } | null}
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
  // ⚠️ Невідомий день - null, а не тихий відсів (ревʼю): «BYDAY=XX» інакше
  // давало б звичайний тижневий ряд із підписом «щотижня», тобто здогад.
  const days = kv.BYDAY ? kv.BYDAY.split(',') : [];
  if (days.some((d) => !RFC_DAYS.includes(d))) return null;
  const monthDay = kv.BYMONTHDAY ? Number(kv.BYMONTHDAY) : null;
  if (monthDay != null && (!Number.isInteger(monthDay) || monthDay < 1 || monthDay > 31)) {
    return null;
  }
  const hour = kv.BYHOUR ? Number(kv.BYHOUR) : null;
  const minute = kv.BYMINUTE ? Number(kv.BYMINUTE) : null;
  if (hour != null && (!Number.isInteger(hour) || hour < 0 || hour > 23)) return null;
  if (minute != null && (!Number.isInteger(minute) || minute < 0 || minute > 59)) return null;
  return { freq, interval, days, monthDay, hour, minute };
}

/**
 * Коли повтор спрацює НАСТУПНОГО разу після `prevMs`.
 *
 * Година й хвилина беруться з правила (BYHOUR/BYMINUTE), а якщо їх там немає -
 * з попередньої появи за Києвом. Дата збирається київським «dateKey HH:MM», тож
 * переведення годинника не зсуває ряд.
 * @param {unknown} rrule
 * @param {number} prevMs
 * @returns {number | null} null = правило нечитабельне
 */
export function nextOccurrence(rrule, prevMs) {
  const rule = parseRrule(rrule);
  if (!rule) return null;
  const { dateKey, hh, mm } = kyivParts(prevMs);
  const H = rule.hour ?? hh;
  const M = rule.minute ?? mm;

  if (rule.freq === 'DAILY') {
    return kyivHm(addDaysToDateKey(dateKey, rule.interval), H, M);
  }
  if (rule.freq === 'WEEKLY') {
    if (rule.days.length === 0) {
      return kyivHm(addDaysToDateKey(dateKey, 7 * rule.interval), H, M);
    }
    // Найближчий наступний день зі списку. У межах того самого тижня -
    // інтервал не застосовується (він рахує ТИЖНІ, а не появи).
    const wanted = new Set(rule.days);
    for (let step = 1; step <= 7; step += 1) {
      const key = addDaysToDateKey(dateKey, step);
      if (wanted.has(RFC_DAYS[weekdayOf(key)] ?? '')) {
        // Перескочили на новий тиждень - додаємо решту інтервалу.
        const extra = rule.interval > 1 && weekStarted(dateKey, key) ? 7 * (rule.interval - 1) : 0;
        return kyivHm(addDaysToDateKey(key, extra), H, M);
      }
    }
    return null;
  }
  // MONTHLY: те саме число наступного місяця. Число, якого в місяці немає
  // (31-ше в лютому), підтягується до останнього дня - і НЕ ратчетиться, бо
  // береться з правила, а не з попередньої появи.
  const [y, m] = dateKey.split('-').map(Number);
  const day = rule.monthDay ?? Number(dateKey.slice(8, 10));
  const total = (y ?? 0) * 12 + ((m ?? 1) - 1) + rule.interval;
  return kyivHm(monthKey(Math.floor(total / 12), (total % 12) + 1, day), H, M);
}

/**
 * Правило людською - для підтвердження й для списку.
 * @param {unknown} rrule
 * @returns {string} порожньо, якщо правила немає або воно нечитабельне
 */
export function recurrenceText(rrule) {
  const rule = parseRrule(rrule);
  if (!rule) return '';
  // ⚠️ Через `plural`, а не голим відмінком (ревʼю): доти виходило «раз на 5
  // дні», «раз на 5 тижні», «раз на 5 місяці» - і цей підпис іде і власнику в
  // /reminders, і моделі в `repeat`.
  const n = rule.interval;
  const every = n > 1 ? `раз на ${n} ` : '';
  const days = plural(n, 'день', 'дні', 'днів');
  const weeks = plural(n, 'тиждень', 'тижні', 'тижнів');
  if (rule.freq === 'DAILY') return n > 1 ? `${every}${days}` : 'щодня';
  if (rule.freq === 'WEEKLY') {
    if (rule.days.length === 0) return n > 1 ? `${every}${weeks}` : 'щотижня';
    const names = rule.days.map((d) => DAY_HUMAN[d] ?? d);
    // «щопонеділка і щочетверга», а не «щопонеділка, четверга»: підпис має
    // читатись так само, як власник це сказав.
    return n > 1 ? `${every}${weeks}: ${names.join(', ')}` : `що${names.join(' і що')}`;
  }
  const day = rule.monthDay != null ? ` ${rule.monthDay}-го` : '';
  return n > 1 ? `${every}${plural(n, 'місяць', 'місяці', 'місяців')}${day}` : `щомісяця${day}`;
}

/** Скільки днів у місяці (григоріанський, із високосними). */
function daysInMonth(/** @type {number} */ y, /** @type {number} */ m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Київський dateKey місяця з числом, підтягнутим до довжини місяця. */
function monthKey(/** @type {number} */ y, /** @type {number} */ m, /** @type {number} */ day) {
  const d = Math.min(day, daysInMonth(y, m));
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Форматери - НА РІВНІ МОДУЛЯ, а не на кожен виклик (ревʼю релізу).
 *
 * ⚠️ `new Intl.DateTimeFormat` коштує ~0.09 мс (замір із калібруванням), а
 * `nextOccurrence` кличе обидва по кілька разів. При стелі `dueReminders` у 20
 * рядків тік доставки витрачав ~6 мс лише на арифметику повторів - при бюджеті
 * Worker'а ~10 мс CPU, ще ДО D1 і черги. Той самий прийом уже вжито в
 * agent-core.mjs і calendar-core.mjs.
 */
const KYIV_PARTS_FMT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Kyiv',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const KYIV_OFFSET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Kyiv',
  timeZoneName: 'longOffset',
});

/** Київські дата/година/хвилина моменту. @param {number} ms */
function kyivParts(ms) {
  const f = KYIV_PARTS_FMT.formatToParts(new Date(ms));
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
  const name = KYIV_OFFSET_FMT.formatToParts(new Date(ms)).find(
    (p) => p.type === 'timeZoneName',
  )?.value;
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
