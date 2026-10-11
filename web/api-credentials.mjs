import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import {
  readCredentials,
  saveCredentialMetadata,
  validateCredentialMetadata,
} from './core/ops/credentials.mjs';
import { cachedGoogleAudit } from './core/google-scopes.mjs';

/** Owner metadata only. No provider requests, key retrieval, rotation or OAuth.
 * @param {Request} request @param {Env} env */
export async function handleCredentials(request, env) {
  if (!['GET', 'POST'].includes(request.method))
    return json({ ok: false, error: 'method-not-allowed' }, 405);
  const parsed = request.method === 'POST' ? await readJsonBody(request) : null;
  if (parsed && !parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
  const body = parsed?.ok ? parsed.body : null;
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const nowMs = Date.now();
  if (body) {
    try {
      validateCredentialMetadata(body, nowMs);
    } catch (/** @type {any} */ error) {
      return json({ ok: false, error: error.message }, 400);
    }
  }
  let saved = false;
  try {
    if (body) {
      saved = (await saveCredentialMetadata(env, body, nowMs)).saved;
      if (!saved)
        return json(
          { ok: false, error: 'Дані змінилися. Онови реєстр і повтори збереження.' },
          409,
        );
    }
    const response = json({
      ok: true,
      saved,
      ...(await readCredentials(env, nowMs)),
      google: await cachedGoogleAudit(env, nowMs),
    });
    response.headers.set('cache-control', 'private, no-store');
    return response;
  } catch {
    if (saved)
      return json({
        ok: true,
        saved: true,
        error: 'Дати збережено, але не вдалося оновити їхній показ. Онови реєстр.',
      });
    return json({ ok: false, error: 'Не вдалося оновити реєстр доступів. Спробуй ще раз.' }, 503);
  }
}
