import { executePlanCommand, readPlanWorkspace } from '../motivation/store.mjs';
import { PlanError } from '../motivation/model.mjs';

/** @param {Env} env @param {any} args @param {number} nowMs */
export async function runMotivationQuery(env, args, nowMs) {
  const workspace = await readPlanWorkspace(env, nowMs);
  const date = args.date ?? workspace.today;
  return {
    result: {
      ...workspace,
      tasks: workspace.tasks.filter((t) => (args.id ? t.id === args.id : t.date === date)),
      events: workspace.events.slice(0, 20),
      note: 'Ручний план. XP рахує ядро. Прийняття всіх чернеток вимагає явного рішення власника. Звіт містить справжній час виконання; звичайне відкриття апки нічого не доводить. /app/#/plan',
    },
  };
}
/** @param {Env} env @param {any} args @param {number} nowMs */
export async function runMotivationChange(env, args, nowMs) {
  let payload;
  try {
    payload = JSON.parse(args.payload_json);
  } catch {
    throw new PlanError('Некоректний JSON параметрів плану.');
  }
  // Budget/finance gates and enabling strict commitments stay explicit in Mini App.
  if (
    ['settings', 'reward-save', 'redeem', 'accept', 'exception', 'forfeit', 'day-extend'].includes(
      args.op,
    )
  )
    throw new PlanError('Відкрий «План» і підтвердь умови цієї дії у міні-апці.');
  return {
    result: await executePlanCommand(
      env,
      { op: args.op, id: args.id, revision: args.revision, commandId: args.command_id, payload },
      nowMs,
    ),
  };
}
