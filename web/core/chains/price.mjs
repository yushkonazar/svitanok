// PriceTrack (07 §6, S-5-11/S-5-12, етап 5 PR-3): ланцюг «відстежуй ціну»
// для бажання purchase з url. Щодня - прогін профілю `price-check` у мозку
// (інструкція Дослідника, WebSearch/WebFetch), його звіт «## Ціни» парсить
// ядро → price_points; ціна ≤ target або на ≥ 5 % нижча за попередню -
// повідомлення з кнопкою «Стоп». Один тип події `price` з action stop/cancel
// (від кнопки, wishes.update(status) чи chain.cancel) і подія `worker` від
// мозку (/internal/runs outcome.chain). Мозок недоступний або звіт без ціни -
// пропуск дня з логом, три поспіль - алерт у TOPIC_SYSTEM (S-5-12). Імена
// кроків - з індексом дня: Workflow відтворює код з початку після кожного
// пробудження. Через 180 днів - завершення з повідомленням.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { kyivHour, kyivDateKey } from '../../kyiv-time.mjs';
import { enqueueOutbox, drainOutbox, sendSystemAlert } from '../tg/outbox.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import { registryBegin, registryFinish } from '../run-registry/client.mjs';
import { callBrainRun } from '../brain/run-client.mjs';
import { loadInstruction } from '../instructions.mjs';
import { patchChainState, readChainState, waitOrNull } from './state.mjs';
import { sendChainEvent } from './registry.mjs';

export const CHAIN_KIND = 'price';
export const PRICE_CHECK_PROFILE = 'price-check';
/** Інструкція профілю - Дослідник (07 §5 price-check → agents/researcher.md). */
export const PRICE_CHECK_INSTRUCTION = 'researcher';
export const PRICE_CHECK_MODEL = 'claude-sonnet-5';
/** Звіт Дослідника - до 10 хв (профіль 4 хв + черга мозку). */
export const WAIT_CHECK_MS = 10 * 60_000;
export const DAY_MS = 24 * 3_600_000;
/** Стеля днів відстеження: далі - повідомлення й done (власник поновлює словом). */
export const MAX_DAYS = 180;
/** Поріг «ціна впала» (S-5-11: −5 %). */
export const DROP_RATIO = 0.05;
/** Пропусків поспіль до алерту (S-5-12: «3 дні поспіль - алерт»). */
export const MISSES_ALERT = 3;
export const PRICE_TRACK_KICK_MARKER_KEY = 'priceTrackKickDay';
export const PRICE_TRACK_KICK_HOUR = 9;

/**
 * @typedef {{ source: string, price: number, currency: string, in_stock: boolean, url: string | null }} PricePoint
 * @typedef {{
 *   now: () => number,
 *   startCheck: (task: string) => Promise<boolean>,
 *   send: (text: string, buttons?: { text: string, callback_data: string }[][]) => Promise<void>,
 *   alert: (text: string) => Promise<void>,
 * }} PriceIo
 * @typedef {{
 *   do: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} PriceStep
 * @typedef {{ wish_id: string, title: string, url: string, target_price: number | null, currency: string,
 *   chat_id: number | string | null, thread_id: string | null, awaiting: string | null,
 *   misses?: number, last_price?: number | null }} PriceState
 * @typedef {{ chainId: string, state?: PriceState }} PriceParams
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - ланцюг недоступний');
  return env.DB;
}

// ── Гроші й звіт Дослідника ────────────────────────────────────────────────

const CURRENCY_LABEL = /** @type {Record<string, string>} */ ({
  UAH: 'грн',
  USD: '$',
  EUR: '€',
  PLN: 'zł',
});

/** 329950 UAH → «3 299,50 грн»; 329900 → «3 299 грн». @param {number} minor @param {string} currency */
export function formatMoney(minor, currency) {
  const abs = Math.abs(Math.round(minor));
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const cents = abs % 100;
  const num = `${minor < 0 ? '−' : ''}${whole}${cents ? `,${String(cents).padStart(2, '0')}` : ''}`;
  return `${num} ${CURRENCY_LABEL[currency] ?? currency}`;
}

const CURRENCY_TOKENS = /** @type {[RegExp, string][]} */ ([
  [/грн|uah|₴/i, 'UAH'],
  [/\$|usd/i, 'USD'],
  [/€|eur/i, 'EUR'],
  [/zł|pln/i, 'PLN'],
]);

/** «3 299 грн» / «3299.50 UAH» / «$12,99» → {price (копійки), currency}; null - не ціна. @param {string} text */
export function parsePrice(text) {
  const currency = CURRENCY_TOKENS.find(([re]) => re.test(text))?.[1] ?? null;
  const m = text.replace(/\s/g, '').match(/\d+(?:[.,]\d{1,2})?/);
  if (!m || !currency) return null;
  const n = Number(m[0].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  return { price: Math.round(n * 100), currency };
}

/**
 * Розділ «## Ціни» звіту Дослідника (researcher.md «Формат відповіді»):
 * «- <Магазин> - <ціна> <валюта> - <наявність> - <дата> - <URL>». Рядки без
 * ціни або валюти пропускаються. Від найнижчої.
 * @param {string} text
 * @returns {PricePoint[]}
 */
export function parsePriceReport(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const from = lines.findIndex((l) => /^##\s*Ціни/i.test(l.trim()));
  if (from < 0) return [];
  /** @type {PricePoint[]} */
  const out = [];
  for (const raw of lines.slice(from + 1)) {
    const line = raw.trim();
    if (/^##\s/.test(line)) break;
    if (!line.startsWith('-')) continue;
    const parts = line
      .replace(/^-\s*/, '')
      .split(/\s+-\s+/)
      .map((p) => p.trim());
    if (parts.length < 3) continue;
    const parsed = parsePrice(parts[1] ?? '');
    if (!parsed) continue;
    const url = parts.find((p) => /^https?:\/\//i.test(p)) ?? null;
    const availability = parts[2] ?? '';
    out.push({
      source: (parts[0] ?? '').slice(0, 80),
      price: parsed.price,
      currency: parsed.currency,
      in_stock: !/нема|відсутн|unknown|під замовлення/i.test(availability),
      url: url ? url.slice(0, 500) : null,
    });
  }
  return out.sort((a, b) => a.price - b.price);
}

/** Найкраща ціна: найнижча з наявних, інакше найнижча взагалі. @param {PricePoint[]} points */
export function pickBest(points) {
  return points.find((p) => p.in_stock) ?? points[0] ?? null;
}

/** Задача Дослідникові (researcher.md «Що отримує»). @param {PriceState} state */
export function checkTask(state) {
  return (
    `Ціна товару «${state.title}» - спершу сторінка ${state.url}, далі ті самі товар/модель у 3-5 магазинах України ` +
    `(rozetka.com.ua, comfy.ua, allo.ua, foxtrot.com.ua, eldorado.ua): ціна як на сторінці, валюта, наявність, дата, URL. ` +
    `Лише ціни з відкритих сторінок, без прогнозів і без конвертації.`
  );
}

// ── Старт / зупинка ────────────────────────────────────────────────────────

/**
 * Активний ланцюг ціни за id ланцюга або бажання.
 * @param {Env} env @param {{ chainId?: string | null, wishId?: string | null }} q
 */
export async function findActivePriceChain(env, q) {
  const row = /** @type {{ id: string, state_json: string } | null} */ (
    q.chainId
      ? await db(env)
          .prepare(
            `SELECT id, state_json FROM chains WHERE id = ? AND kind = ? AND status IN ('running', 'waiting')`,
          )
          .bind(q.chainId, CHAIN_KIND)
          .first()
      : q.wishId
        ? await db(env)
            .prepare(
              `SELECT id, state_json FROM chains WHERE kind = ? AND status IN ('running', 'waiting')
                 AND json_extract(state_json, '$.wish_id') = ? ORDER BY created_at DESC LIMIT 1`,
            )
            .bind(CHAIN_KIND, q.wishId)
            .first()
        : await db(env)
            .prepare(
              `SELECT id, state_json FROM chains WHERE kind = ? AND status IN ('running', 'waiting') ORDER BY created_at DESC LIMIT 1`,
            )
            .bind(CHAIN_KIND)
            .first()
  );
  if (!row) return null;
  let title = '';
  let wishId = '';
  try {
    const st = JSON.parse(row.state_json ?? '{}');
    title = String(st?.title ?? '');
    wishId = String(st?.wish_id ?? '');
  } catch {
    /* битий стан - назви немає */
  }
  return { id: String(row.id), title, wishId };
}

/**
 * Старт ланцюга для бажання (S-5-11). Активний уже є - повертає його
 * (дедуп: другий Workflow слав би дві перевірки на день).
 * @param {Env} env
 * @param {{ id: string, title: string, url: string, target_price: number | null, currency: string }} wish
 * @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx
 */
export async function startPriceTrack(env, wish, nowMs, ctx) {
  if (!env.PRICE_TRACK) throw new Error('привʼязки PRICE_TRACK (Workflow) немає');
  const existing = await findActivePriceChain(env, { wishId: wish.id });
  if (existing) return { chainId: existing.id, existing: true };
  const chainId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  /** @type {PriceState} */
  const state = {
    wish_id: wish.id,
    title: wish.title,
    url: wish.url,
    target_price: wish.target_price ?? null,
    currency: wish.currency,
    chat_id: ctx.chatId ?? null,
    thread_id: ctx.threadId == null ? null : String(ctx.threadId),
    awaiting: null,
    misses: 0,
    last_price: null,
  };
  await db(env)
    .prepare(
      `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`,
    )
    .bind(chainId, CHAIN_KIND, chainId, JSON.stringify(state), iso, iso)
    .run();
  try {
    await env.PRICE_TRACK.create({ id: chainId, params: { chainId } });
  } catch (/** @type {any} */ e) {
    await patchChainState(env, chainId, 'failed', { awaiting: null }, { nowMs });
    throw new Error(`Workflow відстеження не стартував: ${String(e?.message ?? e)}`, {
      cause: e,
    });
  }
  return { chainId, existing: false };
}

/**
 * Зупинка (кнопка «Стоп», wishes.update(status), chain.cancel, «↩»): статус
 * cancelled + подія stop; не доставилась - машина побачить cancelled на
 * наступному записі стану. false - активного ланцюга для бажання немає.
 * @param {Env} env @param {string} wishId @param {number} nowMs
 */
export async function cancelPriceTrack(env, wishId, nowMs) {
  const active = await findActivePriceChain(env, { wishId });
  if (!active) return false;
  return cancelPriceChain(env, active.id, nowMs);
}

/** @param {Env} env @param {string} chainId @param {number} nowMs */
export async function cancelPriceChain(env, chainId, nowMs) {
  const { meta } = await db(env)
    .prepare(
      `UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ? AND kind = ? AND status IN ('running', 'waiting')`,
    )
    .bind(new Date(nowMs).toISOString(), chainId, CHAIN_KIND)
    .run();
  if (!meta?.changes) return false;
  try {
    await sendChainEvent(env, chainId, 'price', { action: 'stop' });
  } catch (/** @type {any} */ e) {
    console.error(
      `price-track ${chainId}: подія stop не доставлена (закриє наступний запис стану)`,
      e?.message,
    );
  }
  return true;
}

/** @param {Env} env @param {string} chainId @returns {Promise<PriceState>} */
export async function loadPriceState(env, chainId) {
  const row = await readChainState(env, chainId);
  if (!row) throw new Error(`ланцюга ${chainId} немає`);
  return /** @type {PriceState} */ (row.state);
}

// ── Машина станів ──────────────────────────────────────────────────────────

class Stopped extends Error {}

/**
 * Записати точку ціни; is_low = не вище за мінімум досі. Повертає попередню
 * і найнижчу ціну ДО запису (для порогів).
 * @param {Env} env @param {string} wishId @param {PricePoint} p @param {number} nowMs
 */
export async function savePricePoint(env, wishId, p, nowMs) {
  const stats = /** @type {{ last_price: number | null, min_price: number | null } | null} */ (
    await db(env)
      .prepare(
        `SELECT (SELECT price FROM price_points WHERE wish_id = ? ORDER BY at DESC LIMIT 1) AS last_price,
                (SELECT MIN(price) FROM price_points WHERE wish_id = ?) AS min_price`,
      )
      .bind(wishId, wishId)
      .first()
  );
  const prev = stats?.last_price == null ? null : Number(stats.last_price);
  const min = stats?.min_price == null ? null : Number(stats.min_price);
  const isLow = min == null || p.price <= min;
  await db(env)
    .prepare(
      `INSERT INTO price_points (id, wish_id, at, source, price, currency, url, is_low) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      wishId,
      new Date(nowMs).toISOString(),
      p.source,
      p.price,
      p.currency,
      p.url,
      isLow ? 1 : 0,
    )
    .run();
  return { prev, min, isLow };
}

/**
 * Що сказати власнику (null - мовчати): перша ціна - один раз; далі лише
 * ≤ target або падіння ≥ 5 % проти попередньої перевірки.
 * @param {PriceState} state @param {PricePoint} best @param {{ prev: number | null, min: number | null }} stats
 */
export function priceVerdict(state, best, stats) {
  const money = (/** @type {number} */ v) => formatMoney(v, best.currency);
  const where = `${best.source}${best.url ? `: ${best.url}` : ''}`;
  if (stats.prev == null) {
    return `Перша ціна «${state.title}»: ${money(best.price)} (${where}). Стежу далі.`;
  }
  if (state.target_price != null && best.price <= state.target_price) {
    return `🎯 «${state.title}» - ${money(best.price)}, не дорожче цільових ${money(state.target_price)} (${where}).`;
  }
  if (best.price <= stats.prev * (1 - DROP_RATIO)) {
    const pct = Math.round((1 - best.price / stats.prev) * 100);
    return `📉 «${state.title}» подешевшало: ${money(best.price)} (−${pct} % від ${money(stats.prev)}${stats.min != null && best.price <= stats.min ? ', мінімум за весь час' : ''}) - ${where}.`;
  }
  return null;
}

/**
 * @param {Env} env
 * @param {PriceParams} params
 * @param {PriceStep} step
 * @param {PriceIo} io
 */
export async function runPriceTrack(env, params, step, io) {
  const { chainId } = params;
  const state = params.state ?? (await step.do('state', () => loadPriceState(env, chainId)));
  const stopBtn = [[{ text: '⏹ Стоп', callback_data: `c:${chainId}:stop` }]];
  /** Запис стану, що шанує cancelled (зупинка без доставленої події). @param {string} label @param {'running' | 'waiting'} status @param {Record<string, unknown>} patch */
  const write = async (label, status, patch) => {
    const ok = await step.do(label, () =>
      patchChainState(env, chainId, status, patch, { unlessCancelled: true, nowMs: io.now() }),
    );
    if (!ok) throw new Stopped();
  };
  let misses = Number(state.misses) || 0;
  try {
    for (let d = 0; d < MAX_DAYS; d += 1) {
      const label = `d${d}`;
      await write(`${label}-run`, 'running', { awaiting: null, day: d });
      const started = await step.do(`${label}-start`, () => io.startCheck(checkTask(state)));
      const ev = started ? await waitOrNull(step, `${label}-wait`, 'worker', WAIT_CHECK_MS) : null;
      const report = typeof ev?.output === 'string' ? ev.output : '';
      const best = pickBest(parsePriceReport(report));
      if (best) {
        misses = 0;
        const stats = await step.do(`${label}-save`, () =>
          savePricePoint(env, state.wish_id, best, io.now()),
        );
        const verdict = priceVerdict(state, best, stats);
        if (verdict) await step.do(`${label}-notify`, () => io.send(verdict, stopBtn));
      } else {
        misses += 1;
        console.error(
          `price-track ${chainId}: день ${d} без ціни (${started ? (ev ? 'звіт без «## Ціни»' : 'мозок не відповів') : 'прогін не стартував'})`,
        );
        if (misses === MISSES_ALERT) {
          await step.do(`${label}-alert`, () =>
            io.alert(
              `Відстеження ціни «${state.title}»: ${MISSES_ALERT} дні поспіль без ціни (мозок/Дослідник). Ланцюг живе, перевірю завтра.`,
            ),
          );
        }
      }
      // Доба - як очікування події stop: кнопка або chain.cancel будять одразу.
      await write(`${label}-sleep-state`, 'waiting', {
        awaiting: null,
        misses,
        last_price: best?.price ?? state.last_price ?? null,
      });
      const stop = await waitOrNull(step, `${label}-sleep`, 'price', DAY_MS);
      if (stop?.action === 'stop' || stop?.action === 'cancel') throw new Stopped();
    }
    await step.do('expire-state', () =>
      patchChainState(env, chainId, 'done', { awaiting: null }, { nowMs: io.now() }),
    );
    await step.do('expire-text', () =>
      io.send(
        `Відстеження «${state.title}» завершено після ${MAX_DAYS} днів. Скажи «відстежуй далі», якщо ще актуально.`,
      ),
    );
    return { outcome: 'expired' };
  } catch (e) {
    if (e instanceof Stopped) {
      await step.do('stopped-state', () =>
        patchChainState(env, chainId, 'cancelled', { awaiting: null }, { nowMs: io.now() }),
      );
      await step.do('stopped-text', () => io.send(`Зупинив відстеження «${state.title}».`));
      return { outcome: 'cancelled' };
    }
    throw e;
  }
}

// ── Бойове io ──────────────────────────────────────────────────────────────

/**
 * Прогін профілю price-check у мозку (як startDayPlannerRun): інструкція
 * Дослідника з D1, вхід JSON {chain_id, mode, task, format}; результат
 * повернеться подією `worker` через /internal/runs outcome.chain.
 * @param {Env} env @param {{ chainId: string, task: string }} req @param {number} nowMs
 */
export async function startPriceCheckRun(env, req, nowMs) {
  let instruction;
  try {
    const loaded = await loadInstruction(env, PRICE_CHECK_INSTRUCTION);
    instruction = { name: loaded.name, version_hash: loaded.hash, body_md: loaded.body };
  } catch (/** @type {any} */ e) {
    console.error('price-track: інструкція researcher недоступна', e?.message);
    return false;
  }
  const runId = crypto.randomUUID();
  const threadId = env.TOPIC_ASSISTANT ? String(env.TOPIC_ASSISTANT) : 'dm';
  await registryBegin(env, {
    id: runId,
    trigger: 'workflow',
    profile: PRICE_CHECK_PROFILE,
    threadId,
    chatId: env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null,
    model: PRICE_CHECK_MODEL,
    startedMs: nowMs,
  });
  const res = await callBrainRun(
    env,
    {
      instruction,
      runId,
      profile: PRICE_CHECK_PROFILE,
      threadId,
      inputText: JSON.stringify({
        chain_id: req.chainId,
        mode: 'price',
        task: req.task,
        format: 'chat',
      }),
    },
    nowMs,
  );
  if (res.ok) return true;
  console.error(`price-track: прогін price-check не стартував (${res.status} ${res.detail})`);
  await registryFinish(env, runId, { finishedMs: nowMs, error: `brain-start: ${res.status}` });
  return false;
}

/**
 * @param {Env} env @param {string} chainId @param {PriceState} state
 * @returns {PriceIo}
 */
export function productionIo(env, chainId, state) {
  const isDm = state.thread_id === 'dm';
  const chatId =
    state.chat_id ?? (isDm ? (env.TELEGRAM_OWNER_USER_ID ?? null) : (env.TELEGRAM_CHAT_ID ?? null));
  if (chatId == null)
    throw new Error('немає чату для ланцюга (TELEGRAM_CHAT_ID / контекст старту)');
  const threadId = isDm ? null : (state.thread_id ?? env.TOPIC_ASSISTANT ?? null);
  return {
    now: () => Date.now(),
    startCheck: (task) => startPriceCheckRun(env, { chainId, task }, Date.now()),
    send: async (text, btns) => {
      await enqueueOutbox(
        env,
        {
          chatId,
          threadId,
          kind: 'send',
          parts: renderMdParts(text),
          payload: btns ? { reply_markup: { inline_keyboard: btns } } : {},
        },
        Date.now(),
      );
      await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
        console.error(`price-track ${chainId}: драйн outbox впав, доставить sweeper`, e?.message);
      });
    },
    alert: async (text) => void (await sendSystemAlert(env, text, Date.now())),
  };
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class PriceTrack extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<PriceParams>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {PriceParams} */ (event.payload);
    try {
      const state = await step.do('state', () => loadPriceState(env, params.chainId));
      return await runPriceTrack(
        env,
        { ...params, state },
        step,
        productionIo(env, params.chainId, state),
      );
    } catch (/** @type {any} */ e) {
      console.error(`price chain ${params.chainId} впав`, e?.message);
      await patchChainState(env, params.chainId, 'failed', { awaiting: null }).catch(
        (/** @type {any} */ e2) =>
          console.error(`price chain ${params.chainId}: статус failed не записано`, e2?.message),
      );
      throw e;
    }
  }
}

// ── Задача price-track-kick (07 §7) ────────────────────────────────────────

/**
 * Щодня о 09:00 Києва: активні бажання purchase з url без активного ланцюга
 * (Workflow упав, привʼязка зʼявилась після створення) → старт. Мітка доби в KV.
 * @param {Env} env @param {number} [nowMs]
 */
export async function priceTrackKickTask(env, nowMs = Date.now()) {
  const now = new Date(nowMs);
  if (kyivHour(now) !== PRICE_TRACK_KICK_HOUR) return { skipped: 'hour' };
  const today = kyivDateKey(now);
  if ((await env.BRIEFING.get(PRICE_TRACK_KICK_MARKER_KEY)) === today) return { skipped: 'done' };
  if (!env.DB || !env.PRICE_TRACK) return { skipped: 'no-binding' };
  const { results } = await db(env)
    .prepare(
      `SELECT w.id, w.title, w.payload_json FROM wishes w
       WHERE w.type = 'purchase' AND w.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM chains c WHERE c.kind = ? AND c.status IN ('running', 'waiting')
                         AND json_extract(c.state_json, '$.wish_id') = w.id)`,
    )
    .bind(CHAIN_KIND)
    .all();
  const started = [];
  for (const r of results ?? []) {
    /** @type {Record<string, any>} */
    let payload;
    try {
      payload = r.payload_json ? JSON.parse(String(r.payload_json)) : {};
    } catch {
      payload = {};
    }
    if (typeof payload.url !== 'string' || !payload.url) continue;
    try {
      const out = await startPriceTrack(
        env,
        {
          id: String(r.id),
          title: String(r.title ?? ''),
          url: payload.url,
          target_price: payload.target_price ?? null,
          currency: String(payload.currency ?? 'UAH'),
        },
        nowMs,
        {},
      );
      started.push(out.chainId);
    } catch (/** @type {any} */ e) {
      console.error(`price-track-kick: бажання ${String(r.id)} не стартувало`, e?.message);
    }
  }
  await env.BRIEFING.put(PRICE_TRACK_KICK_MARKER_KEY, today);
  return { started: started.length };
}
