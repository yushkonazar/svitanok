import { checkOwnerRead } from './auth-core.mjs';
import { json } from './http-core.mjs';
import { NEWS_SNAPSHOT_KEY } from './core/brief/news-snapshot.mjs';
/** @param {Request} request @param {Env} env */
export async function handleNews(request, env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const snapshot = await env.BRIEFING.get(NEWS_SNAPSHOT_KEY, 'json');
  if (!snapshot) return json({ ok: false, error: 'Стрічка ще не зібрана' }, 503);
  return new Response(JSON.stringify(snapshot), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
    },
  });
}
