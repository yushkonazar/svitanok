// Чиста логіка нагадувань (Блок P2a): парс українського часу з тексту
// ("через 20 хв", "завтра о 10", "о 15:30"), стор у state.reminders, вибірка
// «на видачу», snooze. Без I/O — Worker робить KV/HTTP; cron у Worker кличе
// dueReminders/markFired кожні 5 хв.
//
// LLM-фолбек (для формулювань, які rule-based не впізнає, напр. "в обід",
// "післязавтра"): LLM НЕ рахує час сам (ненадійна арифметика дат) — лише
// ПЕРЕПИСУЄ нечітку фразу в один із канонічних патернів, які parseReminderTime
// вже вміє парсити (уся DST-aware математика лишається в одному, перевіреному
// місці). Worker кличе VPS-хост (host/) із buildLlmRewriteSystemPrompt, тоді
// прогонює відповідь через ЦЕЙ САМИЙ parseReminderTime вдруге.

import { escapeHtml } from './tg-core.mjs';

/** @typedef {import('./calendar-core.mjs').CalEvent} CalEvent */
/** @typedef {import('./calendar-core.mjs').EventSpan} EventSpan */

/**
 * Нагадування у state.reminders. `chatId`/`threadId` опційні НАВМИСНО (B12):
 * запис без них означає «адреси не знаємо», і доставка чесно йде у фолбек,
 * а не в «null-чат».
 * `repeat` НЕ зберігається у стані: це людський опис rrule, який /reminders
 * підмішує на льоту (§3.1), щоб рядок списку не був схожий на одноразовий.
 * @typedef {{ id: string, text: string, whenMs: number, createdMs?: number,
 *             firedTs?: number|null, chatId?: string|number,
 *             threadId?: string|number|null, repeat?: string }} Reminder
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
export const SNOOZE_MINUTES = 10;

/** UTC-офсет Києва (хв) у момент nowMs — DST-aware через Intl shortOffset. */
function kyivOffsetMinutes(/** @type {number} */ nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(nowMs));
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+2';
  const m = tz.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 120;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Київська дата "YYYY-MM-DD" у момент nowMs.
 *  @param {number} nowMs */
function kyivDateKeyOf(nowMs) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

// Експортовано — worker.js (Блок P2b, runAssistantAgent) переюзує для
// readCalendar "N днів від сьогодні": чиста Y-M-D арифметика через UTC-
// північ, а НЕ +N*86400000мс на реальний інстант (те друге ламається на
// DST-переході, коли Y-M-D зсув і +1год стрибок комбінуються і "перестрибують"
// через межу доби двічі — перевірено на весняному переході).
/**
 * @param {string} dateKey
 * @param {number} days
 */
export function addDaysToDateKey(dateKey, days) {
  const d = new Date(dateKey + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Київський "dateKey HH:MM" (місцевий час) -> мс UTC.
 *
 * Офсет беремо на ЦІЛЬОВІЙ даті, не на «зараз» (B1). Раніше сюди передавали
 * nowMs — і це працювало лише тому, що ціль була максимум «завтра». Щойно
 * зʼявились календарні дати («3 січня», сказане в липні), літній +03:00
 * застосувався б до зимової дати й нагадування спрацювало б на годину раніше.
 * Два проходи: перший офсет — за наївним інстантом, другий — уточнення вже за
 * порахованим (рятує, коли перший прохід перестрибнув саму межу DST).
 * @param {string} dateKey
 * @param {number} hh
 * @param {number} mm
 */
function kyivHmToUtcMs(dateKey, hh, mm) {
  const naiveUtc = Date.parse(
    `${dateKey}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00Z`,
  );
  if (!Number.isFinite(naiveUtc)) return NaN;
  const off1 = kyivOffsetMinutes(naiveUtc);
  const first = naiveUtc - off1 * MINUTE;
  const off2 = kyivOffsetMinutes(first);
  return off2 === off1 ? first : naiveUtc - off2 * MINUTE;
}

// Прибрати тригер-фразу з початку ("нагадай/нагадати/нагадуй [мені] [про]") —
// спільна точка входу і для "/remind <args>" (де її вже нема), і для вільного
// тексту в чаті (де вона є).
function stripTrigger(/** @type {string} */ text) {
  return text.replace(/^\s*нагад(ай|ати|уй)(\s+мені)?(\s+про)?\s*/i, '');
}

/**
 * @param {string} text
 * @param {string|(string|undefined)[]} matched
 */
function cleanRemainder(text, matched) {
  // matched — рядок або масив рядків (дата + час стрипаються обидва).
  // Розгорнуто в цикл замість filter(Boolean): виведення предиката з filter
  // тут не спрацьовує, а результат мусить бути саме string[]. Умова та сама.
  /** @type {string[]} */
  const parts = [];
  if (Array.isArray(matched)) {
    for (const p of matched) if (typeof p === 'string' && p !== '') parts.push(p);
  } else {
    parts.push(matched);
  }
  let rest = text;
  for (const p of parts) rest = rest.replace(p, '');
  rest = rest.replace(/\s{2,}/g, ' ').trim();
  return rest || 'Нагадування';
}

// Календарна дата (B1). Місяці — ПОВНІ відмінені форми (родовий для дат «24 липня»
// + називний «липень»), НЕ стеми: стем «квіт»+[а-яіїєґ]* хибно ловив «квітів»
// (квіти) як квітень, «трав» — «трав» (трава) як травень (ревʼю B). Кожна форма
// закінчується так, що звичайні іменники з тим самим коренем не збігаються.
const MONTHS = [
  ['січень', 'січня'],
  ['лютий', 'лютого'],
  ['березень', 'березня'],
  ['квітень', 'квітня'],
  ['травень', 'травня'],
  ['червень', 'червня'],
  ['липень', 'липня'],
  ['серпень', 'серпня'],
  ['вересень', 'вересня'],
  ['жовтень', 'жовтня'],
  ['листопад', 'листопада'],
  ['грудень', 'грудня'],
];
/** @type {Record<string, number>} */
const MONTH_TO_NUM = {};
MONTHS.forEach((forms, i) => forms.forEach((f) => (MONTH_TO_NUM[f] = i + 1)));
// Довші форми першими (щоб «листопада» не обрізалось на «листопад» перед межею).
const MONTH_ALT = Object.keys(MONTH_TO_NUM)
  .sort((a, b) => b.length - a.length)
  .join('|');
// «DD <місяць>» — межі слова через кириличний lookaround (\b не працює з не-\w).
const MONTH_RE = new RegExp(`(?<![а-яіїєґ\\d])(\\d{1,2})\\s+(${MONTH_ALT})(?![а-яіїєґ])`, 'i');
// Числова дата «DD.MM[.YYYY]»: місяць ЛИШЕ дві цифри (одноцифровий -> «через 1.5
// години» розібралось би як 1 травня). Негативний lookbehind на «о » — щоб час у
// європейськім записі «о 11.05» НЕ читався як дата 11 травня (ревʼю B); час
// ловить окремий extractTime нижче.
const NUM_DATE_RE = /(?<![а-яіїєґ\d.])(?<!о\s)(\d{1,2})\.(\d{2})(?:\.(\d{2,4}))?(?!\d)/;
// Час «о HH», «о HH:MM», «о HH.MM» будь-де (о = «о котрій»). Крапка ТЕЖ як
// роздільник — «о 11.05» = 11:05 (поширений європейський запис).
const TIME_RE = /(?<![а-яіїєґ'])о\s+(\d{1,2})(?:[:.](\d{2}))?(?![а-яіїєґ\d])/i;
// Дата без часу («нагадай 24 липня скасувати підписку») — ставимо на ранок.
export const DEFAULT_DATE_HOUR = 10;
// Скільки років уперед шукати найближчу валідну дату без року (29 лютого може
// бути аж за 2-3 роки — ревʼю B; +5 покриває будь-який високосний випадок).
const MAX_YEAR_LOOKAHEAD = 5;

/** Київський рік у момент nowMs (для «24 липня» без року).
 *  @param {number} nowMs */
function kyivYearOf(nowMs) {
  return Number(kyivDateKeyOf(nowMs).slice(0, 4));
}

/** Витягти час «о HH[:.]MM» будь-де в тексті -> {hh,mm,matched}|null (валідний час).
 *  @param {string} text */
function extractTime(text) {
  const m = text.match(TIME_RE);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2] || 0);
  if (hh > 23 || mm > 59) return null;
  return { hh, mm, matched: m[0] };
}

/**
 * Розібрати текст на {whenMs, remainder} — rule-based час (укр) + залишок як
 * текст нагадування. Порядок патернів (перший влучний перемагає): відносний
 * ("через N хв/год") -> "завтра/сьогодні [...] о HH" -> календарна дата
 * ("24 липня [... о 18:30]", "24.07") -> голе "о HH[:.]MM".
 * "сьогодні о HH" що вже минуло -> null (не вгадуємо мовчки замість юзера).
 * Немає влучного патерну -> null (виклик далі пробує LLM-фолбек або відмовляє).
 *
 * Час («о HH») витягується ОКРЕМО (extractTime) і застосовується до дня/дати
 * незалежно від того, чи стоїть він упритул (ревʼю B: «завтра підписати договір
 * о 14» раніше ігнорувало «завтра», «24 липня подзвонити мамі о 15» — «о 15»).
 * @param {unknown} rawText
 * @param {number} [nowMs]
 * @returns {{ whenMs: number, remainder: string }|null}
 */
export function parseReminderTime(rawText, nowMs = Date.now()) {
  if (typeof rawText !== 'string') return null;
  const text = stripTrigger(rawText.trim());
  if (!text) return null;

  const rel = text.match(/через\s+(\d+)\s*(хвилин[иу]?|хв\.?|годин[иу]?|год\.?)/i);
  if (rel) {
    const n = Number(rel[1]);
    if (n > 0) {
      const isHours = /^год/i.test(rel[2] ?? '');
      return {
        whenMs: nowMs + n * (isHours ? HOUR : MINUTE),
        remainder: cleanRemainder(text, rel[0]),
      };
    }
  }

  // Час — окремо, застосуємо і до «завтра», і до календарної дати, і як голий.
  const time = extractTime(text);

  // «завтра/сьогодні» будь-де (не конче впритул до «о HH» — ревʼю B). Без часу
  // не беремо: «завтра» саме по собі не задає години — хай далі вирішує LLM.
  const dayWord = text.match(/(?<![а-яіїєґ])(завтра|сьогодні)(?![а-яіїєґ])/i);
  if (dayWord && time) {
    const isTomorrow = /завтра/i.test(dayWord[1] ?? '');
    const today = kyivDateKeyOf(nowMs);
    const dateKey = isTomorrow ? addDaysToDateKey(today, 1) : today;
    const whenMs = kyivHmToUtcMs(dateKey, time.hh, time.mm);
    if (isTomorrow || whenMs > nowMs) {
      return { whenMs, remainder: cleanRemainder(text, [dayWord[0], time.matched]) };
    }
    return null; // сьогодні + минулий час -> не перегадуємо за юзера
  }

  // Календарна дата (B1) — «24 липня», «24 липня о 18:30», «24.07», «24.07.2026».
  // Без часу -> DEFAULT_DATE_HOUR (10:00): фраза «нагадай 24 липня скасувати
  // підписку» — нормальний запит, а не помилка, і раніше він упирався в глухе
  // «🤔 Не зрозумів час» (ні rule-based патерну, ні канонічного прикладу для LLM).
  const named = text.match(MONTH_RE);
  const numeric = named ? null : text.match(NUM_DATE_RE);
  const dm = named || numeric;
  if (dm) {
    const day = Number(dm[1]);
    // `?? NaN` дає той самий результат, що й колишній undefined: обидва
    // провалюють перевірку `month >= 1` нижче.
    const month = named ? (MONTH_TO_NUM[(dm[2] ?? '').toLowerCase()] ?? NaN) : Number(dm[2]);
    const hh = time ? time.hh : DEFAULT_DATE_HOUR;
    const mm = time ? time.mm : 0;
    // Явний рік — лише в числовій формі («24.07.2026»); 2-значний -> 20xx.
    const rawYear = named ? undefined : dm[3];
    const explicitYear =
      rawYear === undefined
        ? null
        : Number(rawYear) < 100
          ? 2000 + Number(rawYear)
          : Number(rawYear);
    if (day >= 1 && month >= 1 && month <= 12) {
      // Довжина місяця — ОБОВʼЯЗКОВО, і саме тут: Date.parse('2026-02-31T…') у V8
      // не дає NaN, а перекочує на 3 березня. «31.02» -> NaN -> відмова.
      const daysInMonth = (/** @type {number} */ year) =>
        new Date(Date.UTC(year, month, 0)).getUTCDate();
      const build = (/** @type {number} */ year) =>
        day > daysInMonth(year)
          ? NaN
          : kyivHmToUtcMs(
              `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
              hh,
              mm,
            );
      let whenMs = NaN;
      if (explicitYear !== null) {
        whenMs = build(explicitYear);
      } else {
        // Без року — найближчий рік уперед, чия дата в майбутньому. Цикл (не одна
        // спроба +1) — бо «29 лютого» валідне лише за 2-3 роки (найближчий
        // високосний), ревʼю B. formatReminderConfirm покаже рік, коли не поточний.
        const base = kyivYearOf(nowMs);
        for (let i = 0; i <= MAX_YEAR_LOOKAHEAD; i++) {
          const cand = build(base + i);
          if (Number.isFinite(cand) && cand > nowMs) {
            whenMs = cand;
            break;
          }
        }
      }
      if (Number.isFinite(whenMs) && whenMs > nowMs) {
        return { whenMs, remainder: cleanRemainder(text, [dm[0], time?.matched]) };
      }
    }
    return null; // явна дата, але безглузда (31.02 / минулий явний рік) — не вгадуємо
  }

  // Голе «о HH[:.]MM» — сьогодні, або завтра якщо час уже минув.
  if (time) {
    const today = kyivDateKeyOf(nowMs);
    let whenMs = kyivHmToUtcMs(today, time.hh, time.mm);
    if (whenMs <= nowMs) whenMs = kyivHmToUtcMs(addDaysToDateKey(today, 1), time.hh, time.mm);
    return { whenMs, remainder: cleanRemainder(text, time.matched) };
  }

  return null;
}

/* ── Частини доби («вранці»/«в обід»/«після обіду»/«ввечері» тощо) ────────────
   parseReminderTime НІКОЛИ не вгадує конкретну годину сама (той самий інваріант,
   що для "в обід"/LLM-рерайту, шапка файлу) — фраза частини доби мапиться лише
   в ДІАПАЗОН годин. Яку саме годину в діапазоні запропонувати, вирішує worker.js
   (readCalendarRange -> pickDayPartSlot нижче): вільна година в діапазоні, якщо
   є; інакше чесний запасний варіант. Результат ЗАВЖДИ іде через staged-confirm
   (proposeCalendarChanges), НЕ через пряме createReminder — власник бачить
   запропонований час і може підправити його циклером 🕐 до підтвердження. */

/* ── Намір: нове нагадування чи щось складніше? (B23) ───────────────────────
   Роутинг у worker.js жадібно віддавав ЛЮБЕ повідомлення зі словом «нагад»
   парсеру нагадувань — а той уміє рівно одне: зрізати час і покласти решту
   тексту в тіло. Наслідок (перевірено власником наживо):
     «Заплануй зустріч о 15:00 і нагадай за годину до неї» -> нагадування на
       15:00 (не 14:00) з дослівним текстом, події НЕМАЄ;
     «Скасуй нагадування про молоко і постав натомість на четвер» -> створене
       ЩЕ ОДНЕ нагадування, старе не скасоване;
     «Перенеси нагадування про молоко на 20:00» -> нове нагадування на сьогодні.
   Тобто агентські cancelReminder/updateReminder були недосяжні природною
   мовою: будь-яке природне формулювання містить «нагад».

   Класифікатор свідомо ВУЗЬКИЙ — хибний «агент» дорожчий за хибний «парсер»
   (парсер швидкий, детермінований і працює без хоста). Тому:
   1. Мутація нагадування вимагає ДВОХ сигналів: дієслова-команди І іменника
      «нагадуванн», інакше «нагадай оновити резюме о 18:00» (звичайне
      нагадування, у тексті якого випадково є «онови») їхало б до агента.
   2. Планування вимагає саме НАКАЗОВОЇ форми ("заплануй", не "запланувати"):
      інфінітив — це майже завжди ЗМІСТ нагадування («нагадай запланувати
      відпустку»), а наказ — команда боту.
   Обидва списки — з живих провалів вище, не з фантазії; розширювати лише за
   новим підтвердженим прикладом. */

/** Наказ змінити/скасувати ІСНУЮЧЕ (перевіряється разом із «нагадуванн»). */
const REMINDER_MUTATION_RE =
  /(?<![а-яіїєґ])(скасуй|скасувати|перенеси|перенести|онови|оновити|видали|видалити)(?![а-яіїєґ])/i;
/** Іменник «нагадування» в будь-якому відмінку — обʼєкт мутації. */
const REMINDER_NOUN_RE = /(?<![а-яіїєґ])нагадуванн/i;
/** Наказ створити ЩЕ ОДИН обʼєкт (подію/запис) — тобто запит складніший за нагадування. */
const SCHEDULE_IMPERATIVE_RE = /(?<![а-яіїєґ])(заплануй|запиши|додай|створи)(?![а-яіїєґ])/i;
/** Тригер, за яким worker.js узагалі заходить у цю гілку. */
const REMINDER_TRIGGER_RE = /нагад/i;

/**
 * Кому віддати вільний текст із «нагад»: 'agent' (складніший намір) чи
 * 'reminder' (звичайне «нагадай ‹що› ‹коли›» — наявний, швидкий шлях).
 * Дефолт — 'reminder': до агента йдемо лише за СИЛЬНИМ сигналом.
 * @param {unknown} rawText
 * @returns {'agent'|'reminder'}
 */
export function classifyReminderIntent(rawText) {
  if (typeof rawText !== 'string' || !rawText.trim()) return 'reminder';
  const text = rawText.trim();
  // «Скасуй/перенеси НАГАДУВАННЯ …» — пряма мутація наявного.
  if (REMINDER_MUTATION_RE.test(text) && REMINDER_NOUN_RE.test(text)) return 'agent';
  // «Заплануй зустріч … і нагадай …» — дві дії, парсер зробив би лише пів справи.
  if (REMINDER_TRIGGER_RE.test(text) && SCHEDULE_IMPERATIVE_RE.test(text)) return 'agent';
  return 'reminder';
}

/**
 * Фрази частини доби -> діапазон годин. Порядок важливий (перший збіг
 * перемагає): «після обіду» — ОКРЕМА (пізніша) частина доби від «в обід»
 * (обід сам по собі), інші форми слова не перетинаються.
 */
export const DAY_PART_RANGES = [
  { label: 'вранці', re: /(?<![а-яіїєґ])(вранці|зранку)(?![а-яіїєґ])/i, startHour: 7, endHour: 10 },
  {
    label: 'після обіду',
    re: /(?<![а-яіїєґ])після\s+обід[уі]?(?![а-яіїєґ])/i,
    startHour: 14,
    endHour: 17,
  },
  {
    label: 'в обід',
    // Опційний прийменник ("в"/"на") — усередині ЦЬОГО Ж збігу (m[0]), інакше
    // cleanRemainder стирає лише "обід" і лишає осиротілий прийменник у тексті.
    re: /(?<![а-яіїєґ])(?:(?:в|на)\s+)?обід(?![а-яіїєґ])/i,
    startHour: 12,
    endHour: 14,
  },
  { label: 'вдень', re: /(?<![а-яіїєґ])(вдень|удень)(?![а-яіїєґ])/i, startHour: 11, endHour: 17 },
  {
    label: 'ввечері',
    re: /(?<![а-яіїєґ])(ввечері|увечері|вечором)(?![а-яіїєґ])/i,
    startHour: 18,
    endHour: 21,
  },
  { label: 'вночі', re: /(?<![а-яіїєґ])вночі(?![а-яіїєґ])/i, startHour: 21, endHour: 23 },
];

/**
 * Розпізнати фразу частини доби -> {label,startHour,endHour,matched,forcedDay,
 * remainder}|null. Явна година в тексті ("о 8") -> null: той випадок уже
 * покриває окремий, наявний шлях (LLM-рерайт конвертує "ввечері о 8" в
 * "о 20:00" — тут вгадувати діапазон не треба, година вже відома).
 *
 * forcedDay: 'tomorrow'/'today', коли текст явно каже «завтра»/«сьогодні»
 * поруч (worker.js звужує пошук вільної години до ОДНОГО дня); null -> не
 * вказано, шукати можна і сьогодні, і завтра.
 * @param {unknown} rawText
 */
export function matchDayPartRange(rawText) {
  if (typeof rawText !== 'string' || !rawText) return null;
  const text = stripTrigger(rawText.trim());
  if (!text || extractTime(text)) return null;
  for (const part of DAY_PART_RANGES) {
    const m = text.match(part.re);
    if (!m) continue;
    const dayWord = text.match(/(?<![а-яіїєґ])(завтра|сьогодні)(?![а-яіїєґ])/i);
    return {
      label: part.label,
      startHour: part.startHour,
      endHour: part.endHour,
      matched: m[0],
      forcedDay: dayWord ? (/завтра/i.test(dayWord[1] ?? '') ? 'tomorrow' : 'today') : null,
      remainder: cleanRemainder(text, [m[0], dayWord?.[0]]),
    };
  }
  return null;
}

// Тривалість слоту, що перевіряємо на зайнятість (хв) — нагадування миттєве,
// але перевіряємо ширше за секунду: не пропонувати час, що впаде всередину
// зустрічі, яка вже почалась чи от-от почнеться.
const SLOT_CHECK_MIN = 30;

/**
 * Перша вільна ГОДИНА (рівно HH:00) у [startHour,endHour) заданої дати (Київ),
 * що не перетинається з жодною подією `events` ({startMs,endMs}[] — той самий
 * формат, що calendar-core.parseEvents). `nowMs` відсікає вже минулі години
 * (0 -> нічого не минуло, для «завтра», де це не має сенсу). Немає вільної ->
 * null (викликач сам вирішує запасний варіант).
 * @param {readonly (EventSpan|null|undefined)[]|null|undefined} events
 * @param {string} dateKey
 * @param {number} startHour
 * @param {number} endHour
 * @param {number} [nowMs]
 * @returns {number|null}
 */
export function findFreeHourInRange(events, dateKey, startHour, endHour, nowMs = 0) {
  const list = Array.isArray(events) ? events : [];
  for (let h = startHour; h < endHour; h++) {
    const slotStart = kyivHmToUtcMs(dateKey, h, 0);
    if (!Number.isFinite(slotStart) || slotStart <= nowMs) continue;
    const slotEnd = slotStart + SLOT_CHECK_MIN * MINUTE;
    const busy = list.some(
      (e) =>
        e &&
        Number.isFinite(e.startMs) &&
        Number.isFinite(e.endMs) &&
        (e.startMs ?? 0) < slotEnd &&
        (e.endMs ?? 0) > slotStart,
    );
    if (!busy) return h;
  }
  return null;
}

/**
 * Обрати {dateKey,hour,isToday} серед кандидатних днів — перший із вільною
 * годиною в діапазоні перемагає (findFreeHourInRange, по черзі). Жодного
 * вільного -> запасний варіант: startHour першого дня, де діапазон ще НЕ
 * минув повністю (endMs > nowMs); якщо взагалі ніде — startHour найпершого
 * дня зі списку. Це чесний найкращий варіант, а не відмова: confirm-екран
 * покаже запропонований час, власник підправить циклером 🕐, якщо не підходить.
 *
 * `days` = [{dateKey, events, nowMs, isToday}] у порядку пріоритету (типово
 * сьогодні тоді завтра; worker.js звужує до одного дня, коли forcedDay заданий).
 * @param {{ dateKey: string, events?: readonly (EventSpan|null|undefined)[]|null,
 *           nowMs?: number, isToday?: boolean }[]} days
 * @param {number} startHour
 * @param {number} endHour
 */
export function pickDayPartSlot(days, startHour, endHour) {
  for (const day of days) {
    const h = findFreeHourInRange(day.events, day.dateKey, startHour, endHour, day.nowMs ?? 0);
    if (h != null) return { dateKey: day.dateKey, hour: h, isToday: Boolean(day.isToday) };
  }
  for (const day of days) {
    const endMs = kyivHmToUtcMs(day.dateKey, endHour, 0);
    if (!Number.isFinite(day.nowMs) || !Number.isFinite(endMs) || endMs > (day.nowMs ?? 0)) {
      return { dateKey: day.dateKey, hour: startHour, isToday: Boolean(day.isToday) };
    }
  }
  // Порожній `days` тут і раніше падав на `first.dateKey` — приведення нічого
  // не змінює, лише не вигадує нової гілки.
  const first = /** @type {{ dateKey: string, isToday?: boolean }} */ (days[0]);
  return { dateKey: first.dateKey, hour: startHour, isToday: Boolean(first.isToday) };
}

/** Додати нагадування (id/nowMs — від виклику, щоб функція лишалась чистою).
 *  @param {Reminder[]|null|undefined} reminders
 *  @param {{ id: string, text: string, whenMs: number, nowMs: number,
 *            chatId?: string|number|null, threadId?: string|number|null }} opts
 *  @returns {Reminder[]} */
export function addReminder(reminders, { id, text, whenMs, nowMs, chatId, threadId }) {
  const list = Array.isArray(reminders) ? reminders : [];
  return [
    ...list,
    {
      id,
      text,
      whenMs,
      createdMs: nowMs,
      firedTs: null,
      // Адреса доставки (B12). Доти нагадування летіло в захардкоджені
      // TELEGRAM_CHAT_ID + TOPIC_ASSISTANT незалежно від того, ДЕ його
      // створили: попросив у приватному чаті — відповідь приходила в тему
      // супергрупи. Пишемо лише те, що справді знаємо: undefined-поля не
      // зберігаємо, щоб доставка чесно впала у фолбек, а не в «null-чат».
      ...(chatId != null ? { chatId } : {}),
      ...(threadId != null ? { threadId } : {}),
    },
  ];
}

/** Нагадування «на видачу»: час настав і ще не спрацьовувало.
 *  @param {Reminder[]|null|undefined} reminders
 *  @param {number} nowMs */
export function dueReminders(reminders, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).filter(
    (r) => r && typeof r.whenMs === 'number' && r.whenMs <= nowMs && !r.firedTs,
  );
}

/** Позначити спрацьованим (ідемпотентно — уже виставлений firedTs не чіпаємо).
 *  @param {Reminder[]|null|undefined} reminders
 *  @param {string} id
 *  @param {number} nowMs */
export function markFired(reminders, id, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).map((r) =>
    r.id === id ? { ...r, firedTs: r.firedTs ?? nowMs } : r,
  );
}

/** Відкласти на SNOOZE_MINUTES: новий whenMs, скинути firedTs (спрацює знову).
 *  @param {Reminder[]|null|undefined} reminders
 *  @param {string} id
 *  @param {number} nowMs */
export function snoozeReminder(reminders, id, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).map((r) =>
    r.id === id ? { ...r, whenMs: nowMs + SNOOZE_MINUTES * MINUTE, firedTs: null } : r,
  );
}

/* ── Розширений snooze (extra b, схвалено власником) ────────────────────────
   Одна фіксована +10 хв (rm:<id>, вище) лишається — старе спрацьоване
   повідомлення в чаті власника вже має ЦЕЙ callback_data, і його не можна
   переписати заднім числом. Нові спрацьовування (checkReminders, worker.js)
   натомість шлють РЯДОК із трьох пресетів — окремий простір 'rs:', бо 'rm:'
   бере ВЕСЬ залишок як id (без internal split — той самий мотив, що й у
   коментарі при REMINDER_CANCEL_CB_PREFIX), підпростір усередині зламав би
   snooze-парсинг. 1440 = «завтра, та сама година» (той самий трюк, що
   EVENT_SHIFT_STEPS у agent-core.mjs). */
export const SNOOZE_PRESETS = [
  // Перший пресет — той самий інтервал, що й кнопка «відкласти» без вибору.
  // Тримаємо його ВІД КОНСТАНТИ (і число, і підпис): доти тут стояли два
  // незалежні літерали, тож «десяток» у проєкті було ТРИ — константа, це
  // число й текст тоста, — і жодна пара не була звʼязана.
  { minutes: SNOOZE_MINUTES, label: `😴 ${SNOOZE_MINUTES} хв` },
  { minutes: 60, label: '😴 1 год' },
  { minutes: 1440, label: '😴 завтра' },
];

/** Відкласти на пресет за індексом (SNOOZE_PRESETS) — невідомий індекс -> без змін.
 *  @param {Reminder[]|null|undefined} reminders
 *  @param {string} id
 *  @param {number} presetIdx
 *  @param {number} nowMs */
export function snoozeReminderPreset(reminders, id, presetIdx, nowMs) {
  const preset = SNOOZE_PRESETS[presetIdx];
  if (!preset) return Array.isArray(reminders) ? reminders : [];
  return (Array.isArray(reminders) ? reminders : []).map((r) =>
    r.id === id ? { ...r, whenMs: nowMs + preset.minutes * MINUTE, firedTs: null } : r,
  );
}

export const REMINDER_SNOOZE_CB_PREFIX = 'rs:';

/** `rs:<presetIdx>:<id>`; ≤64 байти, невалідний presetIdx -> null.
 *  @param {number} presetIdx
 *  @param {string} id
 *  @returns {string|null} */
export function buildReminderSnoozeCallbackData(presetIdx, id) {
  if (!Number.isInteger(presetIdx) || presetIdx < 0 || presetIdx >= SNOOZE_PRESETS.length)
    return null;
  const s = `${REMINDER_SNOOZE_CB_PREFIX}${presetIdx}:${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `rs:<presetIdx>:<id>` -> {presetIdx,id}|null.
 *  @param {unknown} data */
export function parseReminderSnoozeCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(REMINDER_SNOOZE_CB_PREFIX)) return null;
  const rest = data.slice(REMINDER_SNOOZE_CB_PREFIX.length);
  const sep = rest.indexOf(':');
  if (sep <= 0) return null;
  const presetIdx = Number(rest.slice(0, sep));
  const id = rest.slice(sep + 1);
  if (!Number.isInteger(presetIdx) || presetIdx < 0 || presetIdx >= SNOOZE_PRESETS.length || !id) {
    return null;
  }
  return { presetIdx, id };
}

/** Рядок кнопок-пресетів snooze + «✅ Виконано» для повідомлення «спрацювало»
 *  (checkReminders) — власник або відкладає, або одразу закриває нагадування.
 *  @param {string} id */
export function buildSnoozeRow(id) {
  const snoozeBtns = SNOOZE_PRESETS.map((preset, i) => {
    const cb = buildReminderSnoozeCallbackData(i, id);
    return cb ? { text: preset.label, callback_data: cb } : null;
  }).filter((btn) => btn !== null);
  const doneCb = buildReminderDoneCallbackData(id);
  return doneCb ? [...snoozeBtns, { text: '✅ Виконано', callback_data: doneCb }] : snoozeBtns;
}

/**
 * Скасувати (§C4): видалити нагадування з масиву назавжди — не спрацює
 * ані зараз, ані після snooze. На відміну від markFired/snoozeReminder це
 * СПРАВЖНЄ видалення (немає окремого поля cancelled/done — статус лише
 * через firedTs), бо скасоване нагадування не повинно лишати сліду. No-op,
 * якщо id невідомий (та сама ідемпотентна поведінка, що markFired).
 * @param {Reminder[]|null|undefined} reminders
 * @param {string} id
 */
export function cancelReminder(reminders, id) {
  return (Array.isArray(reminders) ? reminders : []).filter((r) => r.id !== id);
}

/**
 * Змінити текст і/або час активного нагадування (CRUD: updateReminder, той
 * самий текстовий пошук за описом, що cancelReminder — worker матчить, це
 * лише застосовує патч). `patch = {text?, whenMs?}` — обидва опційні. Зміна
 * часу скидає firedTs (як snooze — нагадування знову «на видачу»); зміна
 * ЛИШЕ тексту його не чіпає. No-op на невідомий id (та сама ідемпотентна
 * поведінка, що markFired/cancelReminder).
 * @param {Reminder[]|null|undefined} reminders
 * @param {string} id
 * @param {{ text?: string, whenMs?: number }} [patch]
 */
export function updateReminder(reminders, id, patch = {}) {
  return (Array.isArray(reminders) ? reminders : []).map((r) => {
    if (r.id !== id) return r;
    const next = { ...r };
    if (typeof patch.text === 'string' && patch.text) next.text = patch.text;
    if (typeof patch.whenMs === 'number') {
      next.whenMs = patch.whenMs;
      next.firedTs = null;
    }
    return next;
  });
}

/** Активні (ще не спрацювали) нагадування, за зростанням часу спрацювання —
 *  для /reminders (список+скасувати, §C4).
 *  @param {Reminder[]|null|undefined} reminders
 *  @returns {Reminder[]} */
export function listActive(reminders) {
  return (Array.isArray(reminders) ? reminders : [])
    .filter((r) => r && !r.firedTs)
    .sort((a, b) => a.whenMs - b.whenMs);
}

// Окремий простір callback_data від rm:<id> (snooze, worker.js) — 'rm:' бере
// ВЕСЬ залишок як id (без internal split), тож підпростір усередині нього
// зламав би snooze-парсинг. 'rc:' (reminder-cancel) — новий, не перетинається
// з v1:/rm:/pd:/rs:/ru:/ev: (жоден не є префіксом іншого). ⚠️ 'rd:' зайнятий
// roadmap-core.mjs (ROADMAP_CB_PREFIX) — «Виконано» нагадування нижче взяло
// 'rk:', щоб не зіткнутись.
// Сон (Блок «Сон») — кнопка «🌙 Ліг спати» на проактивному нагадуванні.
// Без id/аргументів (одна кнопка на все повідомлення) — сама наявність
// префікса вже достатня, дату/ніч рахує сервер (checkinDateKey), як і чек-ін.
export const SLEEP_START_CB_PREFIX = 'sl:';
export const buildSleepStartCallbackData = () => `${SLEEP_START_CB_PREFIX}1`;
export const isSleepStartCallback = (/** @type {unknown} */ data) =>
  typeof data === 'string' && data.startsWith(SLEEP_START_CB_PREFIX);

export const REMINDER_CANCEL_CB_PREFIX = 'rc:';

/** callback_data «скасувати нагадування id»; ≤64 байти (Telegram-ліміт), інакше null.
 *  @param {string} id
 *  @returns {string|null} */
export function buildReminderCancelCallbackData(id) {
  const s = `${REMINDER_CANCEL_CB_PREFIX}${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `rc:<id>` -> id; не той префікс чи порожній id -> null.
 *  @param {unknown} data */
export function parseReminderCancelCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(REMINDER_CANCEL_CB_PREFIX)) return null;
  const id = data.slice(REMINDER_CANCEL_CB_PREFIX.length);
  return id ? id : null;
}

// 'ru:' (reminder-update) — «✏️ Редагувати» на нагадуванні (CRUD, гібрид):
// НЕ мутує сама, лише передає в розмову (питання + синтетична репліка
// історії, worker.js). Окремий простір від rc:/rm: (жоден не префікс іншого).
export const REMINDER_EDIT_CB_PREFIX = 'ru:';

/** callback_data «редагувати нагадування id»; ≤64 байти, інакше null.
 *  @param {string} id
 *  @returns {string|null} */
export function buildReminderEditCallbackData(id) {
  const s = `${REMINDER_EDIT_CB_PREFIX}${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `ru:<id>` -> id; не той префікс чи порожній id -> null.
 *  @param {unknown} data */
export function parseReminderEditCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(REMINDER_EDIT_CB_PREFIX)) return null;
  const id = data.slice(REMINDER_EDIT_CB_PREFIX.length);
  return id ? id : null;
}

// 'rk:' (reminder-kept/done) — «✅ Виконано» на спрацьованому нагадуванні
// (фідбек власника: крім snooze потрібна кнопка завершення). Окремий простір
// від rc:/ru:/rs:/rm: — і від 'rd:' (roadmap-core.mjs), з яким інакше збігся б.
export const REMINDER_DONE_CB_PREFIX = 'rk:';

/** callback_data «нагадування виконано id»; ≤64 байти, інакше null.
 *  @param {string} id
 *  @returns {string|null} */
export function buildReminderDoneCallbackData(id) {
  const s = `${REMINDER_DONE_CB_PREFIX}${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `rk:<id>` -> id; не той префікс чи порожній id -> null.
 *  @param {unknown} data */
export function parseReminderDoneCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(REMINDER_DONE_CB_PREFIX)) return null;
  const id = data.slice(REMINDER_DONE_CB_PREFIX.length);
  return id ? id : null;
}

/** Текст ПІСЛЯ «✅ Виконано» — перепис повідомлення (editMessageText), клавіатура
 *  прибирається повністю (worker.js) — статус видно одразу, тапати вже нема куди.
 *  @param {string} text */
export function formatReminderDone(text) {
  return `✅ <b>Виконано</b>\n${escapeHtml(text)}`;
}

/** /reminders — список активних нагадувань (найближче спершу), Київський час.
 *  @param {Reminder[]|null|undefined} reminders */
export function formatRemindersListMessage(reminders) {
  const active = listActive(reminders);
  if (active.length === 0) {
    return '⏰ <b>Нагадування</b>\n\nАктивних нагадувань немає.';
  }
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  const lines = ['⏰ <b>Нагадування</b>', ''];
  active.forEach((r, i) => {
    // Повтор видно прямо в рядку (§3.1): інакше «щопонеділка о 9» у списку
    // не відрізнити від одноразового на найближчий понеділок.
    const repeat = r.repeat ? ` · ${escapeHtml(String(r.repeat))}` : '';
    lines.push(`${i + 1}. ${fmt.format(new Date(r.whenMs))} — ${escapeHtml(r.text)}${repeat}`);
  });
  return lines.join('\n');
}

/** Inline-клавіатура /reminders: по кнопці «❌ Скасувати N» на активне нагадування
 *  (у тому ж порядку, що й у formatRemindersListMessage — номер відповідає рядку).
 *  Порожньо, якщо активних немає — виклик не додає reply_markup у цьому випадку. */
// Сентинель для «скасувати всі» — reminder-id завжди crypto.randomUUID(), тож
// буквальне 'all' ніколи не збігнеться зі справжнім id (extra c, схвалено власником).
const CANCEL_ALL_ID = 'all';

/** @param {Reminder[]|null|undefined} reminders */
export function buildRemindersKeyboard(reminders) {
  const active = listActive(reminders);
  const rows = active
    .map((r, i) => {
      const cb = buildReminderCancelCallbackData(r.id);
      return cb ? [{ text: `❌ Скасувати ${i + 1}`, callback_data: cb }] : null;
    })
    .filter((row) => row !== null);
  // Пакетне скасування (extra c) — лише коли є сенс (2+ активних), одним тапом,
  // без окремого підтвердження (той самий мотив, що rc:/rm: — усі reminder-дії
  // тут уже прямі/без confirm).
  if (active.length >= 2) {
    const cb = buildReminderCancelCallbackData(CANCEL_ALL_ID);
    if (cb) rows.push([{ text: `🗑 Скасувати всі (${active.length})`, callback_data: cb }]);
  }
  return { inline_keyboard: rows };
}

/** Підтвердження одразу після створення нагадування ("/remind"-відповідь).
 *  @param {number} whenMs
 *  @param {string} remainder
 *  @param {number} [nowMs] */
export function formatReminderConfirm(whenMs, remainder, nowMs = Date.now()) {
  // Рік показуємо, лише коли він НЕ поточний (B1): «3 січня», сказане в липні,
  // котиться на наступний рік — і це має бути видно, інакше «03.01 о 10:00»
  // виглядало б як щось за пів року, а не за пів тижня (і навпаки).
  const sameYear = kyivYearOf(whenMs) === kyivYearOf(nowMs);
  const time = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    ...(sameYear ? {} : { year: 'numeric' }),
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(whenMs));
  return `✅ Нагадаю ${time}: ${escapeHtml(remainder)}`;
}

/** Текст самого нагадування, коли час настав.
 *  @param {string} text */
export function formatReminderFired(text) {
  return `⏰ <b>Нагадування</b>\n${escapeHtml(text)}`;
}

/* ══════════════════════════════════════════════════════════════════════
   LLM-фолбек: перепис нечіткої фрази в канонічний патерн (не рахує час сам).
   ══════════════════════════════════════════════════════════════════════ */

/** JSON Schema для LLM-хоста — валідується сервером, форсує строгий формат. */
export const LLM_REWRITE_SCHEMA = {
  type: 'object',
  properties: {
    rewritten: { type: 'string' },
    error: { type: 'string' },
  },
};

// Експортовано — agent-core.mjs (Блок P2b) переописує ТОЙ САМИЙ список у
// системному промпті асистента, щоб "when" у пропозиціях парсився цим самим
// parseReminderTime без розходження форматів.
export const CANONICAL_EXAMPLES = [
  'через 20 хвилин ЗАВДАННЯ',
  'через 2 години ЗАВДАННЯ',
  'завтра о 9:30 ЗАВДАННЯ',
  'сьогодні о 18:00 ЗАВДАННЯ',
  'о 15:00 ЗАВДАННЯ',
  // B1: календарна дата — з часом і без (без часу код сам ставить 10:00). Без
  // цього прикладу LLM-рерайт не мав куди переписати «24 липня» і фраза глухо
  // впиралась у «не зрозумів час».
  '24 липня о 18:30 ЗАВДАННЯ',
  '24 липня ЗАВДАННЯ',
].join(', ');

/**
 * Системний промпт для LLM-хоста: переписати нечітку фразу в один із
 * канонічних патернів (з поточним київським часом як контекст — потрібен
 * лише для відносних понять на кшталт «післязавтра»/«в обід», НЕ для того,
 * щоб LLM сама рахувала UTC — це робить parseReminderTime вдруге, надійно).
 * @param {number} nowMs
 */
export function buildLlmRewriteSystemPrompt(nowMs) {
  const kyivNow = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(nowMs));
  return (
    `Ти переписуєш нечіткі українські фрази-нагадування в один із чітких форматів: ` +
    `${CANONICAL_EXAMPLES}. Заміни "ЗАВДАННЯ" на суть прохання, збережену з фрази ` +
    `користувача. Час — ЗАВЖДИ у 24-годинному форматі: якщо у фразі є частина доби ` +
    `("вранці"/"вдень"/"ввечері"/"вночі") разом із годиною до 12 — переведи в 24-` +
    `годинний формат і ПРИБЕРИ слово частини доби з переписаного рядка (напр. ` +
    `"ввечері о 8" -> "о 20:00", "вранці о 7" -> "о 7:00"). Поточний момент у Києві: ` +
    `${kyivNow}. Якщо не можеш однозначно визначити час — виведи {"error":"unclear"}. ` +
    `Відповідай ЛИШЕ JSON-обʼєктом за схемою: {"rewritten":"..."} або {"error":"unclear"}. ` +
    `Без пояснень, без markdown.`
  );
}

// Слова частини доби, які rewrite МАВ усунути (перевести в конкретну годину) —
// якщо лишились у переписаному рядку, перепис ненадійний (модель не завжди
// ідеально виконує інструкцію) — краще чесно відмовити, ніж мовчки поставити
// нагадування на хибний час (перевірено на реальному збої: "ввечері о 8" ->
// модель лишила буквальне "о 8:00" замість "о 20:00", "ввечері" протекло в текст).
const AMBIGUOUS_TIME_WORDS = /вранці|зранку|вдень|ввечері|вночі|опівдні|опівночі|в обід/i;

/** Чи rewrite ненадійний — досі містить нерозв'язане слово частини доби.
 *  @param {string} rewritten */
export function isAmbiguousRewrite(rewritten) {
  return AMBIGUOUS_TIME_WORDS.test(rewritten);
}

/** Витягнути валідний rewritten-рядок зі structured-відповіді хоста; інакше null.
 *  @param {KvBlob|null|undefined} structured
 *  @returns {string|null} */
export function extractLlmRewrite(structured) {
  const rewritten = structured?.rewritten;
  return typeof rewritten === 'string' && rewritten.trim() ? rewritten.trim() : null;
}
