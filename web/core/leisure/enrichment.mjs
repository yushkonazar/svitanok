import { cleanText, LeisureError } from './model.mjs';
import { sourceText, boundedBytes } from './source-html.mjs';
import { leisureMediaUrl, normalizeContentFacts } from './content-facts.mjs';
import { freshLeisurePlace, freshLeisurePhoto } from './google-details.mjs';
import { parseNuxtData } from './nuxt-data.mjs';

/** @param {Env} env @param {unknown} id */
async function selectedItem(env, id) {
  if (typeof id !== 'string' || !/^item-[a-zA-Z0-9_-]{1,100}$/.test(id))
    throw new LeisureError('Обери картку з каталогу.');
  const row = await env.DB?.prepare('SELECT data_json FROM leisure_items WHERE id=?')
    .bind(id)
    .first();
  if (!row) throw new LeisureError('Картку не знайдено.', 404);
  return JSON.parse(String(row.data_json));
}
/** Read-only hydration. Google content is returned only for the current view.
 * @param {Env} env @param {any} payload @param {number} [nowMs] */
export async function enrichLeisureItem(env, payload, nowMs = Date.now()) {
  const item = await selectedItem(env, payload?.itemId);
  if (item.placeId)
    return {
      itemId: item.id,
      place: await freshLeisurePlace(env, item.placeId, nowMs, payload?.extended === true),
    };
  if (
    new URL(item.sourceUrl).hostname === 'planetakino.ua' &&
    /^\/movie\/[^/]+\/$/.test(new URL(item.sourceUrl).pathname)
  ) {
    const state = parseNuxtData(await sourceText(item.sourceUrl)),
      movie = state?.data?.[0]?.movie;
    if (!movie) throw new LeisureError('Опис фільму тимчасово недоступний.', 503);
    const posters = [...(movie.posters?.vertical ?? []), ...(movie.posters?.horizontal ?? [])];
    const countries = (Array.isArray(movie.countries) ? movie.countries : [])
      .map((/** @type {any} */ c) => (typeof c === 'string' ? c : c.name))
      .filter(Boolean)
      .join(', ');
    const film = {
      originalTitle: movie.originalName,
      year: Number(movie.year),
      countries,
      language: movie.offlineRentalLang,
      subtitles: movie.offlineSubtitlesLang,
      imdbRating: movie.rating?.imdb?.rating,
      imdbVotes: movie.rating?.imdb?.voteCount,
      imdbId: /tt\d{5,12}/.exec(movie.imdbUrl ?? '')?.[0],
    };
    return {
      itemId: item.id,
      summary: cleanText(movie.fullDescription || movie.shortDescription, 1600),
      ...normalizeContentFacts(
        {
          title: item.title,
          film,
          media: posters.map((/** @type {any} */ p) => ({
            url: p.url,
            kind: 'poster',
            credit: item.source,
          })),
        },
        item.sourceUrl,
        item.source,
      ),
    };
  }
  return {
    itemId: item.id,
    media: item.media ?? [],
    film: item.film ?? null,
    podcast: item.podcast ?? null,
  };
}
/** Authenticated binary response; never accepts a URL from the browser.
 * @param {Env} env @param {any} payload @param {number} [nowMs] */
export async function leisureItemImage(env, payload, nowMs = Date.now()) {
  const item = await selectedItem(env, payload?.itemId);
  let result;
  if (item.placeId) {
    if (typeof payload?.photo !== 'string') throw new LeisureError('Обери фотографію закладу.');
    result = await freshLeisurePhoto(env, item.placeId, payload.photo, nowMs);
  } else {
    const index = payload?.index ?? 0;
    if (!Number.isInteger(index) || index < 0 || index > 7)
      throw new LeisureError('Фотографію не знайдено.', 404);
    const source = leisureMediaUrl(item.media?.[index]?.url);
    if (!source) throw new LeisureError('Фотографію не знайдено.', 404);
    let target = source,
      response;
    for (let hop = 0; hop < 3; hop++) {
      response = await fetch(target, {
        redirect: 'manual',
        signal: AbortSignal.timeout(10000),
        headers: { accept: 'image/avif,image/webp,image/jpeg,image/png' },
      });
      if (response.status >= 300 && response.status < 400) {
        const next = leisureMediaUrl(response.headers.get('location'), target);
        if (!next) throw new LeisureError('Зображення джерела недоступне.', 503);
        target = next;
        response = undefined;
        continue;
      }
      break;
    }
    const type = response?.headers.get('content-type')?.split(';')[0] ?? '';
    if (!response?.ok || !/^image\/(?:jpeg|png|webp|avif|gif)$/.test(type))
      throw new LeisureError('Зображення джерела недоступне.', 503);
    result = { bytes: await boundedBytes(response, 3_000_000), type };
  }
  return new Response(result.bytes, {
    headers: {
      'content-type': result.type,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}
