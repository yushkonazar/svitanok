import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import {
  executeLeisureCommand,
  inspectLeisureCommand,
  readLeisureWorkspace,
} from './core/leisure/store.mjs';
import { LeisureError } from './core/leisure/model.mjs';
import { suggestLeisure } from './core/leisure/planning-service.mjs';

/** @param {Request} request @param {Env} env */
export async function handleLeisure(request, env) {
  const requestId = crypto.randomUUID(),
    at = new Date().toISOString();
  const reply = (/** @type {unknown} */ body, status = 200) => {
    const response = json(body, status);
    response.headers.set('cache-control', 'private, no-store');
    response.headers.set('X-Request-Id', requestId);
    return response;
  };
  if (!['GET', 'POST'].includes(request.method))
    return reply({ ok: false, error: 'method-not-allowed' }, 405);
  const parsed = request.method === 'POST' ? await readJsonBody(request) : null;
  if (parsed && !parsed.ok) return reply({ ok: false, error: parsed.error }, parsed.status);
  const body = parsed?.ok ? parsed.body : null;
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
  let acknowledged = false,
    receipt = null,
    phase = 'command';
  try {
    const url = new URL(request.url);
    if (request.method === 'GET' && url.searchParams.has('commandId'))
      return reply({
        ok: true,
        verification: await inspectLeisureCommand(env, url.searchParams.get('commandId') ?? ''),
      });
    if (body) {
      if (body.op === 'suggest') {
        if (JSON.stringify(body.payload ?? {}).length > 12000)
          throw new LeisureError('Параметрів підбору забагато.');
        return reply({ ok: true, suggestions: await suggestLeisure(env, body.payload) });
      }
      receipt = await executeLeisureCommand(env, body);
      acknowledged = true;
      // A reaction needs its receipt and a small client patch; visits/plans keep
      // the full workspace response so newly saved personal history stays visible.
      if (
        ['3', '4'].includes(request.headers.get('X-Leisure-Format') ?? '') &&
        body.op === 'reaction'
      )
        return reply({ ok: true, acknowledged, receipt });
    }
    phase = 'workspace';
    const workspace = await readLeisureWorkspace(
      env,
      Date.now(),
      request.method === 'GET' && new URL(request.url).searchParams.get('history') === 'all',
    );
    const format = request.headers.get('X-Leisure-Format') ?? '';
    if (!['2', '3', '4'].includes(format))
      workspace.records = workspace.records.filter((r) => r.kind !== 'familiarity');
    if (format !== '4') {
      const legacy = new Set([
        'exhibition',
        'festival',
        'concert',
        'show',
        'cinema',
        'food',
        'trip',
      ]);
      workspace.items = workspace.items.filter((i) => legacy.has(i.category));
      workspace.records = workspace.records.filter((r) => r.kind !== 'draft');
      workspace.settings = {
        ...workspace.settings,
        categories: workspace.settings.categories.filter((/** @type {string} */ c) =>
          legacy.has(c),
        ),
        telegram: false,
      };
      const ids = new Set(workspace.items.map((i) => i.id));
      if (workspace.edition)
        workspace.edition = {
          ...workspace.edition,
          ids: workspace.edition.ids.filter((/** @type {string} */ id) => ids.has(id)),
          futureIds: workspace.edition.futureIds.filter((/** @type {string} */ id) => ids.has(id)),
          rankings: workspace.edition.rankings.filter((/** @type {any} */ r) => ids.has(r.id)),
        };
    }
    return reply({
      ok: true,
      acknowledged,
      receipt,
      workspace,
    });
  } catch (/** @type {any} */ error) {
    const status = error instanceof LeisureError ? error.status : 503;
    const code =
      error instanceof LeisureError
        ? 'command-rejected'
        : /D1|sqlite|database/i.test(String(error))
          ? 'storage-failure'
          : 'service-failure';
    const diagnostic = {
      requestId,
      at,
      area: 'leisure',
      phase,
      status,
      code,
      operation:
        typeof body?.op === 'string' && /^[a-z-]{1,30}$/.test(body.op) ? body.op : request.method,
    };
    console[status >= 500 ? 'error' : 'warn']('leisure.request-failed', diagnostic);
    if (acknowledged)
      return reply({
        ok: true,
        acknowledged: true,
        receipt,
        diagnostic,
        message: 'Зміна збережена. Онови показ дозвілля.',
      });
    return reply(
      {
        ok: false,
        error:
          error instanceof LeisureError
            ? error.message
            : 'Не вдалося завантажити дозвілля. Спробуй ще раз.',
        diagnostic,
      },
      error instanceof LeisureError ? error.status : 503,
    );
  }
}
