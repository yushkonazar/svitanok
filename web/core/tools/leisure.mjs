import { readLeisureWorkspace, executeLeisureCommand } from '../leisure/store.mjs';
import { LeisureError } from '../leisure/model.mjs';
import { wrapExternal } from './markup.mjs';

/** @param {Env} env @param {any} args @param {number} nowMs */
export async function runLeisureQuery(env, args, nowMs) {
  if (args.plan_json) {
    let payload;
    try {
      payload = JSON.parse(args.plan_json);
    } catch {
      throw new LeisureError('Укажи коректний JSON плану для перевірки.');
    }
    const check = await executeLeisureCommand(
      env,
      { op: 'calendar-check', id: args.id, payload, commandId: crypto.randomUUID() },
      nowMs,
    );
    return { result: wrapExternal('calendar', JSON.stringify(check)) };
  }
  const workspace = await readLeisureWorkspace(
      env,
      nowMs,
      Boolean(args.id || ['plans', 'visits'].includes(args.view)),
    ),
    view = args.view ?? 'week',
    query = String(args.query ?? '').toLocaleLowerCase('uk');
  const ids = new Set(
    args.id
      ? [args.id]
      : view === 'saved'
        ? workspace.saved
        : view === 'week'
          ? [...(workspace.edition?.ids ?? []), ...(workspace.edition?.futureIds ?? [])]
          : workspace.records
              .filter((r) => r.kind === (view === 'plans' ? 'plan' : 'visit'))
              .flatMap((r) =>
                r.itemId ? [r.itemId] : r.stops.map((/** @type {any} */ s) => s.itemId),
              ),
  );
  const items = workspace.items
    .filter(
      (i) =>
        ids.has(i.id) &&
        (!query || `${i.title} ${i.venue ?? ''}`.toLocaleLowerCase('uk').includes(query)),
    )
    .slice(0, args.id ? 1 : 18)
    .map((i) => ({
      ...i,
      sessions: i.sessions.slice(0, args.id ? 40 : 4),
      sessionCount: i.sessions.length,
    }));
  return {
    result: wrapExternal(
      'leisure',
      JSON.stringify({
        items,
        records: workspace.records
          .filter(
            (r) =>
              (view === 'plans'
                ? r.kind === 'plan'
                : view === 'visits'
                  ? r.kind === 'visit'
                  : r.kind === 'plan' || r.kind === 'visit') &&
              (!query ||
                String(r.title ?? '')
                  .toLocaleLowerCase('uk')
                  .includes(query)),
          )
          .slice(0, 15)
          .map((r) => {
            const safe = { ...r };
            for (const key of [
              'lastCommandId',
              'lastCommandFingerprint',
              'lastSynced',
              'calendarAttempts',
              'calendarRetryAt',
            ])
              delete safe[key];
            return safe;
          }),
        week: workspace.edition?.week,
        sources: workspace.edition?.sources,
        settings: workspace.settings,
        note: 'Збереження, плани, відвідування та оцінки — різні стани. Банківська оплата не підтверджує відвідування. Записи календаря — після погодження.',
      }),
    ),
  };
}
/** @param {Env} env @param {any} args @param {number} nowMs */
export async function runLeisureChange(env, args, nowMs) {
  let payload;
  try {
    payload = JSON.parse(args.payload_json ?? '{}');
  } catch {
    throw new LeisureError('Дані дозвілля мають бути коректним JSON.');
  }
  return {
    result: await executeLeisureCommand(
      env,
      {
        op: args.op,
        id: args.id,
        payload,
        commandId: args.command_id ?? `chat-${crypto.randomUUID()}`,
      },
      nowMs,
    ),
  };
}
