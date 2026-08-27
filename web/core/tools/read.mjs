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
  const [state, stats, latest, settings] = await Promise.all([
    loadState(env),
    loadStats(env),
    loadLatest(env),
    loadSettings(env),
  ]);
  const todayKey = kyivDateKey(new Date(nowMs));
  const digest = buildOwnDataDigest({
    scope: args.scope,
    reminders: state.reminders,
    agg: aggregateStats(stats, todayKey),
    roadmap: totalProgress(state.roadmapProgress ?? {}),
    latest,
    todayKey,
    settings,
  });
  return { result: digest.slice(0, cap) };
}

/**
 * calendar.read: події на days днів уперед (0 = лише сьогодні; 07 §4: 0-7).
 * Зсув дат - addDaysToDateKey (НЕ мілісекунди: DST).
 * @param {Env} env
 * @param {{ days: number }} args
 * @param {number} nowMs
 */
export async function runCalendarRead(env, args, nowMs) {
  const today = kyivDateKey(new Date(nowMs));
  const endKey = addDaysToDateKey(today, args.days);
  const events = await readCalendarRange(env, today, endKey);
  const single = args.days === 0;
  const body = single
    ? formatEventsForPrompt(events ?? [])
    : formatRangeEventsForPrompt(events ?? []);
  return { result: `Календар (${single ? today : `${today}…${endKey}`}): ${body}` };
}

/**
 * mail.search: заголовки листів за запитом. Вміст - зовнішній (tainted).
 * @param {Env} env
 * @param {{ q: string }} args
 */
export async function runMailSearch(env, args) {
  const text = formatMailForPrompt(await readMail(env, args.q));
  return { result: wrapExternal('mail', text) };
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
      return parsed && typeof parsed === 'object' ? parsed : null;
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
