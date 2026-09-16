// Handshake версій ядро↔мозок (01-architecture §2.2): мозок на /health віддає
// канонічний JSON {version, gitSha, …}; deploy-host.yml після деплою кладе
// ОЧІКУВАНІ version+gitSha у KV `brainExpected`; задача brain-health порівнює
// і при розсинхроні шле алерт у TOPIC_SYSTEM. Це закриває сліпоту чинного
// health-check - інцидент 19.07.2026: прод вручну задеплоєний повз main, і
// хост-розсинхрон тихо ламав асистента тижнями.
//
// Алерт - ЗА ЗМІНОЮ СТАНУ (ok → desync/down і назад), не щотіка: задача бігає
// кожні 5 хв, і 288 однакових алертів на добу - це спосіб привчити власника
// їх не читати. Стан живе в KV `brainHealthState`.

import { enqueueOutbox, drainOutbox } from '../tg/outbox.mjs';

/** KV-ключ очікуваних версій - пише deploy-host.yml після вдалого деплою. */
export const BRAIN_EXPECTED_KEY = 'brainExpected';
/** Остання жива проба; не плутати з BRAIN_EXPECTED_KEY (це лише конфіг deploy). */
export const BRAIN_HEALTH_STATE_KEY = 'brainHealthState';
/** Три пропущені 5-хвилинні тики = дані health вже не можна називати живими. */
export const BRAIN_HEALTH_STALE_MS = 15 * 60_000;
const HEALTH_TIMEOUT_MS = 8_000;

/**
 * Health доводить, що HTTP-сервер відповідає, але це ще не доказ готового
 * модельного рантайму: потрібні і profile models, і Claude SDK/CLI, і жива
 * внутрішня адреса core. Це лише readiness конфігурації, не synthetic LLM
 * prompt: health-check не повинен витрачати токени або створювати сесію.
 * @param {any} actual
 * @returns {{ state: 'ready' | 'degraded' | 'unready', detail: string }}
 */
function modelReadinessFromHealth(actual) {
  const rawModels = /** @type {unknown[]} */ (
    Array.isArray(actual?.limits?.models) ? actual.limits.models : []
  );
  const models = [...new Set(rawModels.filter((m) => typeof m === 'string' && m.length <= 128))]
    .slice(0, 8)
    .map((m) => String(m).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (models.length === 0) {
    return { state: 'unready', detail: 'health не містить жодної profile-моделі' };
  }
  if (!actual?.sdkVersion || !actual?.claudeVersion) {
    return { state: 'unready', detail: 'Claude SDK або CLI не підтверджено health-пробою' };
  }
  if (actual.internalApiProbe !== 'ok') {
    return {
      state: 'degraded',
      detail: `моделі: ${models.join(', ')}; внутрішній API: ${String(actual.internalApiProbe ?? 'невідомо')}`,
    };
  }
  return { state: 'ready', detail: `моделі: ${models.join(', ')}` };
}

/**
 * Порівняти канонічний /health з очікуваним (чиста функція).
 * @param {{ version?: string, gitSha?: string } | null} expected
 * @param {{ version?: string, gitSha?: string } | null} actual
 * @returns {{ state: 'ok' | 'desync', detail: string }}
 */
export function compareBrainVersions(expected, actual) {
  if (!expected) return { state: 'ok', detail: 'деплоїв ще не було (brainExpected порожній)' };
  if (!actual?.version || !actual?.gitSha) {
    return { state: 'desync', detail: 'health без version/gitSha - контракт 07 §3 порушено' };
  }
  if (expected.gitSha && actual.gitSha !== expected.gitSha) {
    return {
      state: 'desync',
      detail: `gitSha: очікував ${String(expected.gitSha).slice(0, 12)}, живе ${String(actual.gitSha).slice(0, 12)}`,
    };
  }
  if (expected.version && actual.version !== expected.version) {
    return {
      state: 'desync',
      detail: `version: очікував ${expected.version}, живе ${actual.version}`,
    };
  }
  return { state: 'ok', detail: `${actual.version} @ ${String(actual.gitSha).slice(0, 12)}` };
}

/**
 * Тік handshake. До появи мозку (BRAIN_URL не заданий) - тихий no-op: на
 * етапі 1 його відсутність - норма, не помилка конфігурації.
 * @param {Env} env
 * @param {number} [nowMs]
 * @returns {Promise<{ skipped: string } | { state: string, alerted: boolean }>}
 */
export async function checkBrainHandshake(env, nowMs = Date.now()) {
  const url = String(env.BRAIN_URL ?? '').trim();
  if (!url) return { skipped: 'not-configured' };

  const clientId = String(env.BRAIN_ACCESS_CLIENT_ID ?? '').trim();
  const clientSecret = String(env.BRAIN_ACCESS_CLIENT_SECRET ?? '').trim();
  /** @type {{ state: 'ok' | 'desync' | 'down', detail: string, modelReadiness?: { state: 'ready' | 'degraded' | 'unready', detail: string } }} */
  let observed;
  if (!clientId || !clientSecret) {
    // URL заданий, а креденшлів Access немає - це ВЖЕ misconfig, кажемо як down.
    observed = { state: 'down', detail: 'BRAIN_ACCESS_CLIENT_ID/SECRET не задані' };
  } else {
    observed = await probeHealth(env, url, clientId, clientSecret);
  }

  const prev = await readBrainHealthState(env);
  // down-стан порівнюємо ЛИШЕ за станом: текст мережевої помилки мінливий
  // (timeout ↔ refused), і алерт на кожну зміну формулювання - той самий спам,
  // від якого дедуп і рятує. Для desync detail значущий (інший sha = інший
  // розсинхрон).
  const changed =
    prev?.state !== observed.state ||
    (observed.state === 'desync' && prev?.detail !== observed.detail);
  let alerted = false;
  if (changed) {
    const text = alertText(prev?.state ?? null, observed);
    if (text && env.TELEGRAM_CHAT_ID) {
      // Enqueue ПЕРЕД записом стану: якщо покласти в чергу не вдалось, стан
      // лишається старим і наступний тік повторить спробу - інакше перехід
      // «згорів» би без алерту назавжди. Drain - best-effort (добере sweeper).
      await enqueueOutbox(
        env,
        {
          chatId: env.TELEGRAM_CHAT_ID,
          threadId: env.TOPIC_SYSTEM ?? null,
          kind: 'send',
          payload: { text },
        },
        nowMs,
      );
      alerted = true;
    }
    if (alerted) await drainOutbox(env, { nowMs }).catch(() => {});
  }
  // Мітку оновлюємо НА КОЖНІЙ пробі, не лише на переході. Інакше KV містив би
  // вічне «ok» з першого тіку, а /status не зміг би відрізнити живий мозок від
  // зупиненого scheduler-а. Відмова запису тут чесніша за стару мітку: status
  // покаже її застарілою через BRAIN_HEALTH_STALE_MS.
  await env.BRIEFING.put(
    BRAIN_HEALTH_STATE_KEY,
    JSON.stringify({ ...observed, checkedAtMs: nowMs }),
  );
  return { state: observed.state, alerted };
}

/**
 * @param {Env} env
 * @param {string} url
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<{ state: 'ok' | 'desync' | 'down', detail: string, modelReadiness?: { state: 'ready' | 'degraded' | 'unready', detail: string } }>}
 */
async function probeHealth(env, url, clientId, clientSecret) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      headers: {
        'CF-Access-Client-Id': clientId,
        'CF-Access-Client-Secret': clientSecret,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) return { state: 'down', detail: `health HTTP ${res.status}` };
    const actual = /** @type {any} */ (await res.json().catch(() => null));
    const expected = await readExpected(env);
    return {
      ...compareBrainVersions(expected, actual),
      modelReadiness: modelReadinessFromHealth(actual),
    };
  } catch (/** @type {any} */ e) {
    return { state: 'down', detail: `health недосяжний: ${String(e?.message ?? 'мережа')}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Очікувані version/gitSha мозку з KV (пише deploy-host.yml). Експорт - для
 *  /status prerouter-а: літерал ключа поза цим модулем дрейфував би мовчки.
 *  @param {Env} env */
export async function readExpected(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get(BRAIN_EXPECTED_KEY)) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Останній запис проби. Легасі-запис без checkedAtMs повертаємо як є: snapshot
 * нижче позначить його stale, а не скаже «ok» лише тому, що старий ключ існує.
 * @param {Env} env
 * @returns {Promise<{ state: 'ok' | 'desync' | 'down', detail: string, checkedAtMs?: number, modelReadiness?: { state: 'ready' | 'degraded' | 'unready', detail: string } } | null>}
 */
export async function readBrainHealthState(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get(BRAIN_HEALTH_STATE_KEY)) ?? 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    const state = /** @type {any} */ (parsed).state;
    const detail = /** @type {any} */ (parsed).detail;
    if (!['ok', 'desync', 'down'].includes(state) || typeof detail !== 'string') return null;
    const checkedAtMs = Number(/** @type {any} */ (parsed).checkedAtMs);
    const readiness = /** @type {any} */ (parsed).modelReadiness;
    const modelReadiness =
      readiness &&
      ['ready', 'degraded', 'unready'].includes(readiness.state) &&
      typeof readiness.detail === 'string'
        ? { state: readiness.state, detail: readiness.detail }
        : undefined;
    return Number.isFinite(checkedAtMs)
      ? { state, detail, checkedAtMs, modelReadiness }
      : { state, detail, modelReadiness };
  } catch {
    return null;
  }
}

/**
 * Поточна правда для owner-facing status. `BRAIN_URL` означає лише
 * «налаштовано»; до свіжої проби мозок лишається unknown, а не healthy.
 * @param {Env} env
 * @param {number} [nowMs]
 * @returns {Promise<
 *   | { state: 'not-configured', detail: string, modelReadiness?: { state: string, detail: string } }
 *   | { state: 'unknown', detail: string, modelReadiness?: { state: string, detail: string } }
 *   | { state: 'stale', detail: string, checkedAtMs?: number, ageMs?: number, modelReadiness?: { state: string, detail: string } }
 *   | { state: 'ok' | 'desync' | 'down', detail: string, checkedAtMs: number, ageMs: number, modelReadiness?: { state: string, detail: string } }
 * >}
 */
export async function brainHealthSnapshot(env, nowMs = Date.now()) {
  if (!String(env.BRAIN_URL ?? '').trim()) {
    return { state: 'not-configured', detail: 'BRAIN_URL не задано' };
  }
  const observed = await readBrainHealthState(env);
  if (!observed) return { state: 'unknown', detail: 'ще немає результату health-проби' };
  if (observed.checkedAtMs == null) {
    return { state: 'stale', detail: 'старий запис health без мітки часу' };
  }
  const ageMs = nowMs - observed.checkedAtMs;
  // Сильно майбутня мітка теж не може підтверджувати здоров'я: це або clock
  // skew, або пошкоджений запис, і обидва випадки треба показати власнику.
  if (ageMs > BRAIN_HEALTH_STALE_MS || ageMs < -BRAIN_HEALTH_STALE_MS) {
    return {
      state: 'stale',
      detail: observed.detail,
      checkedAtMs: observed.checkedAtMs,
      ageMs,
      modelReadiness: observed.modelReadiness,
    };
  }
  return { ...observed, checkedAtMs: observed.checkedAtMs, ageMs };
}

/**
 * Текст алерту за переходом стану; null = перехід без повідомлення (перший
 * запис «ok» - нема про що казати).
 * @param {string | null} prevState
 * @param {{ state: string, detail: string }} observed
 */
function alertText(prevState, observed) {
  if (observed.state === 'desync') return `⚠️ Мозок: розсинхрон версій - ${observed.detail}`;
  if (observed.state === 'down') return `⚠️ Мозок: недоступний - ${observed.detail}`;
  if (prevState && prevState !== 'ok') return `✅ Мозок: знову в нормі (${observed.detail})`;
  return null;
}
