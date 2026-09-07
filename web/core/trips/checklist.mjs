// Чеклісти поїздок (07 §1 `trips.checklist_key`, S-5-5/S-5-8, етап 5 PR-4):
// джерело - інструкції kind=checklist у D1 (docs/assistant/checklists/*.md),
// тобто той самий шлях, що персона й працівники (ADR-016: чат інструкцій не
// пише). Ядро дістає з файлу блоки T-30 / T-7 / T-1 / «У дорозі» і показує
// їх кнопками; стан пунктів - `trips.checklist_state_json`.
//
// `abroad-car` (07 §1) - це ua-car плюс «кордонні» пункти з abroad-plane-bus:
// окремого файлу немає, тож ядро зшиває два, а не вигадує третій.

import { loadInstruction } from '../instructions.mjs';

/** Порядок і заголовки блоків у файлі чекліста. */
export const BLOCKS = /** @type {const} */ ([
  { key: 't30', heading: 'T-30' },
  { key: 't7', heading: 'T-7' },
  { key: 't1', heading: 'T-1' },
  { key: 'road', heading: 'У дорозі' },
]);
/** Пункти з abroad-plane-bus, які дописуються до ua-car для поїздки за кордон. */
const BORDER_RE = /кордон|паспорт|страхов|зелена карта|роумінг|валют/i;
/** Позначки з файлу: хто виконує пункт. */
const MARKERS = /** @type {const} */ ({
  '[авто]': 'auto',
  '[Дослідник]': 'researcher',
  '[T1]': 't1',
});
/** Стеля пунктів у блоці: більше - кнопок на екран не влізе. */
export const ITEMS_PER_BLOCK = 10;
/** Стеля хвоста пункту в чаті: далі - вже інструкція, а не нагадування. */
const HUMAN_TAIL_MAX = 90;
/** Ознаки, що хвіст пункту написаний для моделі, а не для власника. */
const MACHINE_TAIL_RE = /[`{}§]/;

/**
 * @typedef {{ label: string, text: string, marker: 'auto' | 'researcher' | 't1' | null }} ChecklistItem
 * @typedef {Record<string, ChecklistItem[]>} ChecklistBlocks
 */

/**
 * Ключ чекліста за способом і країною (07 §1).
 * @param {{ mode: string, abroad: boolean }} trip
 */
export function pickChecklistKey(trip) {
  if (trip.mode === 'car') return trip.abroad ? 'abroad-car' : 'ua-car';
  if (trip.abroad) return 'abroad-plane-bus';
  return trip.mode === 'plane' ? 'abroad-plane-bus' : 'ua-train-bus';
}

/** Файли-джерела ключа (abroad-car - два). @param {string} key */
export function filesOf(key) {
  return key === 'abroad-car' ? ['ua-car', 'abroad-plane-bus'] : [key];
}

/**
 * Розібрати тіло інструкції-чекліста на блоки. Пункт - рядок «- …»; мітка
 * `[авто]` / `[Дослідник]` / `[T1]` каже, хто його закриває; label - до
 * першої двокрапки (підпис кнопки).
 * @param {string} body
 * @returns {ChecklistBlocks}
 */
export function parseChecklist(body) {
  /** @type {ChecklistBlocks} */
  const blocks = {};
  let current = null;
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    const heading = line.match(/^##\s+(.+)$/);
    if (heading) {
      const found = BLOCKS.find(
        (b) => b.heading.toLowerCase() === heading[1]?.trim().toLowerCase(),
      );
      current = found ? found.key : null;
      if (current && !blocks[current]) blocks[current] = [];
      continue;
    }
    if (!current || !line.startsWith('- ')) continue;
    const text = line.slice(2).trim();
    if (!text) continue;
    const markerKey = Object.keys(MARKERS).find((m) => text.includes(m));
    // У файлах мітка стоїть у бекапострофах: «Маршрут `[авто]`: …».
    const clean = text.replace(/\s*`?\[(авто|Дослідник|T1)\]`?/g, '').trim();
    blocks[current]?.push({
      label: labelOf(clean),
      text: clean,
      marker: markerKey ? MARKERS[/** @type {keyof typeof MARKERS} */ (markerKey)] : null,
    });
  }
  return blocks;
}

/** Підпис кнопки: до двокрапки, ≤ 40 символів. @param {string} text */
function labelOf(text) {
  // Ріжемо лише по двокрапці: крапка всередині («ТО: дата й пробіг.») зробила
  // б підпис «ТО» - назвою ні про що.
  const head = (text.split(':')[0] ?? text).trim().replace(/[.;,]+$/, '');
  return (head.length > 40 ? `${head.slice(0, 39)}…` : head) || 'пункт';
}

/**
 * Рядок пункту для ВЛАСНИКА: тіло пункту у файлі написане для моделі
 * (`facts.vehicle.<key>`, «рядок у «Бракує»», «(T0, owner)»), і в чат таке
 * слати не можна. Лишаємо людську частину: підпис + перше речення хвоста без
 * код-вставок і службових дужок.
 * @param {ChecklistItem} item
 */
export function humanLine(item) {
  const idx = item.text.indexOf(':');
  const tail = idx === -1 ? '' : item.text.slice(idx + 1);
  // Хвіст із код-вставкою, шаблоном чи посиланням на розділ канону писався
  // для моделі - власнику йде лише підпис пункту.
  if (MACHINE_TAIL_RE.test(tail)) return item.label;
  const clean = (
    tail
      .replace(/`[^`]*`/g, '') // `facts.vehicle.<key>`, `routes.eta`
      .replace(/\([^)]*\)/g, '') // (T0, owner)
      .split(/[;.]/)[0] ?? ''
  ) // лише перше речення
    .replace(/[«»]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—,]+/, '')
    .trim();
  const short = clean.length > HUMAN_TAIL_MAX ? `${clean.slice(0, HUMAN_TAIL_MAX - 1)}…` : clean;
  return short ? `${item.label}: ${short}` : item.label;
}

/**
 * Чекліст поїздки з D1: блоки з файлу (для abroad-car - ua-car + кордонні
 * пункти abroad-plane-bus). Інструкції немає - помилка, не тихий порожній
 * список (00-README п.6).
 * @param {Env} env @param {string} key
 * @returns {Promise<ChecklistBlocks>}
 */
export async function loadChecklist(env, key) {
  const files = filesOf(key);
  /** @type {ChecklistBlocks} */
  const merged = {};
  for (const [i, name] of files.entries()) {
    const loaded = await loadInstruction(env, name);
    const blocks = parseChecklist(loaded.body);
    for (const b of BLOCKS) {
      const items = blocks[b.key] ?? [];
      // Другий файл (abroad-plane-bus для авто за кордон) дає лише кордонні пункти.
      const picked = i === 0 ? items : items.filter((it) => BORDER_RE.test(it.text));
      if (picked.length) merged[b.key] = [...(merged[b.key] ?? []), ...picked];
    }
  }
  return merged;
}

/**
 * Які блоки показати зараз (07 §6): до поїздки < 30 днів - T-30 зливається
 * з найближчим, < 7 днів - T-30 і T-7 разом.
 * @param {number} daysLeft
 * @returns {string[]} ключі блоків, які треба показати в найближчому повідомленні
 */
export function blocksDueNow(daysLeft) {
  // Межі точно за 07 §6: «< 30» і «< 7», тож рівно 30 діб - це ще звичайний
  // T-30 у свій час, а не «зараз».
  if (daysLeft >= 30) return [];
  if (daysLeft >= 7) return ['t30'];
  if (daysLeft > 1) return ['t30', 't7'];
  return ['t30', 't7', 't1'];
}

/** Ідентифікатор пункту для стану й кнопки: «t7:3». @param {string} block @param {number} idx */
export function itemId(block, idx) {
  return `${block}:${idx}`;
}

/**
 * Текст ОДНОГО повідомлення на всі блоки, що настали (07 §6: близька поїздка
 * зливає T-30 і T-7 - це одне повідомлення, а не три). Закриті пункти
 * відсіюються ДО стелі показу, а зайві не зникають мовчки: про них рядок
 * «ще N пунктів». `[авто]` закриває розрахунок ядра - без кнопки.
 * @param {string} chainId
 * @param {{ blocks: string[], items: ChecklistBlocks, done: string[], title: string, extra?: string[] }} input
 */
export function renderBlocks(chainId, input) {
  const lines = [input.title];
  /** @type {{ text: string, callback_data: string }[][]} */
  const buttons = [];
  for (const block of input.blocks) {
    const open = (input.items[block] ?? [])
      .map((item, idx) => ({ item, idx }))
      .filter(({ idx }) => !input.done.includes(itemId(block, idx)));
    for (const { item, idx } of open.slice(0, ITEMS_PER_BLOCK)) {
      lines.push(`• ${humanLine(item)}`);
      if (item.marker !== 'auto') {
        buttons.push([
          { text: `✅ ${item.label}`, callback_data: `c:${chainId}:d${block}_${idx}` },
        ]);
      }
    }
    const rest = open.length - ITEMS_PER_BLOCK;
    if (rest > 0) lines.push(`…і ще ${rest} ${rest === 1 ? 'пункт' : 'пунктів'} у цьому блоці.`);
  }
  for (const line of input.extra ?? []) lines.push(line);
  if (lines.length === 1) lines.push('Усе закрито.');
  buttons.push([
    { text: '🗓 Змінити дати', callback_data: `c:${chainId}:newdate` },
    { text: '✖ Скасувати', callback_data: `c:${chainId}:cancel` },
  ]);
  return { text: lines.join('\n'), buttons };
}

/**
 * Один блок (той самий рендер; лишається для викликів з одним блоком).
 * @param {string} chainId
 * @param {{ block: string, items: ChecklistItem[], done: string[], title: string, extra?: string[] }} input
 */
export function renderBlock(chainId, input) {
  return renderBlocks(chainId, {
    blocks: [input.block],
    items: { [input.block]: input.items },
    done: input.done,
    title: input.title,
    extra: input.extra,
  });
}

/** Стан пунктів із рядка `trips.checklist_state_json`. @param {string | null} json */
export function parseState(json) {
  try {
    const parsed = json ? JSON.parse(json) : null;
    return Array.isArray(parsed?.done) ? parsed.done.map(String) : [];
  } catch {
    return [];
  }
}
