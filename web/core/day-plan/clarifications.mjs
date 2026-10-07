// Deterministic safeguards around worker-extracted day-plan clock fields.
import { hhmmToMin, minToHhmm } from './slots.mjs';

const CLOCK = '(\\d{1,2}(?::\\d{2})?)';
const RANGE = `${CLOCK}\\s*[–—-]\\s*${CLOCK}`;
const WORK_START = `(?:почина\\p{L}*|почати|початок(?:\\s+роботи)?|працю\\p{L}*\\s+з)\\s*(?:роботу\\s*)?(?:о|з)?\\s*`;
const WORK_END = `(?:закінч\\p{L}*|заверш\\p{L}*)\\s*(?:роботу\\s*)?(?:о|до)?\\s*`;

/** @param {string} raw */
function clock(raw) {
  const value = raw.includes(':') ? raw : `${raw.padStart(2, '0')}:00`;
  return hhmmToMin(value) == null ? null : minToHhmm(Number(hhmmToMin(value)));
}

/**
 * Never silently choose one side of an explicitly supplied range.
 * Bare afternoon work-end hours are offered relative to the known start;
 * the owner still chooses the exact time, or writes a different one.
 * @param {any[]} items @param {string} text @param {any[]} questions @param {string | null} [learnedStart]
 */
export function requireClockRangeQuestions(items, text, questions, learnedStart = null) {
  const work = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.role === 'work' || /робот|прац/iu.test(item.title));
  const originalStarts = new Map(work.map(({ item, index }) => [index, item.hard_at]));
  const ranges = [
    {
      match: text.match(new RegExp(`прокин\\p{L}*\\s*(?:о|близько)?\\s*${RANGE}`, 'iu')),
      entry: items
        .map((item, index) => ({ item, index }))
        .find(({ item }) => item.kind === 'moment' && /прокин|пробуд/iu.test(item.title)),
      field: 'hard_at',
      label: 'О котрій запланувати пробудження?',
    },
    {
      match: text.match(new RegExp(`${WORK_START}${RANGE}`, 'iu')),
      entry: work[0],
      field: 'hard_at',
      label: 'О котрій починаєш роботу?',
    },
    {
      match: text.match(
        new RegExp(
          `(?:${WORK_END}|(?:працю\\p{L}*|робот\\p{L}*)[^.;,\\n]{0,50}?до\\s*)${RANGE}`,
          'iu',
        ),
      ),
      entry: work.at(-1),
      field: 'hard_end',
      label: 'До котрої запланувати роботу?',
    },
  ];
  for (const { match, entry, field, label } of ranges) {
    if (!match?.[1] || !match[2] || !entry) continue;
    let options = [clock(match[1]), clock(match[2])];
    if (options.some((option) => option == null)) continue;
    if (field === 'hard_end' && !match[1].includes(':') && !match[2].includes(':')) {
      const lower = hhmmToMin(originalStarts.get(entry.index));
      if (
        lower != null &&
        options.every(
          (option) => Number(hhmmToMin(option)) < lower && Number(hhmmToMin(option)) < 720,
        ) &&
        !/ночі|ніч/iu.test(match[0])
      )
        options = options.map((option) => minToHhmm(Number(hhmmToMin(option)) + 720));
      else if (
        lower == null &&
        options.every((option) => Number(hhmmToMin(option)) < 720) &&
        !/ночі|ніч/iu.test(match[0])
      )
        options = [
          ...options,
          ...options.map((option) => minToHhmm(Number(hhmmToMin(option)) + 720)),
        ];
    }
    entry.item[field] = null;
    entry.item.flexible = true;
    const question = { item: entry.index, field, q: label, options };
    const existing = questions.findIndex((q) => q.item === entry.index && q.field === field);
    if (existing >= 0) questions[existing] = question;
    else questions.push(question);
    if (
      field === 'hard_end' &&
      work.length === 1 &&
      !learnedStart &&
      !new RegExp(`(?:${WORK_START}|робот\\p{L}*\\s+з\\s*)${CLOCK}`, 'iu').test(text) &&
      !questions.some((q) => q.item === entry.index && q.field === 'hard_at')
    ) {
      entry.item.hard_at = null;
      questions.push({
        item: entry.index,
        field: 'hard_at',
        q: 'О котрій починаєш роботу?',
        options: ['09:00', '10:00', 'не знаю'],
      });
    }
  }
  return questions;
}

/** Apply only explicitly named, exact times to a single unambiguous work item.
 * @param {any[]} items @param {string} text
 * @returns {Set<string>} keys index:field that were answered
 */
export function applyNamedWorkClocks(items, text) {
  const work = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.role === 'work' || /робот|прац/iu.test(item.title));
  const answered = new Set();
  if (work.length !== 1) return answered;
  const entry = work[0];
  if (!entry) return answered;
  const fields = /** @type {[string, string][]} */ ([
    [WORK_START, 'hard_at'],
    [WORK_END, 'hard_end'],
  ]);
  for (const [prefix, field] of fields) {
    const match = text.match(new RegExp(`${prefix}${CLOCK}(?![\\d:]|\\s*[–—-]\\s*\\d)`, 'iu'));
    const value = match?.[1] ? clock(match[1]) : null;
    if (value) {
      entry.item[field] = value;
      answered.add(`${entry.index}:${field}`);
    }
  }
  if (answered.size && entry.item.hard_at && entry.item.hard_end) entry.item.flexible = false;
  return answered;
}

/** Reject ranges instead of accepting the first HH:MM from them. @param {string} text */
export function exactAnswerClock(text) {
  if (new RegExp(RANGE, 'u').test(text)) return null;
  const clocks = text.match(/\d{1,2}:\d{2}/g);
  if (clocks?.length === 1) return clock(clocks[0]);
  return /^\s*(?:(?:о|з|до)\s*)?\d{1,2}\s*$/iu.test(text)
    ? clock(text.trim().replace(/^(?:о|з|до)\s*/iu, ''))
    : null;
}

/** Only explicit endpoints; never derive private location or assume transport.
 * @param {string} text
 */
export function plannedRoute(text) {
  const match = text.match(
    /(?:виїхати|виїзд|їхати|дорога)[^.;,\n]{0,40}?(?:зі|із|з)\s+([^.;,\n]{1,100}?)\s+до\s+([^.;,\n]{1,100})(?=$|[.;,\n])/iu,
  );
  if (!match?.[1] || !match[2]) return null;
  const mode = /авто|машин|автомобіл/iu.test(text)
    ? 'car'
    : /пішки/iu.test(text)
      ? 'walk'
      : /поїзд|автобус|транспорт/iu.test(text)
        ? 'transit'
        : null;
  return { from: match[1].trim(), to: match[2].trim(), mode };
}

/** @param {string} text */
export function requestsRouteCheck(text) {
  return /(?:глянь|перевір|знайди|подиви|порахуй|розрахуй|дізнай)[\s\S]{0,80}(?:сам|дорог|маршрут|їхат)|(?:скільки|час)[\s\S]{0,60}їхат[\s\S]{0,40}(?:сам|глянь|перевір)/iu.test(
    text,
  );
}
