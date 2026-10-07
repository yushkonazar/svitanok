import { checkOwnerRead, checkPrimaryOwner } from './auth-core.mjs';
import { json } from './http-core.mjs';
import {
  readNewsSnapshot,
  newsRefreshStub,
  refreshNewsSnapshot,
} from './core/brief/news-snapshot.mjs';
import { safeNewsImage } from './core/brief/news-content.mjs';
/** @param {Request} request @param {Env} env */
export async function handleNews(request, env) {
  const auth =
    request.method === 'GET'
      ? await checkOwnerRead(request, env)
      : await checkPrimaryOwner(request.headers.get('X-Telegram-Init-Data'), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const target = newsRefreshStub(env);
  if (request.method === 'POST') {
    let body;
    try {
      const text = await request.text();
      if (text.length > 4000) throw new Error('size');
      body = JSON.parse(text);
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('shape');
    } catch {
      return json({ ok: false, error: 'Некоректний запит' }, 400);
    }
    if (body.type === 'seen') {
      if (!target)
        return json({ ok: false, error: 'Історія переглядів тимчасово недоступна' }, 503);
      return json(await target.seen());
    }
    if (body.type === 'feedback') {
      if (
        typeof body.url !== 'string' ||
        body.url.length > 2000 ||
        !['like', 'less', 'clear'].includes(body.kind) ||
        (body.reason != null && !['topic', 'repeat', 'weak', 'source'].includes(body.reason))
      )
        return json({ ok: false, error: 'Некоректна реакція' }, 400);
      if (!target) return json({ ok: false, error: 'Реакції тимчасово недоступні' }, 503);
      const result = await target.feedback(body.url, body.kind, body.reason);
      return json(result, result.ok ? 200 : 404);
    }
    if (body.type !== 'refresh') return json({ ok: false, error: 'Невідома дія' }, 400);
    const result = await refreshNewsSnapshot(env, Date.now(), fetch, true);
    return json({ ok: true, ...result });
  }
  if (request.method !== 'GET') return json({ ok: false, error: 'Метод не підтримується' }, 405);
  const snapshot = target ? await target.getSnapshot() : await readNewsSnapshot(env);
  if (!snapshot) return json({ ok: false, error: 'Стрічка ще не зібрана' }, 503);
  const profile = target ? await target.getFeedback() : {};
  // Public article history stays server-side; the UI needs only current item metadata.
  const visibleSnapshot = { ...snapshot };
  delete visibleSnapshot.history;
  return new Response(
    JSON.stringify({
      ...visibleSnapshot,
      lastSeenAt: target ? await target.getLastSeen() : null,
      feedback: Object.fromEntries(
        Object.entries(profile).map(([key, value]) => [key, /** @type {KvBlob} */ (value).kind]),
      ),
    }),
    {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'private, no-store',
      },
    },
  );
}

/** Public publisher photos through same origin; CSP remains self-only. No arbitrary URL proxy.
 * @param {Request} request @param {Env} env @param {typeof fetch} [fetchImpl] */
export async function handleNewsImage(request, env, fetchImpl = fetch) {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  const id = new URL(request.url).pathname.split('/').at(-1) ?? '';
  if (!/^[a-f0-9]{64}$/.test(id)) return new Response(null, { status: 404 });
  const cacheRequest = new Request(new URL(`/api/news/image/${id}`, request.url));
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cached = await cache?.match(cacheRequest);
  if (cached) return cached;
  const target = newsRefreshStub(env);
  const snapshot = /** @type {KvBlob|null} */ (
    target ? await target.getSnapshot() : await readNewsSnapshot(env)
  );
  const item = snapshot?.groups
    ?.flatMap((/** @type {KvBlob} */ g) => g.items ?? [])
    .find((/** @type {KvBlob} */ n) => n.imageId === id);
  let url = item ? safeNewsImage(item.image) : null;
  if (!url) return new Response(null, { status: 404 });
  try {
    for (let hop = 0; hop < 3; hop++) {
      const response = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(8000),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = response.headers.get('location');
        url = next ? safeNewsImage(new URL(next, url).href) : null;
        if (!url) break;
        continue;
      }
      const mime =
        (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
      if (
        !response.ok ||
        !/^image\/(?:jpeg|jpg|png|webp|gif|avif)$/.test(mime) ||
        Number(response.headers.get('content-length')) > 2_000_000 ||
        !response.body
      )
        break;
      const reader = response.body.getReader();
      /** @type {Uint8Array[]} */ const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) {
          await reader.cancel();
          return new Response(null, { status: 404 });
        }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const photo = new Response(bytes, {
        headers: {
          'content-type': mime,
          'cache-control': 'public, max-age=3600',
          'x-content-type-options': 'nosniff',
        },
      });
      await cache?.put(cacheRequest, photo.clone());
      return photo;
    }
  } catch {
    /* Missing/blocked images become text cards. */
  }
  return new Response(null, { status: 404, headers: { 'cache-control': 'no-store' } });
}
