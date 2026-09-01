// Інструменти читання internal API (07-schema §4, етап 1 PR-6). Кожен —
// тонка обгортка над ЧИННИМИ модулями (assistant-data-core, google,
// calendar-core, weather-geo): та сама логіка, що виконує старий агент у
// runReadAction, — інша лише межа (HTTP-контракт замість транскрипту) і
// маркування зовнішнього вмісту тут, у ядрі.
//
// Контракт виконавця: run(env, args, nowMs) -> { result: string | object }.
// Помилка джерела - виняток; router перетворює його на явний 502 tool-failed
// (жодної тихої деградації - інваріант «помилка видима»).

import {
  buildOwnDataDigest,
  formatMailForPrompt,
  formatMailBodyForPrompt,
  formatDriveForPrompt,
  OWN_DATA_SCOPES,
} from '../../assistant-data-core.mjs';
import { readMail, readMailBody, searchDrive, readCalendarRange } from '../../google.mjs';
import { formatEventsForPrompt, formatRangeEventsForPrompt } from '../../calendar-core.mjs';
import { geocodeCity } from '../../weather-geo.mjs';
import { loadState, loadStats, loadLatest, loadSettings } from '../../kv-store.mjs';
import { aggregateStats } from '../../stats-core.mjs';
import { totalProgress } from '../../roadmap-core.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { listActiveReminders } from '../reminders/store.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import { wrapExternal } from './markup.mjs';

/** Кап data.read за замовчуванням = профіль chat (07 §4: chat 12k). */
export const DATA_READ_DEFAULT_CAP = 12_000;
const DATA_READ_MAX_CAP = 50_000; // стеля weekly-профілю - більшого не існує

const MAIL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/; // той самий контракт, що в agent-core

/**
 * data.read: дайджест власних даних за scope. Скоупи - чинні OWN_DATA_SCOPES;
 * scope=weekly приходить на етапі 3 разом із даними архіву (там його PR).
 * @param {Env} env
 * @param {{ scope: string, cap?: number }} args
 * @param {number} nowMs
 */
export async function runDataRead(env, args, nowMs) {
  if (!OWN_DATA_SCOPES.includes(args.scope)) {
    throw new Error(`невідомий scope "${args.scope}" (чинні: ${OWN_DATA_SCOPES.join(', ')})`);
  }
  const cap = Math.min(
    Math.max(Math.trunc(args.cap ?? DATA_READ_DEFAULT_CAP), 500),
    DATA_READ_MAX_CAP,
  );
  const [state, stats, latest, settings, fromD1] = await Promise.all([
    loadState(env),
    loadStats(env),
    loadLatest(env),
    loadSettings(env),
    // Нагадування живуть у ДВОХ сховищах до фліпа (PR-7): створені через
    // /remind - у KV, створені мозком - у D1. Модель мусить бачити обидва:
    // інакше вона не знаходить id того, що сама щойно створила, і не може
    // ані змінити, ані скасувати.
    readD1Reminders(env),
  ]);
  const todayKey = kyivDateKey(new Date(nowMs));
  const digest = buildOwnDataDigest({
    scope: args.scope,
    // Дедуп за id з пріоритетом D1 (ревʼю PR-7): у вікні часткової міграції
    // той самий запис лежить в обох сховищах, і без цього модель бачила б
    // його двічі, а скасування зняло б лише одну копію.
    reminders: mergeReminders(state.reminders, fromD1),
    agg: aggregateStats(stats, todayKey),
    roadmap: totalProgress(state.roadmapProgress ?? {}),
    latest,
    todayKey,
    settings,
  });
  return { result: digest.slice(0, cap) };
}

/** KV + D1 без дублів: за одним id перемагає D1 (там свіжий статус).
 *  @param {any[] | undefined} fromKv @param {any[]} fromD1 */
function mergeReminders(fromKv, fromD1) {
  const byId = new Map();
  for (const r of Array.isArray(fromKv) ? fromKv : []) byId.set(String(r?.id), r);
  for (const r of fromD1) byId.set(String(r.id), r);
  return [...byId.values()];
}

/** Активні нагадування з D1 у формі дайджесту (whenMs/text/firedTs).
 *  Збій читання не має валити весь data.read - тоді власник бачить хоча б
 *  KV-частину, і про це є слід у логах.
 *  @param {Env} env */
async function readD1Reminders(env) {
  if (!env.DB) return [];
  try {
    const rows = await listActiveReminders(env);
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      whenMs: Date.parse(r.dueAt),
      firedTs: null,
    }));
  } catch (/** @type {any} */ e) {
    console.error('data.read: нагадування з D1 не прочитались', e?.message);
    return [];
  }
}

/**
 * calendar.read: події на days днів уперед (0 = лише сьогодні; 07 §4: 0-7).
 * Зсув дат - addDaysToDateKey (НЕ мілісекунди: DST).
 * @param {Env} env
 * @param {{ days: number }} args
 * @param {number} nowMs
 */
export async function runCalendarRead(env, args, nowMs) {
  if (!Number.isInteger(args.days)) throw new Error('days має бути цілим 0-7');
  const today = kyivDateKey(new Date(nowMs));
  const endKey = addDaysToDateKey(today, args.days);
  const events = await readCalendarRange(env, today, endKey);
  // null = джерело недоступне (токен/мережа) - це НЕ «подій немає»: тиха
  // підміна змусила б модель упевнено брехати про порожній календар.
  if (events == null) throw new Error('календар недоступний (токен або мережа)');
  const single = args.days === 0;
  const body = single ? formatEventsForPrompt(events) : formatRangeEventsForPrompt(events);
  return { result: `Календар (${single ? today : `${today}…${endKey}`}): ${body}` };
}

/**
 * mail.search: заголовки листів за запитом. Вміст - зовнішній (tainted).
 * @param {Env} env
 * @param {{ q: string }} args
 */
export async function runMailSearch(env, args) {
  const q = String(args.q ?? '').trim();
  let messages = await readMail(env, q);
  // Gmail шукає кілька слів як AND, тож природна фраза («лист від Steam»)
  // не знаходить нічого, хоч лист є - саме це сталось на прийманні 30.08.
  // Якщо в запиті немає операторів Gmail і видача порожня, пробуємо ще раз
  // зі значущими словами через OR. Один додатковий запит, не цикл.
  if (Array.isArray(messages) && messages.length === 0) {
    const broadened = broadenMailQuery(q);
    if (broadened) messages = await readMail(env, broadened);
  }
  return { result: wrapExternal('mail', formatMailForPrompt(messages)) };
}

/** Слова, що несуть нуль пошукового сенсу в запиті до пошти. */
const MAIL_STOPWORDS = new Set([
  'лист',
  'листа',
  'листи',
  'листів',
  'від',
  'про',
  'знайди',
  'знайти',
  'пошта',
  'пошті',
  'пошту',
  'пошук',
  'мені',
  'мій',
  'моя',
  'моє',
  'мою',
  'останній',
  'останні',
  'новий',
  'нові',
  'mail',
  'email',
  'letter',
  'find',
]);

/**
 * «лист від Steam за минулий тиждень» → «Steam OR минулий OR тиждень».
 * Порожній рядок = розширювати нічого (запит уже з оператором Gmail, одне
 * слово або самі стоп-слова).
 * @param {string} q
 */
export function broadenMailQuery(q) {
  // Оператор Gmail (from:, subject:, newer_than:, лапки, дужки) означає, що
  // запит уже точний - розширення лише зіпсувало б його.
  if (/[:()"]/.test(q)) return '';
  const words = q
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_-]/gu, ''))
    .filter((w) => w.length >= 3 && !MAIL_STOPWORDS.has(w.toLowerCase()));
  if (words.length === 0) return '';
  const broadened = words.slice(0, 5).join(' OR ');
  // Той самий запит переспрашувати нема сенсу - Gmail відповість так само.
  return broadened === q ? '' : broadened;
}

/**
 * mail.read: тіло одного листа за id. Вміст - зовнішній (tainted).
 * @param {Env} env
 * @param {{ id: string }} args
 */
export async function runMailRead(env, args) {
  if (!MAIL_ID_RE.test(args.id)) throw new Error('невалідний id листа');
  const text = formatMailBodyForPrompt(await readMailBody(env, args.id));
  return { result: wrapExternal('mail', text, args.id) };
}

/**
 * drive.search: назви й лінки файлів (вмісту не читаємо - чинний контракт
 * searchDrive). Назви файлів - зовнішній вміст (tainted).
 * @param {Env} env
 * @param {{ q: string }} args
 */
export async function runDriveSearch(env, args) {
  const text = formatDriveForPrompt(await searchDrive(env, args.q));
  return { result: wrapExternal('drive', text) };
}

/**
 * geo.last: остання відома локація власника. Ручне перевизначення
 * (ownerGeoManual) переважає авто (ownerGeo) - той самий порядок, що в
 * handleLiveWeather. Віку сховище не тримає (без timestamp) - чесний null,
 * а не вигадане число.
 * @param {Env} env
 */
export async function runGeoLast(env) {
  const read = async (/** @type {string} */ key) => {
    try {
      const parsed = JSON.parse((await env.BRIEFING.get(key)) ?? 'null');
      // Битий запис (масив, обʼєкт без чисел-координат) = локації немає, а не
      // {known:true} з undefined-полями, що випадають із JSON-відповіді.
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      if (typeof parsed.lat !== 'number' || typeof parsed.lon !== 'number') return null;
      return parsed;
    } catch {
      return null;
    }
  };
  const manual = await read('ownerGeoManual');
  const auto = await read('ownerGeo');
  const geo = manual ?? auto;
  if (!geo) return { result: { known: false } };
  return {
    result: {
      known: true,
      lat: geo.lat,
      lon: geo.lon,
      name: geo.name ?? null,
      source: manual ? 'manual' : 'auto',
      ageMs: null, // сховище не тримає часу запису - брехати числом не будемо
    },
  };
}

/**
 * geo.geocode: назва міста/адреси -> координати. Поки через чинний
 * OpenWeather Geocoding (безкоштовний, уже в проді для /locate); Google
 * Geocoding із quota_counters замінить його на етапі 5 (там адаптер Maps).
 * @param {Env} env
 * @param {{ text: string }} args
 */
export async function runGeoGeocode(env, args) {
  if (!env.WEATHER_API_KEY) throw new Error('WEATHER_API_KEY відсутній');
  const found = await geocodeCity(args.text, env.WEATHER_API_KEY);
  if (!found) return { result: { found: false } };
  return { result: { found: true, lat: found.lat, lon: found.lon, name: found.name ?? null } };
}
