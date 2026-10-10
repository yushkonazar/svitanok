import { checkOwnerRead, checkPrimaryOwner } from './auth-core.mjs';
import { json, readJsonBody } from './http-core.mjs';
import { kyivParts } from './core/finance/planning.mjs';
import {
  contentExcluded,
  contentIdentity,
  contentSourceAllowed,
  publicContent,
  CONTENT_AUTHORS,
  preferencesSchema,
  DEFAULT_CONTENT_PREFERENCES,
} from './core/brief/daily-content.mjs';
/** @param {unknown} value @param {number} [status] */
function privateJson(value, status = 200) {
  const response = json(value, status);
  response.headers.set('cache-control', 'private, no-store');
  return response;
}
/** @param {any} brief */
export function publishedContent(brief) {
  if (!brief || !Array.isArray(brief.blocks)) return null;
  const timestamp = Date.parse(brief.generatedAt ?? '');
  if (!Number.isFinite(timestamp)) return null;
  const date = kyivParts(timestamp).date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  /** @param {string} blockId @param {'fact'|'quote'} kind @returns {Record<string, any>|null} */
  const pick = (blockId, kind) => {
    const data = brief.blocks.find((/** @type {any} */ n) => n.id === blockId)?.data;
    if (!data || !contentSourceAllowed(data.sourceUrl ?? '') || contentExcluded(data)) return null;
    if (kind === 'quote' && !Object.hasOwn(CONTENT_AUTHORS, data.author)) return null;
    if (typeof data[kind === 'fact' ? 'fact' : 'text'] !== 'string') return null;
    return { ...publicContent(data), id: contentIdentity(data, kind) };
  };
  return { date, fact: pick('fact', 'fact'), quote: pick('stoic', 'quote') };
}
/** Read only published briefs; upcoming queue and verification evidence are never exposed.
 * @param {Request} request @param {Env} env */
export async function handleDailyContent(request, env) {
  if (!['GET', 'POST'].includes(request.method))
    return json({ ok: false, error: 'method-not-allowed' }, 405);
  const auth =
    request.method === 'GET'
      ? await checkOwnerRead(request, env)
      : await checkPrimaryOwner(request.headers.get('X-Telegram-Init-Data'), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const today = kyivParts(Date.now()).date;
  if (request.method === 'POST') {
    const parsed = await readJsonBody(request, 2000);
    if (!parsed.ok) return json({ ok: false, error: parsed.error }, parsed.status);
    const b = parsed.body;
    if (b.type === 'preferences') {
      const prefs = preferencesSchema.safeParse(b.preferences);
      if (!prefs.success) return json({ ok: false, error: 'Обери принаймні одну тему' }, 400);
      await env.BRIEFING.put('dailyContent:preferences', JSON.stringify(prefs.data));
      return json({ ok: true });
    }
    if (
      b.type !== 'feedback' ||
      !['like', 'less', 'clear'].includes(b.signal) ||
      !['fact', 'quote'].includes(b.kind) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(b.date ?? '') ||
      b.date > today
    )
      return json({ ok: false, error: 'invalid-feedback' }, 400);
    const brief =
      (await env.BRIEFING.get(`briefing:${b.date}`, 'json')) ??
      (await env.BRIEFING.get('latest', 'json'));
    const published = publishedContent(brief),
      item = published?.[/** @type {'fact'|'quote'} */ (b.kind)];
    if (published?.date !== b.date || !item || item.id !== b.id)
      return json({ ok: false, error: 'Матеріал уже недоступний для оцінки' }, 409);
    await env.BRIEFING.put(
      `dailyContent:feedback:${b.kind}:${item.id}`,
      JSON.stringify({
        kind: b.kind,
        id: item.id,
        topic: item.topic ?? 'mind',
        author: item.author ?? null,
        signal: b.signal,
        date: b.date,
        updatedAt: new Date().toISOString(),
      }),
    );
    return json({ ok: true });
  }
  const url = new URL(request.url);
  if (url.searchParams.has('archive')) {
    const before = url.searchParams.get('before') ?? today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(before) || before > today)
      return json({ ok: false, error: 'invalid-date' }, 400);
    const keys = await env.BRIEFING.list({ prefix: 'briefing:', limit: 1000 });
    const dates = keys.keys
      .map((n) => n.name.slice(9))
      .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= today && date < before)
      .sort()
      .reverse()
      .slice(0, 21);
    const items = (
      await Promise.all(
        dates
          .slice(0, 20)
          .map(async (date) =>
            publishedContent(await env.BRIEFING.get(`briefing:${date}`, 'json')),
          ),
      )
    ).filter((n) => n && n.date <= today && n.date < before && (n.fact || n.quote));
    return privateJson({ ok: true, items, next: dates.length > 20 ? dates[19] : null });
  }
  const published = publishedContent(await env.BRIEFING.get('latest', 'json'));
  const preferences = preferencesSchema.safeParse(
    await env.BRIEFING.get('dailyContent:preferences', 'json'),
  );
  /** @type {Record<string, string>} */ const feedback = {};
  for (const kind of /** @type {const} */ (['fact', 'quote'])) {
    const item = published?.[kind];
    if (item) {
      const stored = /** @type {any} */ (
        await env.BRIEFING.get(`dailyContent:feedback:${kind}:${item.id}`, 'json')
      );
      if (stored?.signal) feedback[`${kind}:${item.id}`] = stored.signal;
    }
  }
  const status = await env.BRIEFING.get(`dailyContent:status:${today.slice(0, 7)}`, 'json');
  return privateJson({
    ok: true,
    date: published?.date ?? today,
    preferences: preferences.success ? preferences.data : DEFAULT_CONTENT_PREFERENCES,
    feedback,
    status,
  });
}
