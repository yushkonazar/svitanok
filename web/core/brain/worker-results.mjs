// Результати працівників (07 §4 delegate, S-7-1; етап 4 PR-3): мозок кладе
// текст останнього працівника в deliver, ядро зберігає його в `reports`
// (kind `worker:<name>`) і дає кнопки під відповіддю: «✏️ Коротше» і «🔁 Інший
// тон» - той самий тред, наступний chat-прогін із підказкою (сесія памʼятає
// задачу); «📎 .md» - файл із базою. Понад 3 500 символів - файл іде одразу
// разом із копією в Drive (Світанок/workers), кнопки .md тоді немає.

import { sendDocument } from '../tg/outbox.mjs';
import { uploadMarkdown } from '../adapters/drive.mjs';

/** Стеля тексту працівника в чаті (S-7-1): довше - файл + Drive. */
export const WORKER_CHAT_MAX = 3_500;
export const WORKER_DRIVE_FOLDER = ['Світанок', 'workers'];
/** Підказки в тред за кнопками - модель дістає їх як текст власника. */
export const WORKER_FOLLOWUPS = {
  short: 'Коротше: скороти результат працівника вдвічі, суть лиши.',
  tone: 'Інший тон: перепиши результат працівника в іншому тоні, зміст той самий.',
  next: 'Покажи наступні листи з тих, що чекають.',
  draft: 'Склади чернетку відповіді на лист, про який щойно йшлося.',
  src: 'Дай джерела: звідки саме взято те, що ти щойно сказав.',
  week: 'Розбий це по тижнях і покажи тренд.',
  cal: 'Постав це в календар - запропонуй подію з часом.',
  spend: 'Куди саме пішли ці гроші: розклади по категоріях.',
  more: 'Дай ще питань на цю тему.',
};

/**
 * ⚠️ КНОПКИ ЗА ПРАЦІВНИКОМ, а не однакові на все (скарга 15 прогону 08.09:
 * під тріажем пошти висіли «Коротше / Інший тон» - кнопки для ТЕКСТУ, а не
 * для переліку листів). Ключі - з WORKER_FOLLOWUPS; невідомий працівник
 * дістає базовий набір, бо для довільного тексту він і правильний.
 * @type {Record<string, { key: keyof typeof WORKER_FOLLOWUPS, text: string }[]>}
 */
const WORKER_ACTIONS = {
  // Вибір магазину — основна дія під підбором ціни; загальні «Коротше» й
  // «Інший тон» тут лише заважали б зробити наступний крок.
  'price-search': [],
  'mail-secretary': [
    { key: 'draft', text: '✍️ Чернетка відповіді' },
    { key: 'next', text: '✉️ Наступні листи' },
  ],
  researcher: [
    { key: 'src', text: '🔎 Джерела' },
    { key: 'short', text: '✏️ Коротше' },
  ],
  analyst: [
    { key: 'week', text: '📊 По тижнях' },
    { key: 'short', text: '✏️ Коротше' },
  ],
  planner: [
    { key: 'cal', text: '🗓 У календар' },
    { key: 'short', text: '✏️ Коротше' },
  ],
  finance: [
    { key: 'spend', text: '💸 Куди пішли' },
    { key: 'short', text: '✏️ Коротше' },
  ],
  tutor: [
    { key: 'more', text: '🎓 Ще питань' },
    { key: 'short', text: '✏️ Коротше' },
  ],
};

/** Базовий набір - для тексту, який просять переписати (копірайтер, редактор). */
const WORKER_ACTIONS_DEFAULT = [
  { key: /** @type {const} */ ('short'), text: '✏️ Коротше' },
  { key: /** @type {const} */ ('tone'), text: '🔁 Інший тон' },
];

const NAME_RE = /^[a-z][a-z0-9-]{1,31}$/;

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає');
  return env.DB;
}

/** Кнопки під відповіддю (07 §9 `m:w:<id>:<choice>`), набір - за працівником.
 *  @param {string} id @param {boolean} withMd @param {string} [worker] */
export function workerButtons(id, withMd, worker = '') {
  // ⚠️ hasOwn, не просто індексація (security-ревʼю релізу): імʼя працівника
  // приходить від моделі, і `constructor` проходив би NAME_RE, резолвився в
  // Object і валив доставку відповіді на `.map`.
  const set = Object.hasOwn(WORKER_ACTIONS, worker) ? WORKER_ACTIONS[worker] : undefined;
  const actions = set ?? WORKER_ACTIONS_DEFAULT;
  if (actions.length === 0) return [];
  const row = actions.map((a) => ({
    text: a.text,
    callback_data: `m:w:${id}:${a.key}`,
  }));
  if (withMd) row.push({ text: '📎 .md', callback_data: `m:w:${id}:md` });
  return [row];
}

/** Дозволені магазини для початкового вибору товару. Це не обмежує вже
 * доданий власником URL, але не перетворює пошуковий результат на кнопку до
 * довільного домену. */
/** @type {Record<string, string>} */
const PRICE_SHOP_NAMES = {
  'rozetka.com.ua': 'Rozetka',
  'comfy.ua': 'Comfy',
  'allo.ua': 'Allo',
  'foxtrot.com.ua': 'Foxtrot',
  'eldorado.ua': 'Eldorado',
};

/** @typedef {{ shop: string, detail: string, url: string }} PriceShopOption */

/**
 * Витягує з контрольованого формату Дослідника конкретні сторінки товару.
 * У кнопки й посилання потрапляють тільки https-URL від allowlisted магазинів;
 * текст веб-сторінки ніколи не задає callback_data чи HTML.
 * @param {string} text @returns {PriceShopOption[]}
 */
export function priceShopOptions(text) {
  /** @type {PriceShopOption[]} */
  const options = [];
  let prices = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const heading = rawLine.match(/^\s*##\s*(.+)$/);
    if (heading) {
      // `\b` у JavaScript працює лише з ASCII `\w`, тому після українського
      // «ціни» межі слова немає. Явний розділювач тримає формат контрольованим
      // і водночас не губить локалізований заголовок.
      prices = /^ціни(?:\s|$|[—:-])/i.test(String(heading[1] ?? '').trim());
      continue;
    }
    if (!prices || !/^\s*[-*]\s+/.test(rawLine)) continue;
    const urlMatch = rawLine.match(/https:\/\/[^\s)\]>]+/i);
    if (!urlMatch) continue;
    let url;
    try {
      url = new URL(urlMatch[0]);
    } catch {
      continue;
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const shop = PRICE_SHOP_NAMES[host];
    if (!shop) continue;
    const detail = rawLine
      .replace(/^\s*[-*]\s*/, '')
      .replace(urlMatch[0], '')
      .replace(/\s+[-—–]\s*$/, '')
      .replace(/[[\]<>`*_]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 150);
    if (options.some((o) => o.url === url.toString())) continue;
    options.push({ shop, detail, url: url.toString() });
    if (options.length >= 4) break;
  }
  return options;
}

/** Картка варіантів: посилання видно до натискання кнопки, тож вибір магазину
 * є усвідомленим. @param {PriceShopOption[]} options */
export function priceShopCard(options) {
  if (!options.length) return '';
  const lines = options.map((o) => {
    const label = o.shop.replace(/[[\]]/g, ' ');
    return `• [${label}](${o.url})${o.detail ? ` — ${o.detail}` : ''}`;
  });
  return ['🎁 Обери магазин для відстеження:', ...lines].join('\n');
}

/** @param {string} reportId @param {PriceShopOption[]} options */
export function priceShopButtons(reportId, options) {
  return options.map((o, index) => [
    { text: `🎁 ${o.shop}`, callback_data: `m:ps:${reportId}:${index}` },
  ]);
}

/** @param {string} name @param {number} nowMs */
export function workerFilename(name, nowMs) {
  return `${name}-${new Date(nowMs).toISOString().slice(0, 10)}.md`;
}

/**
 * Зберегти результат працівника; повертає id рядка. Імʼя - з реєстру мозку
 * (латиниця з дефісом), текст - під кап; чуже імʼя - помилка контракту.
 * @param {Env} env @param {{ name: string, text: string }} worker @param {number} nowMs
 */
export async function saveWorkerResult(env, worker, nowMs) {
  const name = String(worker.name ?? '');
  if (!NAME_RE.test(name)) throw new Error(`worker: імʼя «${name.slice(0, 40)}» не за форматом`);
  // Довжину тримає DELIVER_SCHEMA.worker.text (20 000) ДО цього виклику.
  const text = String(worker.text ?? '');
  if (!text.trim()) throw new Error('worker: порожній текст');
  const id = crypto.randomUUID();
  await db(env)
    .prepare('INSERT INTO reports (id, kind, text_md, created_at) VALUES (?, ?, ?, ?)')
    .bind(id, `worker:${name}`, text, new Date(nowMs).toISOString())
    .run();
  return { id, name, text };
}

/**
 * @param {Env} env @param {string} id
 * @returns {Promise<{ id: string, name: string, text: string, createdAt: string } | null>}
 */
export async function loadWorkerResult(env, id) {
  const row =
    /** @type {{ id: string, kind: string, text_md: string, created_at: string } | null} */ (
      await db(env)
        .prepare(
          `SELECT id, kind, text_md, created_at FROM reports WHERE id = ? AND kind LIKE 'worker:%'`,
        )
        .bind(id)
        .first()
    );
  if (!row) return null;
  return {
    id: String(row.id),
    name: String(row.kind).slice('worker:'.length),
    text: String(row.text_md ?? ''),
    createdAt: String(row.created_at),
  };
}

/**
 * Файл із результатом у тред (кнопка «📎 .md» або довгий результат одразу).
 * @param {Env} env @param {{ chatId: number | string, threadId: number | string | null }} target
 * @param {{ name: string, text: string }} result @param {number} nowMs
 */
export async function sendWorkerDocument(env, target, result, nowMs) {
  await sendDocument(
    env,
    target,
    {
      filename: workerFilename(result.name, nowMs),
      content: result.text,
      caption: `Результат працівника «${result.name}»`,
    },
    nowMs,
  );
}

/**
 * Копія в Drive (S-7-1: «> 3 500 → .md + Drive») - best-effort: збій лише в
 * лог, файл у чаті власник уже має.
 * @param {Env} env @param {{ name: string, text: string }} result @param {number} nowMs
 */
export function uploadWorkerResult(env, result, nowMs) {
  return uploadMarkdown(
    env,
    WORKER_DRIVE_FOLDER,
    workerFilename(result.name, nowMs),
    result.text,
    'worker-results',
  );
}
