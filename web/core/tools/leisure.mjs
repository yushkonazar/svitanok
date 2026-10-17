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
      Boolean(args.id || ['interested', 'plans', 'visits', 'places'].includes(args.view)),
    ),
    view = args.view ?? 'week',
    query = String(args.query ?? '').toLocaleLowerCase('uk');
  const ids = new Set(
    args.id
      ? [args.id]
      : view === 'saved'
        ? workspace.saved
        : view === 'interested'
          ? workspace.records
              .filter((r) => r.kind === 'reaction' && r.verdict === 'interested')
              .map((r) => r.itemId)
          : view === 'week'
            ? [...(workspace.edition?.ids ?? []), ...(workspace.edition?.futureIds ?? [])]
            : workspace.records
                .filter((r) =>
                  view === 'places'
                    ? ['visit', 'familiarity'].includes(r.kind)
                    : r.kind === (view === 'plans' ? 'plan' : 'visit'),
                )
                .flatMap((r) =>
                  r.itemId ? [r.itemId] : r.stops.map((/** @type {any} */ s) => s.itemId),
                ),
  );
  const ranking = new Map(
    (workspace.edition?.rankings ?? []).map((/** @type {any} */ r, /** @type {number} */ n) => [
      r.id,
      n,
    ]),
  );
  const matches = workspace.items
    .filter(
      (i) =>
        ids.has(i.id) &&
        (!args.category || i.category === args.category) &&
        (!query ||
          `${i.title} ${i.venue ?? ''} ${workspace.records
            .filter((r) => r.itemId === i.id)
            .map((r) => r.reason ?? '')
            .join(' ')}`
            .toLocaleLowerCase('uk')
            .includes(query)),
    )
    .sort((a, b) => (ranking.get(a.id) ?? 100000) - (ranking.get(b.id) ?? 100000));
  const offset = args.id ? 0 : Math.max(0, Math.floor(Number(args.offset ?? 0)));
  const limit = args.id ? 1 : Math.max(1, Math.min(40, Math.floor(Number(args.limit ?? 18))));
  const items = matches.slice(offset, offset + limit).map((i) => ({
    ...i,
    sessions: i.sessions.slice(0, args.id ? 40 : 4),
    sessionCount: i.sessions.length,
    ranking: workspace.edition?.rankings.find((/** @type {any} */ r) => r.id === i.id),
    known: workspace.knownPlaces[i.id],
    reaction:
      workspace.records.find((r) => r.kind === 'reaction' && r.itemId === i.id)?.verdict ?? null,
    saved: workspace.saved.includes(i.id),
  }));
  return {
    result: wrapExternal(
      'leisure',
      JSON.stringify({
        items,
        total: matches.length,
        offset,
        nextOffset: offset + limit < matches.length ? offset + limit : null,
        records: workspace.records
          .filter(
            (r) =>
              (view === 'interested'
                ? r.kind === 'reaction' && r.verdict === 'interested'
                : view === 'plans'
                  ? r.kind === 'plan'
                  : view === 'places'
                    ? ['visit', 'familiarity'].includes(r.kind)
                    : view === 'visits'
                      ? r.kind === 'visit'
                      : r.kind === 'plan' || r.kind === 'visit') &&
              (!query ||
                String(`${r.title ?? ''} ${r.reason ?? ''}`)
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
        preferenceProfile: {
          signals: workspace.preferenceProfile.signals,
          interests: workspace.preferenceProfile.interests,
        },
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
