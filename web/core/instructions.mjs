// Інструкції (01 §2.1 «instructions», 03-plan етап 2 PR-5): джерело - файли
// `docs/assistant/**` у git, приймач - D1 `instructions`, місток між ними -
// `sync-instructions.yml`. Чат інструкцій НЕ пише (ADR-016).
//
// Тут три речі, і всі три потрібні по обидва боки межі (CI-тест, скрипт
// синку, рантайм ядра), тож модуль платформно-чистий: без D1-специфіки в
// парсері й без node:fs.
//
//   parseInstruction   - front-matter + тіло (те, що читає модель)
//   validateInstruction- правила docs/assistant/README.md
//   instructionHash    - sha256 ТІЛА (не файлу): у промпт іде тіло, тож і
//                        цілісність перевіряється на тому, що справді їде
//   loadInstruction    - читання з D1 зі звіркою хешу (нема/розійшлось =
//                        помилка, не тихий фолбек - 00-README п.6)

/** Дозволені kind (README «Front-matter»). */
export const INSTRUCTION_KINDS = ['persona', 'agent', 'checklist', 'profile'];

/** Рівні зусиль моделі (SDK EffortLevel); дзеркало WORKER_EFFORTS мозку. */
export const INSTRUCTION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Вбудовані інструменти SDK, дозволені у front-matter поруч із нашими. */
const BUILTIN_TOOLS = ['WebSearch', 'WebFetch', 'Read', 'Grep', 'Glob'];

/**
 * Канонічні імена інструментів 07 §4 - ПОВНИЙ перелік, включно з тими, чиї
 * виконавці приїдуть на етапах 3-7. Валідатор звіряє саме з ним, а не з
 * поточним реєстром `tools/index.mjs`: інструкції описують кінцевий стан
 * системи, і звірка з реєстром робила б їх червоними до останнього етапу.
 * Друкарську помилку («calendar.raed») цей список ловить так само.
 */
export const CANON_TOOLS = [
  'data.read',
  // Пошук по всіх власних джерелах одним викликом - реліз 08.09 (PR-7 §3.2);
  // у 07 §4 його не було, бо на час канону джерела шукались нарізно.
  'data.search',
  // Зразки голосу власника - реліз 08.09 (PR-8 §6A).
  'style.samples',
  'calendar.read',
  'mail.search',
  'mail.read',
  'drive.search',
  'drive.write',
  'inbox.search',
  'places.search',
  'places.details',
  'places.menu',
  'trip.brief',
  'routes.eta',
  'geo.geocode',
  'geo.last',
  'finance.query',
  'runs.query',
  'memory.search',
  'facts.get',
  'facts.ledger',
  'facts.set',
  'facts.delete',
  'reminders.create',
  'reminders.update',
  'reminders.cancel',
  'record',
  'finance.rule',
  'subscriptions.update',
  // Реєстри власника (07 §4 рядок «ideas.*, wishes.*, collections.*,
  // records.*»): у каноні вони записані згорнуто, тут - розгорнуто саме тими
  // іменами, які підуть у /internal/tool. Без цього рядка інструкція, що
  // згадує `collections.create` у tools, червоніла б як «невідомий інструмент»,
  // хоча канон її дозволяє.
  'ideas.create',
  'ideas.update',
  'ideas.list',
  'ideas.search',
  'ideas.delete',
  'ideas.analyze',
  'wishes.create',
  'wishes.update',
  // Понад канон 07 §4 (там перелік create·update·list·search·delete):
  // імпорт публічного wishlist Steam - S-5-2 без окремого інструмента не
  // робиться, бо це не «створити одне бажання».
  'wishes.import',
  'wishes.list',
  'wishes.search',
  'wishes.delete',
  'collections.create',
  'collections.update',
  'collections.list',
  'collections.search',
  'collections.delete',
  'records.create',
  'records.update',
  'records.list',
  'records.search',
  'records.delete',
  // План дня v2 (ADR-035): розкладку рахує ядро, модель лише кличе ці пʼять.
  'plan.intent',
  'plan.draft',
  'plan.accept',
  'plan.update',
  'plan.review',
  'proposals.create',
  'chain.start',
  'chain.cancel',
  'tg.document',
  'delegate',
  'ask',
];

/** Обовʼязкові розділи за kind (README п.6; списки - з самих файлів). */
const REQUIRED_SECTIONS = {
  persona: [
    'Хто ти',
    'Тон',
    'Формат повідомлень',
    'Рівні підтвердження',
    'Памʼять',
    'Чого не робити',
    'Коли передати працівнику',
  ],
  agent: [
    'Мета',
    'Що отримує',
    'Як працює',
    'Правила',
    'Чого не робити',
    'Формат відповіді',
    'Приклад',
  ],
  checklist: [
    'Коли застосовується',
    'T-30',
    'T-7',
    'T-1',
    'У дорозі',
    'питає при створенні поїздки',
    'рахує автоматично',
    'Чого не робити',
  ],
  profile: ['0.', '1.', '2.', '3.', '4.', '5.', '6.'],
};

/** Обовʼязкові поля front-matter. */
const REQUIRED_FIELDS = [
  'name',
  'kind',
  'model',
  'tools',
  'tainted_output',
  'updated',
  'max_chars',
];

/**
 * Розібрати файл інструкції: `---\n<front-matter>\n---\n<тіло>`.
 * Підмножина YAML навмисно вузька (скаляри + інлайн-масив): усе, що вживає
 * README, і нічого зайвого - парсер контракту не має вміти більше за контракт.
 * @param {string} raw
 * @returns {{ ok: true, front: Record<string, unknown>, body: string }
 *         | { ok: false, error: string }}
 */
export function parseInstruction(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(normalizeEol(raw));
  if (!m) return { ok: false, error: 'немає front-matter (---)' };
  /** @type {Record<string, unknown>} */
  const front = {};
  for (const line of /** @type {string} */ (m[1]).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([a-z_]+):\s*(.*)$/.exec(line);
    if (!kv) return { ok: false, error: `не розібрав рядок front-matter: «${line.trim()}»` };
    const key = /** @type {string} */ (kv[1]);
    const value = /** @type {string} */ (kv[2]).trim();
    // Коментар зрізається лише в НЕлапкованому значенні (ревʼю PR-5): інакше
    // `title: "щось # тут"` мовчки ставало б «щось», і автор дізнався б про це
    // з поведінки моделі, а не з помилки.
    const rawValue = /^['"]/.test(value) ? value : value.replace(/\s+#.*$/, '').trim();
    front[key] = parseScalar(rawValue);
  }
  return { ok: true, front, body: /** @type {string} */ (m[2]).trim() };
}

/** @param {string} v */
function parseScalar(v) {
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    return inner ? inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')) : [];
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^\d+$/.test(v)) return Number(v);
  return v.replace(/^['"]|['"]$/g, '');
}

/**
 * Перевірка правил README. Повертає список помилок - порожній = файл чинний.
 * Помилки формулюються так, щоб їх читав автор інструкції, а не програміст.
 * @param {{ path: string, raw: string }} file - path відносно docs/assistant
 * @returns {string[]}
 */
export function validateInstruction(file) {
  const parsed = parseInstruction(file.raw);
  if (!parsed.ok) return [`${file.path}: ${parsed.error}`];
  const { front, body } = parsed;
  /** @type {string[]} */
  const errors = [];
  const fail = (/** @type {string} */ why) => errors.push(`${file.path}: ${why}`);

  for (const key of REQUIRED_FIELDS) {
    if (!(key in front)) fail(`бракує поля front-matter «${key}»`);
  }
  const expectedName = file.path.replace(/^.*\//, '').replace(/\.md$/, '');
  if (front.name !== expectedName) {
    fail(`name «${front.name}» ≠ імені файлу «${expectedName}»`);
  }
  const kind = String(front.kind ?? '');
  if (!INSTRUCTION_KINDS.includes(kind)) fail(`kind «${kind}» поза переліком`);

  const maxChars = Number(front.max_chars);
  if (!Number.isInteger(maxChars) || maxChars <= 0) fail('max_chars має бути додатним цілим');
  else if (body.length > maxChars) fail(`тіло ${body.length} символів понад max_chars ${maxChars}`);

  const tools = Array.isArray(front.tools) ? front.tools : null;
  if (!tools) fail('tools має бути списком [..]');
  else {
    for (const t of tools) {
      const name = String(t);
      if (!CANON_TOOLS.includes(name) && !BUILTIN_TOOLS.includes(name)) {
        fail(`невідомий інструмент «${name}» (07 §4 або вбудовані SDK)`);
      }
    }
    if (kind === 'persona' && tools.length > 0)
      fail('persona не задає інструментів - це робить профіль');
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(front.updated ?? ''))) fail('updated має бути YYYY-MM-DD');

  // model і tainted_output теж контракт, а не прикраса: перше обирає модель
  // прогону, друге вирішує, чи стає сесія tainted (ревʼю PR-5 - без перевірки
  // «model: sonet» проходило зеленим).
  const model = String(front.model ?? '');
  if (!['haiku', 'sonnet', '-'].includes(model)) fail(`model «${model}» поза переліком`);
  if (kind === 'checklist' && model !== '-') fail('checklist не має моделі - має бути «-»');
  if (typeof front.tainted_output !== 'boolean') fail('tainted_output має бути true або false');
  // effort - необовʼязкове, але якщо задане, то з переліку SDK: друкарська
  // помилка інакше мовчки поверне прогін на дефолтний 'high'.
  if ('effort' in front && !INSTRUCTION_EFFORTS.includes(String(front.effort))) {
    fail(`effort «${front.effort}» поза переліком (${INSTRUCTION_EFFORTS.join(' | ')})`);
  }
  if ('max_steps' in front && !Number.isInteger(Number(front.max_steps))) {
    fail('max_steps має бути цілим');
  }

  for (const section of REQUIRED_SECTIONS[/** @type {keyof typeof REQUIRED_SECTIONS} */ (kind)] ??
    []) {
    if (!new RegExp(`^#{1,3} .*${escapeRe(section)}`, 'm').test(body)) {
      fail(`бракує розділу «${section}»`);
    }
  }

  // Тире замість дефіса - правило репозиторію; у тексті інструкцій воно ще й
  // ламає тон («—» у чаті виглядає чужорідно).
  const dash = body.match(/[—–]/);
  if (dash) fail('довге тире (— або –) - лише дефіс');

  return errors;
}

/** @param {string} s */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** CRLF → LF. Робочий тред на Windows, раннер CI на Linux, git конвертує при
 *  чекауті - без нормалізації sha256 «того самого» тіла відрізнявся б залежно
 *  від того, ХТО його порахував, і парність репо↔D1 ламалась би сама собою.
 *  @param {string} s */
function normalizeEol(s) {
  return s.replace(/\r\n/g, '\n');
}

/**
 * sha256 тіла інструкції, hex. Саме тіло їде в промпт, тож звірка хешу в
 * рантаймі щось означає лише для нього (front-matter - службові поля).
 * @param {string} body
 */
export async function instructionHash(body) {
  const bytes = new TextEncoder().encode(normalizeEol(body));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Прочитати інструкцію з D1 зі звіркою хешу. Відсутність рядка або
 * розбіжність - ПОМИЛКА (01 §2.1): тихий фолбек на вшитий текст означав би,
 * що прод місяцями їде на старій персоні, і ніхто про це не дізнається.
 * @param {Env} env
 * @param {string} name
 * @returns {Promise<{ name: string, kind: string, body: string, hash: string }>}
 */
export async function loadInstruction(env, name) {
  if (!env.DB) throw new Error('instructions: привʼязки DB немає');
  const row = /** @type {any} */ (
    await env.DB.prepare(
      'SELECT name, kind, body_md, version_hash FROM instructions WHERE name = ?',
    )
      .bind(name)
      .first()
  );
  if (!row) throw new Error(`instructions: «${name}» немає в D1 - синк не відпрацював`);
  const body = String(row.body_md ?? '');
  const actual = await instructionHash(body);
  if (actual !== row.version_hash) {
    throw new Error(`instructions: хеш «${name}» розійшовся з тілом (D1 пошкоджено)`);
  }
  return { name: String(row.name), kind: String(row.kind), body, hash: actual };
}
