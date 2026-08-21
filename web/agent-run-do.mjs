// Durable Object прогону асистента (Фаза 4 аудиту): авторитетний лічильник
// кроків замість best-effort надгробка в KV.
//
// НАВІЩО ОКРЕМИЙ ФАЙЛ. Це єдине місце проєкту, що імпортує `cloudflare:workers`
// — вбудований модуль workerd, якого в Node немає. Тримати його осторонь від
// чистих модулів дешевше, ніж пояснювати кожному читачеві, чому worker.js
// раптом не імпортується в скрипті. У тестах модуль підмінено заглушкою
// (vitest.config.ts), яка робить те саме, що справжній базовий клас: кладе
// ctx/env на this.
//
// ЧОГО ТУТ НЕМАЄ. Знання про Telegram, KV, пошту й самі дії агента. DO знає
// рівно одне: який крок цього прогону вже виконано і чи прогін завершено.
// Правило ухвали живе в agent-run-core (decideStepClaim) — його тестують без
// платформи взагалі.

import { DurableObject } from 'cloudflare:workers';
import { decideStepClaim, AGENT_RUN_DO_KEEP_MS } from './agent-run-core.mjs';

/** @typedef {import('./agent-run-core.mjs').AgentRunState} AgentRunState */

/** Один ключ — увесь стан прогону: {lastStep, finishedMs}. Обсяг такий, що
 *  SQL-таблиця була б порожньою церемонією (KV-API сховища DO на
 *  SQLite-бекенді підтримується й лишається найпростішим). */
const STATE_KEY = 'run';

export class AgentRun extends DurableObject {
  /**
   * Зайняти крок: {ok:true} | {ok:false,error}. Read-modify-write тут
   * атомарний — DO серіалізує виклики, і саме це закриває реплей, якого
   * підписаний токен закрити не міг.
   * @param {number} step
   * @param {number} nowMs
   */
  async claimStep(step, nowMs) {
    const state = /** @type {AgentRunState|null} */ (
      (await this.ctx.storage.get(STATE_KEY)) ?? null
    );
    const decision = decideStepClaim(state, step);
    if (!decision.ok) return { ok: false, error: decision.error };
    await this.ctx.storage.put(STATE_KEY, { ...decision.state, touchedMs: nowMs });
    await this.ctx.storage.setAlarm(nowMs + AGENT_RUN_DO_KEEP_MS);
    return { ok: true };
  }

  /**
   * Надгробок. На відміну від KV-марки, видно ОДРАЗУ й наступному кроку — тобто
   * найтихіший сценарій зловживання (обмін для власника візуально завершився, а
   * тим самим токеном далі качають пошту) закривається не «здебільшого».
   * @param {number} nowMs
   */
  async finish(nowMs) {
    const state = /** @type {AgentRunState} */ ((await this.ctx.storage.get(STATE_KEY)) ?? {});
    await this.ctx.storage.put(STATE_KEY, { ...state, finishedMs: nowMs });
    await this.ctx.storage.setAlarm(nowMs + AGENT_RUN_DO_KEEP_MS);
  }

  /** Прибрати за собою: після смерті токена стан нікому не потрібен, а без
   *  цього кожен прогін лишав би вічний запис у сховищі.
   *  @override */
  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
