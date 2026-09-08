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
  'wishes.import': 'T0',
  'collections.create': 'T0',
  'collections.update': 'T0',
  'records.create': 'T0',
  'records.update': 'T0',
  'chain.start': 'T0',
  'chain.cancel': 'T0',
  // Гроші (етап 6 PR-2, 07 §4): правило категорії й облік підписок - записи в
  // ВЛАСНУ базу, тож T0 з «↩», як facts.set.
  'finance.rule': 'T0',
  'subscriptions.update': 'T0',
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
 * діє в тому ж прогоні або одразу після - десять хвилин її накривають (30 хв
 * власник 05.09 назвав задовгими); далі T0 знову T0 з «↩».
 * `sessions.tainted` зберігає epoch-ms позначки (0 = чисто).
 */
export const TAINT_TTL_MS = 10 * 60_000;

/**
 * T0-дії, які taint НЕ ескалює: читання/перерахунок власного плану без
 * зовнішнього ефекту (приймання 05.09, B3: «що там з планом» під taint
 * просило ✅, а результат після ✅ не показувався). plan.review - лише БЕЗ
 * carry: з carry він переносить пункти (запис без «↩»), і інʼєкція з листа
 * «перенеси все на завтра» мусить упертись у ✅ (security-ревʼю 05.09).
 * @param {string} kind @param {Record<string, unknown> | undefined} payload
 */
export function isTaintExempt(kind, payload) {
  if (kind === 'plan.draft') return true;
  if (kind === 'plan.review') {
    const carry = payload?.carry;
    return !(Array.isArray(carry) && carry.length > 0);
  }
  return false;
}

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
 * @param {Record<string, unknown>} [payload] - для винятків, що залежать від аргументів
 * @returns {{ level: 'T0' | 'T1' | 'T2' } | { error: string }}
 */
export function decideLevel(kind, tainted, payload = undefined) {
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
  if (base === 'T0' && tainted && !isTaintExempt(kind, payload)) return { level: 'T1' };
  return { level: base };
}

/**
 * Gemini (ADR-034): у чужий сервіс їде РІВНО prompt власника. Тому payload
 * звужується до білого списку полів - не «відкидаємо відомі id транзакцій і
 * чатів», а «пропускаємо лише перелічене». Різниця принципова: чорний список
 * доводиться доповнювати щоразу, коли зʼявляється нове сховище, і саме той
 * раз його забудуть.
 * @type {Record<string, string[]>}
 */
export const GEMINI_ALLOWED_FIELDS = {
  'gemini.image': ['prompt', 'aspect'],
  'gemini.video': ['prompt', 'seconds', 'model'],
};

/** Стеля prompt-а: опис картинки, а не переказ листа. */
export const GEMINI_PROMPT_MAX = 2_000;

/**
 * Звузити payload gemini.* до дозволених полів. Зайве поле - ПОМИЛКА, а не
 * тихе відкидання: інакше модель «поклала id транзакції» і не дізналась би,
 * що воно не поїхало, а власник не дізнався б, що вона намагалась.
 * @param {string} kind @param {Record<string, unknown> | undefined} payload
 * @returns {{ payload: Record<string, unknown> } | { error: string }}
 */
export function sanitizeGeminiPayload(kind, payload) {
  const allowed = GEMINI_ALLOWED_FIELDS[kind];
  if (!allowed) return { payload: payload ?? {} };
  const src = payload && typeof payload === 'object' ? payload : {};
  const extra = Object.keys(src).filter((k) => !allowed.includes(k));
  if (extra.length) {
    return {
      error: `${kind}: у Gemini йде лише prompt власника (ADR-034); зайві поля: ${extra.join(', ')}. Дозволені: ${allowed.join(', ')}`,
    };
  }
  const prompt = String(src.prompt ?? '').trim();
  if (!prompt) return { error: `${kind}: потрібен prompt` };
  if (prompt.length > GEMINI_PROMPT_MAX) {
    return { error: `${kind}: prompt довший за ${GEMINI_PROMPT_MAX} символів` };
  }
  /** @type {Record<string, unknown>} */
  const out = { prompt };
  for (const key of allowed) {
    if (key !== 'prompt' && src[key] !== undefined) out[key] = src[key];
  }
  return { payload: out };
}

/**
 * Рядок, який ЯДРО дописує під пропозицією перед відправкою (S-8-5/S-8-6:
 * «ціна показана ДО витрати»). Пишеться тут, а не моделлю: ціну, від якої
 * залежить рішення власника, не можна довіряти тому, хто просить її схвалити.
 * Порожній рядок - додавати нічого.
 * @param {string} kind @param {Record<string, unknown> | null | undefined} payload
 * @param {{ imageUsd: number, videoUsd: (seconds: number, model: 'veo' | 'lite') => number,
 *   defaultSeconds: number }} prices
 */
export function proposalNotice(kind, payload, prices) {
  if (kind === 'gemini.image') {
    return `💵 Генерація зображення ≈ $${prices.imageUsd.toFixed(2)}.${promptLine(payload)}`;
  }
  if (kind === 'gemini.video') {
    const o = payload && typeof payload === 'object' ? payload : {};
    const seconds = Number.isFinite(Number(o.seconds))
      ? Math.round(Number(o.seconds))
      : prices.defaultSeconds;
    const model = o.model === 'lite' ? 'lite' : 'veo';
    const cost = prices.videoUsd(seconds, model);
    const alt =
      model === 'veo'
        ? ` Дешевше - Lite ≈ $${prices.videoUsd(seconds, 'lite').toFixed(2)} або Flow у застосунку Gemini вручну.`
        : '';
    return `💵 Відео ${seconds} с ≈ $${cost.toFixed(2)}.${alt}${promptLine(payload)}`;
  }
  return '';
}

/**
 * Сам prompt під ціною (security-ревʼю етапу 7): ✅ має даватись за ТЕ, що
 * поїде в чужий сервіс, а не за напис моделі поруч. Керівні символи геть -
 * рядок пише модель, і «
[Ядро] …» у ньому підробив би повідомлення.
 * @param {Record<string, unknown> | null | undefined} payload
 */
function promptLine(payload) {
  const raw = payload && typeof payload === 'object' ? payload.prompt : null;
  const text = String(raw ?? '')
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .trim()
    .slice(0, 300);
  return text ? ['', `Запит: «${text}»`].join('\n') : '';
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
