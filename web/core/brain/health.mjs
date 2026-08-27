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
const STATE_KEY = 'brainHealthState';
const HEALTH_TIMEOUT_MS = 8_000;

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
  /** @type {{ state: 'ok' | 'desync' | 'down', detail: string }} */
  let observed;
  if (!clientId || !clientSecret) {
    // URL заданий, а креденшлів Access немає - це ВЖЕ misconfig, кажемо як down.
    observed = { state: 'down', detail: 'BRAIN_ACCESS_CLIENT_ID/SECRET не задані' };
  } else {
    observed = await probeHealth(env, url, clientId, clientSecret);
  }

  const prev = await readState(env);
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
    await env.BRIEFING.put(STATE_KEY, JSON.stringify(observed));
    if (alerted) await drainOutbox(env, { nowMs }).catch(() => {});
  }
  return { state: observed.state, alerted };
}

/**
 * @param {Env} env
 * @param {string} url
 * @param {string} clientId
 * @param {string} clientSecret
 * @returns {Promise<{ state: 'ok' | 'desync' | 'down', detail: string }>}
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
    return compareBrainVersions(expected, actual);
  } catch (/** @type {any} */ e) {
    return { state: 'down', detail: `health недосяжний: ${String(e?.message ?? 'мережа')}` };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {Env} env */
async function readExpected(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get(BRAIN_EXPECTED_KEY)) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** @param {Env} env @returns {Promise<{ state: string, detail: string } | null>} */
async function readState(env) {
  try {
    const parsed = JSON.parse((await env.BRIEFING.get(STATE_KEY)) ?? 'null');
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
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
