// Задача `secret-expiry` (07 §7, 05-ops §3, етап 7 PR-5): раз на добу
// нагадати про секрети, яким лишилось 30 або 7 днів, і - окремо - про ті,
// чиєї дати ротації система не знає.
//
// Заодно тут щоденна звірка скоупів Google (етап 7 PR-1). Місце не випадкове:
// зайвий скоуп у токені - це та сама гігієна доступів, що й простроченний
// ключ, і побачити його можна лише свідомою перевіркою - він нічого не
// ламає, отже сам про себе не скаже ніколи.

import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { runFactsGet, runFactsSet } from '../tools/facts.mjs';
import { googleGrantedScopes } from '../../google.mjs';
import { auditScopes, extraScopesAlertText } from '../google-scopes.mjs';
import {
  DATED_SECRETS,
  ROTATED_KEY_PREFIX,
  EXPIRY_STATE_KEY,
  UNKNOWN_MARK_KEY,
  UNKNOWN_REPEAT_DAYS,
  WIDEST_STAGE,
  daysLeft,
  stageFor,
  expiryText,
  unknownText,
} from './secrets.mjs';

/** Година перевірки за Києвом. */
export const SECRET_EXPIRY_HOUR = 10;
/** Мітка «сьогодні вже перевіряв». */
export const SECRET_EXPIRY_MARKER = 'secretExpiryDay';

/**
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function secretExpiryTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== SECRET_EXPIRY_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(SECRET_EXPIRY_MARKER)) === today) return { skipped: 'done' };
  if (!env.DB) {
    console.error('secret-expiry: привʼязки DB немає - дати ротації недоступні');
    return { skipped: 'no-db' };
  }

  const settings = await readSettings(env);
  /** @type {Record<string, number>} */
  const state = asRecord(settings[EXPIRY_STATE_KEY]);
  /** @type {string[]} */
  const unknown = [];
  let reminded = 0;
  let changed = false;

  for (const secret of DATED_SECRETS) {
    const rotated = settings[`${ROTATED_KEY_PREFIX}${secret.name}`];
    const left = daysLeft(secret, typeof rotated === 'string' ? rotated : null, nowMs);
    if (left == null) {
      unknown.push(secret.name);
      continue;
    }
    const stage = stageFor(left, state[secret.name] ?? null);
    if (stage == null) {
      // Секрет оновили (залишок знову більший за найширший поріг) - забуваємо,
      // на якому порозі спинились. Інакше наступного циклу нагадування за 30
      // днів не спрацює: стан казав би, що про нього вже говорили.
      if (left > WIDEST_STAGE && state[secret.name] != null) {
        delete state[secret.name];
        changed = true;
      }
      continue;
    }
    await sendSystemAlert(env, expiryText(secret, left, stage), nowMs);
    state[secret.name] = stage;
    changed = true;
    reminded += 1;
  }

  if (unknown.length && (await unknownDue(settings, nowMs))) {
    await sendSystemAlert(env, unknownText(unknown), nowMs);
    await writeSetting(env, UNKNOWN_MARK_KEY, new Date(nowMs).toISOString(), nowMs);
  }
  if (changed) await writeSetting(env, EXPIRY_STATE_KEY, state, nowMs);

  const scopes = await auditGoogle(env, nowMs);
  await env.BRIEFING.put(SECRET_EXPIRY_MARKER, today);
  return { reminded, unknown: unknown.length, scopes };
}

/**
 * Звірка виданих скоупів Google (етап 7 PR-1): брак ламає можливість - його
 * власник побачить сам; ЗАЙВИЙ не ламає нічого, тому про нього кажемо тут.
 * @param {Env} env @param {number} nowMs
 */
async function auditGoogle(env, nowMs) {
  try {
    const audit = auditScopes(await googleGrantedScopes(env));
    if (!audit.known) return 'unknown';
    if (audit.extra.length) {
      await sendSystemAlert(env, extraScopesAlertText(audit.extra), nowMs);
      return 'extra';
    }
    return audit.missing.length ? 'missing' : 'ok';
  } catch (/** @type {any} */ e) {
    console.error('secret-expiry: звірка скоупів впала', e?.message);
    return 'failed';
  }
}

/** Чи час знову казати про секрети без дати. @param {Record<string, unknown>} settings @param {number} nowMs */
async function unknownDue(settings, nowMs) {
  const last = settings[UNKNOWN_MARK_KEY];
  const at = typeof last === 'string' ? Date.parse(last) : NaN;
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= UNKNOWN_REPEAT_DAYS * 86_400_000;
}

/** Усі facts.setting одним читанням. @param {Env} env */
async function readSettings(env) {
  /** @type {Record<string, unknown>} */
  const out = {};
  try {
    const { result } = await runFactsGet(env, { kind: 'setting' });
    for (const row of /** @type {{ key: string, value: unknown }[]} */ (result)) {
      out[row.key] = row.value;
    }
  } catch (/** @type {any} */ e) {
    console.error('secret-expiry: facts не прочитались', e?.message);
  }
  return out;
}

/** @param {Env} env @param {string} key @param {unknown} value @param {number} nowMs */
async function writeSetting(env, key, value, nowMs) {
  // source=inferred: це запис системи, а не слово власника (07 §4).
  await runFactsSet(env, { kind: 'setting', key, value, source: 'inferred' }, nowMs).catch(
    (/** @type {any} */ e) => {
      console.error(`secret-expiry: ${key} не записано`, e?.message);
    },
  );
}

/** @param {unknown} raw @returns {Record<string, number>} */
function asRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    if (Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}
