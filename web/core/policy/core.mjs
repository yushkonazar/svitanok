// Чиста логіка policy (01-architecture §4.3): рівень дії за таблицею,
// ескалація taint-ом, TTL пропозицій, вікно undo, кнопки у форматі 07 §9.
// Жодних D1/мережі - таблиця рівнів × taint тестується вичерпно.

/**
 * Базові рівні дій - зведення таблиці 01 §4.3 і переліку kind-ів
 * proposals.create з 07 §4. Виконавці багатьох kind-ів прийдуть з етапами
 * 2-7 - РІВЕНЬ їхній вже зафіксований тут, щоб жоден новий інструмент не
 * зʼявився «тихо T0» без рядка в цій таблиці.
 * @type {Record<string, 'T0' | 'T1' | 'T2'>}
 */
export const ACTION_LEVELS = {
  // T0 - виконати одразу, «Записав … ↩» (undo 10 хв)
  'facts.set': 'T0',
  record: 'T0',
  'reminders.create': 'T0',
  'reminders.update': 'T0',
  'reminders.cancel': 'T0',
  'ideas.create': 'T0',
  'ideas.update': 'T0',
  'ideas.analyze': 'T0',
  'wishes.create': 'T0',
  'wishes.update': 'T0',
  'collections.create': 'T0',
  'collections.update': 'T0',
  'records.create': 'T0',
  'records.update': 'T0',
  'chain.start': 'T0',
  // План дня v2 (07 §4, ADR-035): усі T0, «↩» для accept/update.
  'plan.intent': 'T0',
  'plan.draft': 'T0',
  'plan.accept': 'T0',
  'plan.update': 'T0',
  'plan.review': 'T0',
  // T1 - одне ✅/❌, TTL 30 хв
  'calendar.event': 'T1',
  'calendar.update': 'T1',
  'calendar.delete': 'T1',
  invite: 'T1',
  'drive.write': 'T1',
  'tasks.create': 'T1',
  settings: 'T1',
  contact: 'T1',
  'collection.export': 'T1',
  'records.delete': 'T1',
  'ideas.delete': 'T1',
  'wishes.delete': 'T1',
  'gemini.image': 'T1',
  // T2 - ✅ + слово, TTL 10 хв
  forget: 'T2',
  'data.export': 'T2',
  'gemini.video': 'T2',
};

/** TTL пропозиції за рівнем (01 §4.3). */
export const PROPOSAL_TTL_MS = { T1: 30 * 60_000, T2: 10 * 60_000 };

/** Вікно «↩» після T0 (01 §4.3). */
export const UNDO_WINDOW_MS = 10 * 60_000;

/**
 * Скільки живе taint після ОСТАННЬОГО зовнішнього читання (рішення власника
 * на прийманні етапу 3, 05.09.2026: «до /new або 24 год тиші» з 01 §4.2
 * робило кожен запис у треді пропозицією на весь день). Інʼєкція з листа
 * діє в тому ж прогоні або одразу після - півгодини її накриває; далі T0
 * знову T0 з «↩». `sessions.tainted` зберігає epoch-ms позначки (0 = чисто).
 */
export const TAINT_TTL_MS = 30 * 60_000;

/**
 * Чи taint ще діє. marker - значення `sessions.tainted`: 0 = чисто; epoch-ms
 * останнього зовнішнього читання; легасі `1` (до TTL) читається як давно
 * прострочене.
 * @param {unknown} marker @param {number} nowMs
 */
export function isTaintActive(marker, nowMs) {
  const at = Number(marker);
  if (!Number.isFinite(at) || at <= 0) return false;
  return nowMs - at < TAINT_TTL_MS;
}

/** Слова підтвердження T2: короткі, українські, без омографів з ✅-кнопками. */
export const T2_WORDS = ['ВИКОНАТИ', 'ПІДТВЕРДЖУЮ', 'ТАК-ЗРОБИ', 'ЗГОДЕН'];

/**
 * Рівень дії з урахуванням taint: усе T0 у заплямованій сесії стає T1
 * (01 §4.2 «подвійний барʼєр», §4.3 «усе T0 у tainted-сесії»). T1/T2 вище
 * не ескалюють - вони і так проходять через власника.
 * @param {string} kind
 * @param {boolean} tainted
 * @returns {{ level: 'T0' | 'T1' | 'T2' } | { error: string }}
 */
export function decideLevel(kind, tainted) {
  const base = ACTION_LEVELS[kind];
  // Невідомий kind - НЕ дефолт-рівень, а відмова: дія без рядка в таблиці
  // не має права існувати (та сама логіка, що «помилка видима»).
  if (!base) {
    // Перелік у самій помилці: інакше модель перебирає здогади («calendar_event»,
    // «calendar.create», «calendar_add»), витрачає кроки і лишає власника без
    // пропозиції (приймання 01.09).
    return {
      error: `невідомий kind дії "${kind}"; дозволені: ${Object.keys(ACTION_LEVELS).join(', ')}`,
    };
  }
  if (base === 'T0' && tainted) return { level: 'T1' };
  return { level: base };
}

/**
 * Слово для T2 - криптовипадковий вибір (Math.random заборонений у DO-шляхах,
 * а передбачуване слово знецінює другий фактор).
 */
export function pickT2Word() {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return /** @type {string} */ (T2_WORDS[(buf[0] ?? 0) % T2_WORDS.length]);
}

/**
 * Кнопки пропозиції у форматі 07 §9 (`p:<id>:<choice>`, ≤ 64 байт).
 * @param {string} id
 */
export function proposalButtons(id) {
  return [
    [
      { text: '✅ Так', callback_data: `p:${id}:ok` },
      { text: '❌ Ні', callback_data: `p:${id}:no` },
    ],
  ];
}

/** Кнопка «↩» під T0-підтвердженням. @param {string} id */
export function undoButton(id) {
  return [[{ text: '↩ Скасувати', callback_data: `u:${id}` }]];
}

/**
 * Розбір callback-даних policy: `p:<id>:ok|no` та `u:<id>`.
 * @param {string} data
 * @returns {{ kind: 'proposal', id: string, choice: 'ok' | 'no' }
 *   | { kind: 'undo', id: string } | null}
 */
export function parsePolicyCallback(data) {
  const p = data.match(/^p:([A-Za-z0-9-]{1,40}):(ok|no)$/);
  if (p) {
    return {
      kind: 'proposal',
      id: /** @type {string} */ (p[1]),
      choice: /** @type {'ok' | 'no'} */ (p[2]),
    };
  }
  const u = data.match(/^u:([A-Za-z0-9-]{1,40})$/);
  if (u) return { kind: 'undo', id: /** @type {string} */ (u[1]) };
  return null;
}
