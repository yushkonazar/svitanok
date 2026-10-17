import { checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { BookmarkError } from './core/ideas/bookmark-model.mjs';
import {
  readBookmarks,
  readBookmark,
  changeBookmark,
  startBookmarkFormulation,
} from './core/ideas/bookmark-store.mjs';
/** @param {Request} request @param {Env} env */
export async function handleBookmarks(request, env) {
  const reply = (/** @type {unknown} */ body, status = 200) => {
    const response = json(body, status);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  };
  if (!['GET', 'POST'].includes(request.method))
    return reply({ ok: false, error: 'method-not-allowed' }, 405);
  const auth = await checkPrimaryOwner(mutationInitData(request, null), env);
  if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
  // An authenticated owner can edit a full generated prompt, including UTF-8 text.
  const parsed = request.method === 'POST' ? await readJsonBody(request, 256 * 1024) : null;
  if (parsed && !parsed.ok) return reply({ ok: false, error: parsed.error }, parsed.status);
  const body = parsed?.ok ? parsed.body : null;
  let receipt;
  try {
    const url = new URL(request.url),
      id = url.searchParams.get('id');
    if (body) {
      receipt = await changeBookmark(env, body);
      if (receipt.formulationId) await startBookmarkFormulation(env, receipt.formulationId);
      return reply({ ok: true, receipt, ...(await readBookmark(env, receipt.id)) });
    }
    if (id) {
      if (id.length > 100) throw new BookmarkError();
      return reply({
        ok: true,
        ...(await readBookmark(env, id, url.searchParams.get('before') ?? undefined)),
      });
    }
    return reply({
      ok: true,
      ...(await readBookmarks(env, {
        q: url.searchParams.get('q') ?? '',
        status: url.searchParams.get('status') ?? 'active',
        cursor: url.searchParams.get('cursor') ?? undefined,
      })),
    });
  } catch (error) {
    if (receipt) return reply({ ok: true, receipt, refreshRequired: true });
    return reply(
      {
        ok: false,
        error:
          error instanceof BookmarkError
            ? error.message
            : 'Закладки зараз недоступні. Неотримане підтвердження можна перевірити повтором тієї самої спроби.',
      },
      error instanceof BookmarkError ? error.status : 503,
    );
  }
}
