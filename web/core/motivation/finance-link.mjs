import { readFinanceWorkspace } from '../finance/workspace.mjs';
import { financeForecast } from '../../app/src/lib/financeForecast.ts';
import { executePlanCommand, readPlanState } from './store.mjs';
import { planRecords } from './model.mjs';

/** Both views use the identical deterministic cashflow calculation.
 * @param {Env} env @param {any} reward @param {number} nowMs @param {any} [snapshot] */
export async function checkRewardMoney(env, reward, nowMs, snapshot) {
  try {
    const finance = snapshot ?? (await readFinanceWorkspace(env, nowMs));
    const outlook = financeForecast(
      /** @type {any} */ (finance),
      reward.purchase.horizonDays,
      nowMs,
    );
    const required = reward.purchase.amountMinor + reward.purchase.bufferMinor;
    const ready =
      outlook.currentSafe != null &&
      outlook.conservativeResult != null &&
      outlook.currentSafe >= required &&
      outlook.conservativeResult >= required;
    return {
      ready,
      requiredMinor: required,
      currentSafeMinor: outlook.currentSafe,
      projectedMinor: outlook.conservativeResult,
      horizonDays: reward.purchase.horizonDays,
      checkedAt: new Date(nowMs).toISOString(),
      reason: ready
        ? 'Кошти зараз і консервативний сценарій покривають зазначену суму та резерв.'
        : outlook.incomplete
          ? 'Спершу уточни неповні фінансові дані.'
          : 'Після відомих витрат і резервів ще недостатньо реальних коштів. Прогноз доходу не відкриває покупку авансом.',
    };
  } catch {
    return {
      ready: false,
      reason: 'Фінансову готовність зараз неможливо перевірити. Онови фінанси.',
      checkedAt: new Date(nowMs).toISOString(),
    };
  }
}
/** One coherent finance snapshot for all reward cards.
 * @param {Env} env @param {any[]} rewards @param {number} nowMs */
export async function annotatePlanRewards(env, rewards, nowMs) {
  let snapshot;
  try {
    snapshot = await readFinanceWorkspace(env, nowMs);
  } catch {
    return rewards.map((reward) => ({
      ...reward,
      affordability: reward.purchase
        ? {
            ready: false,
            reason: 'Фінансові дані тимчасово недоступні. Онови фінанси.',
            checkedAt: new Date(nowMs).toISOString(),
          }
        : null,
    }));
  }
  return Promise.all(
    rewards.map(async (reward) => ({
      ...reward,
      affordability: reward.purchase ? await checkRewardMoney(env, reward, nowMs, snapshot) : null,
    })),
  );
}
/** Rebuild the fact from canonical taxi entries, including edits and deletions.
 * @param {Env} env @param {number} [nowMs] @param {any} [finance] */
export async function synchronizePlanFinance(env, nowMs = Date.now(), finance) {
  let state = await readPlanState(env);
  const tasks = planRecords(state, 'task').filter(
    (t) => t.source?.kind === 'taxi' && t.status === 'accepted' && !t.forfeitedAt,
  );
  if (!tasks.length) return;
  finance ??= await readFinanceWorkspace(env, nowMs, undefined, { omitTransactions: true });
  for (const task of tasks) {
    const entries = /** @type {any[]} */ (finance.taxiEntries)
      .filter(
        (e) =>
          e.at >= task.source.from &&
          e.at < task.source.until &&
          e.at >= task.acceptedAt &&
          Date.parse(e.at) <= nowMs,
      )
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
    const unknown =
      task.source.metric === 'gross' && entries.some((e) => e.commissionReported === false);
    /** @param {any[]} rows */ const amount = (rows) =>
      rows.reduce(
        (n, e) => n + e.netCashMinor + (task.source.metric === 'gross' ? e.commissionMinor : 0),
        0,
      );
    const current = amount(entries),
      onTime = entries.filter((e) => e.at <= task.dueAt);
    const facts = [];
    if (onTime.length)
      facts.push({
        units: Math.min(task.target, (task.baseline ?? 0) + Math.floor(amount(onTime) / 100)),
        actualAt: onTime.at(-1).at,
      });
    if (entries.length && entries.at(-1).at > task.dueAt)
      facts.push({
        units: Math.min(task.target, (task.baseline ?? 0) + Math.floor(current / 100)),
        actualAt: entries.at(-1).at,
      });
    const raw = JSON.stringify([
      task.id,
      task.dueAt,
      task.source.metric,
      entries.map((e) => [
        e.id,
        e.revision,
        e.at,
        e.netCashMinor,
        e.commissionMinor,
        e.commissionReported,
      ]),
      facts,
    ]);
    const hash = [
      ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw))),
    ]
      .map((n) => n.toString(16).padStart(2, '0'))
      .join('');
    if (task.source.proof === hash || (!entries.length && !task.source.proof)) continue;
    // Include the observed revision: a later A → B → A correction is a new reconciliation.
    await executePlanCommand(
      env,
      {
        op: '_source-sync',
        id: task.id,
        commandId: `src-${hash.slice(0, 48)}-${state.revision}`,
        payload: {
          proof: hash,
          unknown,
          actualMinor: current,
          facts,
          entryIds: entries.map((e) => e.id),
        },
      },
      nowMs,
      { internal: true },
    );
    state = await readPlanState(env);
  }
}
