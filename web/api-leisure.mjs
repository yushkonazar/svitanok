import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { executeLeisureCommand, readLeisureWorkspace } from './core/leisure/store.mjs';
import { LeisureError } from './core/leisure/model.mjs';

/** @param {Request} request @param {Env} env */
export async function handleLeisure(request, env) {
  const reply = (/** @type {unknown} */ body, status = 200) => {
    const response = json(body, status);
    response.headers.set('cache-control', 'private, no-store');
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
    receipt = null;
  try {
    if (body) {
      receipt = await executeLeisureCommand(env, body);
      acknowledged = true;
    }
    return reply({
      ok: true,
      acknowledged,
      receipt,
      workspace: await readLeisureWorkspace(
        env,
        Date.now(),
        request.method === 'GET' && new URL(request.url).searchParams.get('history') === 'all',
      ),
    });
  } catch (/** @type {any} */ error) {
    if (acknowledged)
      return reply({
        ok: true,
        acknowledged: true,
        receipt,
        message: 'Зміна збережена. Онови показ дозвілля.',
      });
    return reply(
      {
        ok: false,
        error:
          error instanceof LeisureError
            ? error.message
            : 'Не вдалося завантажити дозвілля. Спробуй ще раз.',
      },
      error instanceof LeisureError ? error.status : 503,
    );
  }
}
