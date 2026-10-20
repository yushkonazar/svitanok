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
      note: 'Ручний план. lifecycle — стан виконання, status — прийняття. facts.units/done відображають фактично зроблене, eligibleUnits/credited — право на XP та нарахування; onTimeUnits — вчасний обсяг. completed-late означає виконано пізніше строку, навіть без права на XP. Не проси знову внести вже відомий факт. missed не створює вигаданий нульовий звіт. task-note {reason} зберігає пояснення без зміни строку, XP чи винятку. XP рахує ядро. Винятки, їх скасування та перенесення підтверджуються в Mini App. /app/#/plan',
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
    [
      'settings',
      'reward-save',
      'redeem',
      'accept',
      'exception',
      'forfeit',
      'day-extend',
      'reschedule',
      'exception-revoke',
    ].includes(args.op)
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
