// Керування увагою власника в Telegram. Це НАВМИСНО не quiet hours:
// quiet hours — сталий розклад, а focus — короткий, явний режим «не
// відволікати». Нагадування, які власник сам поставив, і аварійні алерти
// через нього не проходять.

import { runFactsDelete, runFactsGet, runFactsSet } from './tools/facts.mjs';

export const FOCUS_SETTING_KEY = 'assistant_focus';
export const DEFAULT_FOCUS_MINUTES = 120;
export const MIN_FOCUS_MINUTES = 15;
export const MAX_FOCUS_MINUTES = 12 * 60;

/**
 * Розібрати аргумент /focus. Число без одиниці навмисно не приймаємо: «2»
 * може означати хвилини або години, а режим, який випадково вимкнеться за дві
 * хвилини, не виконує обіцянку не турбувати.
 * @param {unknown} raw @param {number} [nowMs]
 * @returns {{ kind: 'on', untilMs: number, minutes: number } | { kind: 'off' } | { kind: 'error', message: string }}
 */
export function parseFocusRequest(raw, nowMs = Date.now()) {
  const text = String(raw ?? '')
    .trim()
    .toLocaleLowerCase('uk');
  if (!text) {
    return {
      kind: 'on',
      minutes: DEFAULT_FOCUS_MINUTES,
      untilMs: nowMs + DEFAULT_FOCUS_MINUTES * 60_000,
    };
  }
  if (/^(?:off|stop|вимк(?:нути|ни)|скас(?:увати|уй))$/.test(text)) return { kind: 'off' };

  const m = /^(\d{1,3})\s*(хв(?:\.|илин[аи]?)?|m(?:in)?|год(?:\.|ина|ини)?|h)$/.exec(text);
  if (!m) {
    return {
      kind: 'error',
      message: 'Формат: /focus 30 хв, /focus 2 год або /focus off.',
    };
  }
  const count = Number(m[1]);
  const unit = String(m[2]);
  const minutes = /^(?:год|h)/.test(unit) ? count * 60 : count;
  if (minutes < MIN_FOCUS_MINUTES || minutes > MAX_FOCUS_MINUTES) {
    return {
      kind: 'error',
      message: `Фокус можна ввімкнути від ${MIN_FOCUS_MINUTES} хв до ${MAX_FOCUS_MINUTES / 60} год.`,
    };
  }
  return { kind: 'on', minutes, untilMs: nowMs + minutes * 60_000 };
}

/** @param {unknown} value @param {number} nowMs */
export function focusUntilFromValue(value, nowMs = Date.now()) {
  const raw =
    value && typeof value === 'object'
      ? /** @type {{ until_ms?: unknown }} */ (value).until_ms
      : value;
  const untilMs = Number(raw);
  if (!Number.isFinite(untilMs) || untilMs <= nowMs) return null;
  // Захист від битого чи вручну відредагованого факту: focus — це тимчасовий
  // режим, не спосіб непомітно вимкнути асистента назавжди.
  if (untilMs > nowMs + MAX_FOCUS_MINUTES * 60_000) return null;
  return Math.trunc(untilMs);
}

/** @param {Env} env @param {number} [nowMs] */
export async function focusUntil(env, nowMs = Date.now()) {
  if (!env.DB) return null;
  try {
    const fact = (await runFactsGet(env, { kind: 'setting', key: FOCUS_SETTING_KEY }, nowMs))
      .result[0];
    return focusUntilFromValue(fact?.value, nowMs);
  } catch (/** @type {any} */ e) {
    // Невдача читання налаштування не повинна тихо вимикати всі важливі
    // повідомлення. Fail-open тут правильний: створені нагадування важливіші.
    console.error('assistant-controls: focus не прочитано', e?.message);
    return null;
  }
}

/** @param {Env} env @param {number} [nowMs] */
export async function isFocusActive(env, nowMs = Date.now()) {
  return (await focusUntil(env, nowMs)) != null;
}

/**
 * Єдиний гейт для автоматичних повідомлень. `critical` проходить завжди;
 * ручні відповіді сюди не передаються взагалі. Повертаємо причину, щоб cron
 * мав чесну telemetry, а не безіменне `false`.
 * @param {Env} env @param {'critical' | 'action' | 'digest' | 'nudge'} priority
 * @param {number} [nowMs]
 */
export async function shouldDeliverProactive(env, priority, nowMs = Date.now()) {
  if (priority === 'critical') return { deliver: true, reason: null };
  const untilMs = await focusUntil(env, nowMs);
  if (untilMs != null) return { deliver: false, reason: 'focus', untilMs };
  return { deliver: true, reason: null };
}

/** @param {Env} env @param {number} untilMs @param {number} [nowMs] */
export async function enableFocus(env, untilMs, nowMs = Date.now()) {
  const parsed = focusUntilFromValue({ until_ms: untilMs }, nowMs);
  if (parsed == null) throw new Error('некоректний час завершення focus');
  await runFactsSet(
    env,
    {
      kind: 'setting',
      key: FOCUS_SETTING_KEY,
      value: { until_ms: parsed },
      source: 'owner_assertion',
      confidence: 1,
      observed_at: new Date(nowMs).toISOString(),
      expires_at: new Date(parsed).toISOString(),
    },
    nowMs,
    { actor: 'owner', tainted: false, why: 'Telegram /focus' },
  );
  return parsed;
}

/** @param {Env} env @param {number} [nowMs] */
export async function disableFocus(env, nowMs = Date.now()) {
  if (!env.DB) return false;
  const out = await runFactsDelete(
    env,
    { kind: 'setting', key: FOCUS_SETTING_KEY, why: 'Telegram /focus off' },
    nowMs,
    { actor: 'owner', tainted: false, why: 'Telegram /focus off', operation: 'deleted' },
  );
  return out.result.deleted === true;
}

/** @param {number} untilMs */
export function formatFocusUntil(untilMs) {
  return new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(untilMs));
}
