// Чиста логіка policy (01-architecture §4.3): рівень дії за таблицею,
// ескалація taint-ом, TTL пропозицій, вікно undo, кнопки у форматі 07 §9.
// Жодних D1/мережі - таблиця рівнів × taint тестується вичерпно.

import { parseRecurrence } from '../reminders/recurrence.mjs';

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
  // ⚠️ ПЕРЕЇХАЛИ З T1 (реліз 08.09, скарга 6: «деякі стандартні дії постійно
  // вимагають підтвердження»). Правило, за яким їх пересунуто: ✅ потрібне
  // лише там, де дія (а) незворотна, (б) видима ІНШИМ людям або (в) коштує
  // грошей. Задача у власному списку, нотатка у власній теці й вивантаження
  // власної колекції в його ж чат - жодне з трьох, і «↩» знімає їх за 10 хв.
  'tasks.create': 'T0',
  'drive.write': 'T0',
  // Експорт нікуди не виходить, окрім чату власника, і відкочувати в ньому
  // нічого - тому T0 без «↩».
  'collection.export': 'T0',
  // Подія В КАЛЕНДАРІ - T0 з «↩», але З ГОСТЯМИ вона стає листом іншій
  // людині й лишається T1: рівень вирішує decideLevel за payload.
  'calendar.event': 'T0',
  // T1 - одне ✅/❌, TTL 30 хв
  'calendar.update': 'T1',
  'calendar.delete': 'T1',
  invite: 'T1',
  settings: 'T1',
  contact: 'T1',
  'records.delete': 'T1',
  'ideas.delete': 'T1',
  'wishes.delete': 'T1',
  'gemini.image': 'T1',
  // Збір корпусу свого голосу власник дає СВІДОМО (07 §1 style_corpus), а не
  // фоном: це його тексти, і рішення про них - його.
  'style.collect': 'T1',
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
 * Дії, ЯКІ TAINT ЕСКАЛЮЄ, - білий список, а не чорний (реліз 08.09).
 *
 * ⚠️ ЩО ЗМІНИЛОСЬ І ЧОМУ. Доти taint підіймав до T1 БУДЬ-ЯКИЙ T0: після
 * читання пошти власник мусив тиснути ✅ навіть на «запиши ідею». Ціна
 * захисту виявилась завищеною (скарга 7 прогону 08.09). Але зняти taint
 * зовсім не можна: інʼєкція приходить із легітимного домену, а шкідливе - у
 * СЛОВАХ листа, тож «глибша перевірка джерела» від неї не рятує.
 *
 * Тому барʼєр звужено до того, де ціна помилки не своя: усе, що ВИХОДИТЬ
 * НАЗОВНІ - у чужі сервіси, чужі списки, чужі очі - або коштує грошей.
 * Інʼєкція, що записала власнику зайве нагадування, - прикро й відкочується
 * одним тапом; інʼєкція, що створила подію в його календарі чи виклала файл
 * у Drive, - ні.
 *
 * Локальне, яке не створює довготривале джерело істини, лишається T0 з «↩».
 * Facts — виняток: модельний висновок із пошти/web не має непомітно ставати
 * персональною пам'яттю, тому `facts.set` під taint потребує ✅.
 */
export const TAINT_ESCALATES = Object.freeze([
  // Факт переживає поточний контекст і впливає на наступні рішення. Зовнішній
  // текст може лише запропонувати його, але не записати автоматично.
  'facts.set',
  'calendar.event',
  'tasks.create',
  'drive.write',
  'collection.export',
  // ⚠️ Не «назовні», але й не відкотне: `plan.review` з carry переносить
  // пункти плану ПАЧКОЮ і «↩» не має. Інʼєкція «перенеси все на завтра» з
  // листа мусить упертись у ✅ (security-ревʼю 05.09) - те саме правило
  // «незворотне потребує підтвердження», лише без слова «назовні». БЕЗ carry
  // це читання власного плану, і воно ескалації не потребує.
  'plan.review',
  // ⚠️ `plan.accept` з calendar=true СТВОРЮЄ події в календарі (від 08.09 це
  // T0), тобто виходить назовні тим самим шляхом, що `calendar.event`. Без
  // цього рядка лист «постав блоки й закинь у календар» клав би чужі назви в
  // календар власника без жодного ✅ (security-ревʼю релізу). Без calendar -
  // це власний план дня, і барʼєр там зайвий.
  'plan.accept',
  // Бажання-покупка з url стартує щоденний обхід тієї адреси Дослідником
  // (WebFetch): інʼєкція так робить собі маячок. Без url це просто запис.
  'wishes.create',
  // Аналіз ідеї по коду - 40-хвилинний прогін GitHub Actions, тобто гроші.
  'ideas.analyze',
  // Ланцюги виходять назовні: столик шле контакт і місце, поїздка - чеклісти,
  // ціна - щоденний обхід чужої сторінки.
  'chain.start',
  // ⚠️ ПОВТОРЮВАНЕ нагадування - не «зворотне одним тапом» (security-ревʼю
  // §3.1). Вікно «↩» - 10 хв, а перша поява буває й через тиждень: інʼєкція
  // «нагадуй щодня о 3:00 <текст із листа>» пережила б і кнопку, і taint, і
  // щодня повертала б чужий текст у довірений канал. Одноразове нагадування
  // лишається T0 - його ↩ справді відкочує.
  'reminders.create',
  // ⚠️ І update ТЕЖ (ревʼю релізу): він уміє задати повтор тією самою фразою,
  // тож без цього рядка барʼєр обходився двома кроками - створити одноразове
  // (T0, повтору немає) і одразу «оновити» його на «щодня о 3:00» (теж T0).
  'reminders.update',
]);

/**
 * Чи ескалює taint цю дію.
 * @param {string} kind @param {Record<string, unknown> | undefined} payload
 */
export function taintEscalates(kind, payload) {
  if (!TAINT_ESCALATES.includes(kind)) return false;
  if (kind === 'plan.review') {
    const carry = payload?.carry;
    return Array.isArray(carry) && carry.length > 0;
  }
  // План дня сам собою локальний; назовні його виводить лише calendar=true.
  if (kind === 'plan.accept') return payload?.calendar === true;
  // Бажання без посилання нікуди не ходить.
  if (kind === 'wishes.create') return typeof payload?.url === 'string' && payload.url !== '';
  // Нагадування собі одноразове - T0; барʼєр ставить саме ПОВТОР.
  if (kind === 'reminders.create' || kind === 'reminders.update') {
    return parseRecurrence(payload?.when) != null;
  }
  return true;
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
 * Довжина випадкового суфікса слова T2 («ВИКОНАТИ-7K3»).
 *
 * ⚠️ ЗАРАДИ ЧОГО ВІН ІСНУЄ. Слів чотири, і доти слово адресувало «останню
 * відкриту T2 з таким словом у треді»: модель могла створити кілька
 * пропозицій поспіль, показати власнику невинну, а під його напис підставити
 * іншу - аж до `forget target=all`. Суфікс робить слово ІДЕНТИФІКАТОРОМ:
 * 4 x 32^3 - понад сто тисяч варіантів, тож зіткнення в межах треду за десять
 * хвилин не підбереш, а сама модель слова не бачить узагалі (ядро зрізає його
 * з відповіді інструмента й називає власнику саме).
 *
 * Чому не памʼять у KV: там немає ані read-your-writes, ані CAS (kv-store.mjs),
 * а ціна програної гонки тут - невиконаний другий фактор. Слово вже лежить у
 * `proposals.word`, тобто в строго консистентній D1: інше сховище зайве.
 */
export const T2_SUFFIX_LEN = 3;
/** Алфавіт суфікса: без 0/O/1/I - їх плутають при перепечатуванні. */
const T2_SUFFIX_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Формат слова цілком - дешевий відсів тексту до звернення в базу. */
export const T2_WORD_RE = new RegExp(
  `^(?:${T2_WORDS.join('|')})-[${T2_SUFFIX_ALPHABET}]{${T2_SUFFIX_LEN}}$`,
);

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
  const base = levelFor(kind, payload);
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
  if (base === 'T0' && tainted && taintEscalates(kind, payload)) return { level: 'T1' };
  return { level: base };
}

/**
 * Базовий рівень із урахуванням payload. Єдина дія, чий рівень залежить від
 * аргументів, - подія в календарі: без гостей це запис у власному календарі
 * (T0 з «↩», бо «↩» подію видаляє), з гостями - лист іншій людині, а лист
 * назад не забереш (T1). Розрізняти їх у самій таблиці неможливо: там ключ -
 * kind, а не payload.
 * @param {string} kind @param {Record<string, unknown> | undefined} payload
 * @returns {'T0' | 'T1' | 'T2' | undefined}
 */
function levelFor(kind, payload) {
  const base = ACTION_LEVELS[kind];
  if (kind === 'calendar.event' && hasAttendees(payload)) return 'T1';
  return base;
}

/** Чи в payload є хоч один гість. @param {Record<string, unknown> | undefined} payload */
export function hasAttendees(payload) {
  const a = payload?.attendees;
  return Array.isArray(a) && a.some((x) => String(x ?? '').trim() !== '');
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
  // `aspect` тут НЕМАЄ свідомо (ревʼю етапу 7): виконавець його не передавав
  // у Gemini, тобто поле тихо відкидалось - рівно те, від чого білий список і
  // рятує. Дозволене поле, яке нічого не робить, гірше за заборонене: власник
  // схвалює «16:9», а отримує дефолт.
  'gemini.image': ['prompt'],
  'gemini.video': ['prompt', 'seconds', 'model'],
};

/** Межі відео (S-8-6 називає ціну за 8 с). */
export const VIDEO_SECONDS_MIN = 1;
export const VIDEO_SECONDS_MAX = 8;

/**
 * ЄДИНЕ місце, де довжина відео зводиться до дозволеної. Його кличуть і
 * санітизація payload, і рядок ціни, і виконавець: доки clamp жив у трьох
 * місцях із різними дефолтами, «одне число» трималось лише на тому, що всі
 * три константи випадково дорівнювали 8 (ревʼю виправлень).
 * @param {unknown} raw
 */
export function clampVideoSeconds(raw) {
  const n = Number(raw);
  return Number.isFinite(n)
    ? Math.min(Math.max(Math.round(n), VIDEO_SECONDS_MIN), VIDEO_SECONDS_MAX)
    : VIDEO_SECONDS_MAX;
}

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
  // ⚠️ Довжину обрізаємо ТУТ, а не у виконавця (ревʼю етапу 7): ціну під
  // пропозицією ядро рахує з payload, і доки clamp жив лише у виконавці,
  // `seconds: 60` показувало «$24.00» при реальних $3.20, а `seconds: 0` -
  // «$0.00» при реальних $0.40. Одне число - один clamp.
  if ('seconds' in out) out.seconds = clampVideoSeconds(out.seconds);
  if ('model' in out && out.model !== 'lite') out.model = 'veo';
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
    // Той самий clamp, що в санітизації і у виконавця: відкриті пропозиції,
    // створені до цього деплою, теж мусять показувати чесне число.
    const seconds = o.seconds === undefined ? prices.defaultSeconds : clampVideoSeconds(o.seconds);
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
 * поїде в чужий сервіс, а не за напис моделі поруч. Рядок пише модель, тож
 * керівні символи геть (інакше «\n[Ядро] …» підробив би повідомлення), а сам
 * prompt іде КОД-СПАНОМ: рядок ціни проходить через Markdown→HTML, і
 * `[текст](https://…)` показав би власнику самий «текст», сховавши адресу в
 * href - тобто ✅ давалось би не за те, що поїде (ревʼю виправлень).
 * @param {Record<string, unknown> | null | undefined} payload
 */
function promptLine(payload) {
  const raw = payload && typeof payload === 'object' ? payload.prompt : null;
  const text = String(raw ?? '')
    // `\s` тут не для краси: роздільники рядка й абзацу (U+2028/U+2029) у
    // \p{Cc}\p{Cf} НЕ входять, а рядок рвуть так само - і саме ними
    // підробляють повідомлення. Заразом схлопує переноси в один пробіл.
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ')
    // Власний бектик закрив би код-спан достроково й віддав решту розмітці.
    .replace(/`+/g, "'")
    .trim()
    // Обрізати НЕ можна: ✅ дається за те, що поїде, а sanitizeGeminiPayload
    // уже тримає prompt у межах GEMINI_PROMPT_MAX. Довге повідомлення ядро
    // саме розібʼє на частини (renderMdParts).
    .slice(0, GEMINI_PROMPT_MAX);
  return text ? ['', `Запит: \`${text}\``].join('\n') : '';
}

/**
 * Слово для T2 - криптовипадковий вибір (Math.random заборонений у DO-шляхах,
 * а передбачуване слово знецінює другий фактор).
 */
export function pickT2Word() {
  const buf = new Uint32Array(1 + T2_SUFFIX_LEN);
  crypto.getRandomValues(buf);
  const base = /** @type {string} */ (T2_WORDS[(buf[0] ?? 0) % T2_WORDS.length]);
  let suffix = '';
  for (let i = 0; i < T2_SUFFIX_LEN; i++) {
    suffix += T2_SUFFIX_ALPHABET[(buf[i + 1] ?? 0) % T2_SUFFIX_ALPHABET.length];
  }
  return `${base}-${suffix}`;
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
