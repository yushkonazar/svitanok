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

const MINUTE = 60_000;
const HOUR = 3_600_000;
export const SNOOZE_MINUTES = 10;

/** UTC-офсет Києва (хв) у момент nowMs — DST-aware через Intl shortOffset. */
function kyivOffsetMinutes(nowMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Kyiv',
    timeZoneName: 'shortOffset',
  }).formatToParts(new Date(nowMs));
  const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+2';
  const m = tz.match(/GMT([+-])(\d+)(?::(\d+))?/);
  if (!m) return 120;
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] || 0));
}

/** Київська дата "YYYY-MM-DD" у момент nowMs. */
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
function stripTrigger(text) {
  return text.replace(/^\s*нагад(ай|ати|уй)(\s+мені)?(\s+про)?\s*/i, '');
}

function cleanRemainder(text, matched) {
  // matched — рядок або масив рядків (дата + час стрипаються обидва).
  const parts = Array.isArray(matched) ? matched.filter(Boolean) : [matched];
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

/** Київський рік у момент nowMs (для «24 липня» без року). */
function kyivYearOf(nowMs) {
  return Number(kyivDateKeyOf(nowMs).slice(0, 4));
}

/** Витягти час «о HH[:.]MM» будь-де в тексті -> {hh,mm,matched}|null (валідний час). */
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
 */
export function parseReminderTime(rawText, nowMs = Date.now()) {
  if (typeof rawText !== 'string') return null;
  const text = stripTrigger(rawText.trim());
  if (!text) return null;

  const rel = text.match(/через\s+(\d+)\s*(хвилин[иу]?|хв\.?|годин[иу]?|год\.?)/i);
  if (rel) {
    const n = Number(rel[1]);
    if (n > 0) {
      const isHours = /^год/i.test(rel[2]);
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
    const isTomorrow = /завтра/i.test(dayWord[1]);
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
    const month = named ? MONTH_TO_NUM[dm[2].toLowerCase()] : Number(dm[2]);
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
      const daysInMonth = (year) => new Date(Date.UTC(year, month, 0)).getUTCDate();
      const build = (year) =>
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

/** Додати нагадування (id/nowMs — від виклику, щоб функція лишалась чистою). */
export function addReminder(reminders, { id, text, whenMs, nowMs }) {
  const list = Array.isArray(reminders) ? reminders : [];
  return [...list, { id, text, whenMs, createdMs: nowMs, firedTs: null }];
}

/** Нагадування «на видачу»: час настав і ще не спрацьовувало. */
export function dueReminders(reminders, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).filter(
    (r) => r && typeof r.whenMs === 'number' && r.whenMs <= nowMs && !r.firedTs,
  );
}

/** Позначити спрацьованим (ідемпотентно — уже виставлений firedTs не чіпаємо). */
export function markFired(reminders, id, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).map((r) =>
    r.id === id ? { ...r, firedTs: r.firedTs ?? nowMs } : r,
  );
}

/** Відкласти на SNOOZE_MINUTES: новий whenMs, скинути firedTs (спрацює знову). */
export function snoozeReminder(reminders, id, nowMs) {
  return (Array.isArray(reminders) ? reminders : []).map((r) =>
    r.id === id ? { ...r, whenMs: nowMs + SNOOZE_MINUTES * MINUTE, firedTs: null } : r,
  );
}

/**
 * Скасувати (§C4): видалити нагадування з масиву назавжди — не спрацює
 * ані зараз, ані після snooze. На відміну від markFired/snoozeReminder це
 * СПРАВЖНЄ видалення (немає окремого поля cancelled/done — статус лише
 * через firedTs), бо скасоване нагадування не повинно лишати сліду. No-op,
 * якщо id невідомий (та сама ідемпотентна поведінка, що markFired).
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
 *  для /reminders (список+скасувати, §C4). */
export function listActive(reminders) {
  return (Array.isArray(reminders) ? reminders : [])
    .filter((r) => r && !r.firedTs)
    .sort((a, b) => a.whenMs - b.whenMs);
}

// Окремий простір callback_data від rm:<id> (snooze, worker.js) — 'rm:' бере
// ВЕСЬ залишок як id (без internal split), тож підпростір усередині нього
// зламав би snooze-парсинг. 'rc:' (reminder-cancel) — новий, не перетинається
// з v1:/rm:/pd:/rd: (жоден не є префіксом іншого).
export const REMINDER_CANCEL_CB_PREFIX = 'rc:';

/** callback_data «скасувати нагадування id»; ≤64 байти (Telegram-ліміт), інакше null. */
export function buildReminderCancelCallbackData(id) {
  const s = `${REMINDER_CANCEL_CB_PREFIX}${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `rc:<id>` -> id; не той префікс чи порожній id -> null. */
export function parseReminderCancelCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(REMINDER_CANCEL_CB_PREFIX)) return null;
  const id = data.slice(REMINDER_CANCEL_CB_PREFIX.length);
  return id ? id : null;
}

// 'ru:' (reminder-update) — «✏️ Редагувати» на нагадуванні (CRUD, гібрид):
// НЕ мутує сама, лише передає в розмову (питання + синтетична репліка
// історії, worker.js). Окремий простір від rc:/rm: (жоден не префікс іншого).
export const REMINDER_EDIT_CB_PREFIX = 'ru:';

/** callback_data «редагувати нагадування id»; ≤64 байти, інакше null. */
export function buildReminderEditCallbackData(id) {
  const s = `${REMINDER_EDIT_CB_PREFIX}${id}`;
  return new TextEncoder().encode(s).length <= 64 ? s : null;
}

/** Розібрати `ru:<id>` -> id; не той префікс чи порожній id -> null. */
export function parseReminderEditCallbackData(data) {
  if (typeof data !== 'string' || !data.startsWith(REMINDER_EDIT_CB_PREFIX)) return null;
  const id = data.slice(REMINDER_EDIT_CB_PREFIX.length);
  return id ? id : null;
}

/** /reminders — список активних нагадувань (найближче спершу), Київський час. */
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
    lines.push(`${i + 1}. ${fmt.format(new Date(r.whenMs))} — ${escapeHtml(r.text)}`);
  });
  return lines.join('\n');
}

/** Inline-клавіатура /reminders: по кнопці «❌ Скасувати N» на активне нагадування
 *  (у тому ж порядку, що й у formatRemindersListMessage — номер відповідає рядку).
 *  Порожньо, якщо активних немає — виклик не додає reply_markup у цьому випадку. */
export function buildRemindersKeyboard(reminders) {
  const active = listActive(reminders);
  return {
    inline_keyboard: active
      .map((r, i) => {
        const cb = buildReminderCancelCallbackData(r.id);
        return cb ? [{ text: `❌ Скасувати ${i + 1}`, callback_data: cb }] : null;
      })
      .filter((row) => row !== null),
  };
}

/** Підтвердження одразу після створення нагадування ("/remind"-відповідь). */
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

/** Текст самого нагадування, коли час настав. */
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

/** Чи rewrite ненадійний — досі містить нерозв'язане слово частини доби. */
export function isAmbiguousRewrite(rewritten) {
  return AMBIGUOUS_TIME_WORDS.test(rewritten);
}

/** Витягнути валідний rewritten-рядок зі structured-відповіді хоста; інакше null. */
export function extractLlmRewrite(structured) {
  const rewritten = structured?.rewritten;
  return typeof rewritten === 'string' && rewritten.trim() ? rewritten.trim() : null;
}
