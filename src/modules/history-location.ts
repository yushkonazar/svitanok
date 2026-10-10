import { z } from 'zod';
import type { StateStore, Logger } from '../core/types.js';
import type { OnThisDayEvent } from './onthisday.js';

const CACHE_KEY = 'onthisdayLocations:v1';
const ID = /^Q[1-9]\d{0,10}$/;
const coordinateSchema = z.object({
  lat: z.number().finite().min(-90).max(90),
  lon: z.number().finite().min(-180).max(180),
});
const entitySchema = z.object({
  label: z.string(),
  coordinate: coordinateSchema.optional(),
  places: z.array(z.string().regex(ID)),
  years: z.array(z.number().int()),
});
const cachedSchema = z.object({ fetchedAt: z.number().finite(), entity: entitySchema.nullable() });
type Entity = z.infer<typeof entitySchema>;
type Cached = z.infer<typeof cachedSchema>;
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RecordValue) : {};

function bestClaims(value: unknown): RecordValue[] {
  const claims = (Array.isArray(value) ? value : [])
    .map(object)
    .filter((n) => n.rank === 'preferred' || n.rank === 'normal');
  const preferred = claims.filter((n) => n.rank === 'preferred');
  return preferred.length ? preferred : claims;
}
function claimValue(claim: RecordValue): RecordValue {
  const snak = object(claim.mainsnak);
  return snak.snaktype === 'value' ? object(object(snak.datavalue).value) : {};
}
function parseEntity(value: unknown): Entity | null {
  const item = object(value);
  if ('missing' in item || !ID.test(String(item.id))) return null;
  const claims = object(item.claims),
    labels = object(item.labels);
  const label = object(labels.uk).value ?? object(labels.en).value;
  if (typeof label !== 'string' || !label.trim()) return null;
  const points = bestClaims(claims.P625).flatMap((n) => {
    const point = claimValue(n);
    const parsed = coordinateSchema.safeParse({ lat: point.latitude, lon: point.longitude });
    return parsed.success && point.globe === 'http://www.wikidata.org/entity/Q2'
      ? [parsed.data]
      : [];
  });
  const unique = [...new Map(points.map((p) => [`${p.lat},${p.lon}`, p])).values()];
  const places = bestClaims(claims.P276)
    .map((n) => claimValue(n).id)
    .filter((id): id is string => typeof id === 'string' && ID.test(id));
  const years = ['P585', 'P580', 'P582'].flatMap((property) =>
    bestClaims(claims[property]).flatMap((n) => {
      const time = claimValue(n).time;
      const match = typeof time === 'string' && /^([+-]\d+)-/.exec(time);
      return match ? [Number(match[1])] : [];
    }),
  );
  return {
    label: label.trim(),
    ...(unique.length === 1 ? { coordinate: unique[0] } : {}),
    places: [...new Set(places)],
    years: [...new Set(years)],
  };
}

/** Bounded public metadata, never text geocoding or an arbitrary URL from an article. */
export async function enrichHistoricLocations(
  events: OnThisDayEvent[],
  raw: unknown,
  options: {
    fetchImpl: typeof fetch;
    state: StateStore;
    log: Logger;
    signal: AbortSignal;
    now: number;
  },
): Promise<OnThisDayEvent[]> {
  const rows = object(raw).events;
  if (!Array.isArray(rows)) return events;
  const linked = events.map((event) => {
    const row = rows.find(
      (n) => object(n).year === event.year && String(object(n).text).trim() === event.text,
    );
    const pages = object(row).pages;
    return (Array.isArray(pages) ? pages : [])
      .flatMap((value) => {
        const page = object(value),
          id = page.wikibase_item;
        const title = page.title;
        return typeof id === 'string' && ID.test(id) && typeof title === 'string'
          ? [{ id, title: title.replaceAll('_', ' ').trim() }]
          : [];
      })
      .slice(0, 10);
  });
  const cache = new Map<string, Cached>();
  for (const [id, value] of Object.entries(object(options.state.get(CACHE_KEY)))) {
    const parsed = cachedSchema.safeParse(value);
    if (!ID.test(id) || !parsed.success) continue;
    const age = options.now - parsed.data.fetchedAt;
    if (age >= 0 && age < (parsed.data.entity ? 30 : 1) * 86400000) cache.set(id, parsed.data);
  }
  const changes: Record<string, Cached> = {};
  async function load(ids: string[]) {
    const missing = [...new Set(ids)].filter((id) => ID.test(id) && !cache.has(id));
    async function loadBatch(batch: string[], retry = true): Promise<void> {
      if (options.signal.aborted) return;
      const url = new URL('https://www.wikidata.org/w/api.php');
      url.search = new URLSearchParams({
        action: 'wbgetentities',
        format: 'json',
        ids: batch.join('|'),
        props: 'claims|labels',
        languages: 'uk|en',
        languagefallback: '1',
      }).toString();
      try {
        const response = await options.fetchImpl(url.href, {
          redirect: 'error',
          signal: AbortSignal.any([options.signal, AbortSignal.timeout(10000)]),
          headers: { 'user-agent': 'Svitanok/0.3 (+https://svitanok.yushko.dev)' },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        // Twenty entity claim records are bounded before parsing/buffering.
        const reader = response.body?.getReader();
        if (!reader) throw new Error('empty metadata');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 6000000) throw new Error('oversized metadata');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.length;
        }
        const entities = object(object(JSON.parse(new TextDecoder().decode(bytes))).entities);
        if (!Object.keys(entities).length) throw new Error('invalid metadata');
        for (const id of batch) {
          // API failures/omitted entities are not cached as missing places.
          if (!(id in entities)) continue;
          const record = { fetchedAt: options.now, entity: parseEntity(entities[id]) };
          cache.set(id, record);
          changes[id] = record;
        }
      } catch (error) {
        options.log.warn(
          `onthisday locations: ${error instanceof Error ? error.message : 'metadata unavailable'}`,
        );
        if (retry && batch.length > 10 && !options.signal.aborted) {
          await loadBatch(batch.slice(0, 10), false);
          await loadBatch(batch.slice(10), false);
        }
      }
    }
    // Small batches avoid slow enormous country/city records; at most three
    // simultaneous public requests, all within the module's shared deadline.
    for (let index = 0; index < missing.length; index += 60) {
      if (options.signal.aborted) break;
      await Promise.all(
        [0, 20, 40].flatMap((offset) => {
          const batch = missing.slice(index + offset, index + offset + 20);
          return batch.length ? [loadBatch(batch)] : [];
        }),
      );
    }
  }
  const direct = [...new Set(linked.flatMap((pages) => pages.map((p) => p.id)))].slice(0, 100);
  await load(direct);
  const targets = [...new Set(direct.flatMap((id) => cache.get(id)?.entity?.places ?? []))].slice(
    0,
    60,
  );
  await load(targets);
  if (Object.keys(changes).length)
    options.state.update<Record<string, Cached>>(CACHE_KEY, (current) =>
      Object.fromEntries(
        Object.entries({ ...object(current), ...changes })
          .flatMap(([id, value]) => {
            const parsed = cachedSchema.safeParse(value);
            return ID.test(id) && parsed.success ? [[id, parsed.data] as const] : [];
          })
          .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
          .slice(0, 250),
      ),
    );
  return events.map((event, index) => {
    const pages = linked[index]!;
    // A dated event's explicit venue wins over unrelated article coordinates.
    // Multiple venues remain ambiguous; do not choose an arbitrary first point.
    const related = [
      ...new Set(
        pages.flatMap(({ id }) => {
          const entity = cache.get(id)?.entity;
          return entity?.years.includes(event.year) ? entity.places : [];
        }),
      ),
    ];
    const place = related.length === 1 && cache.get(related[0]!)?.entity;
    if (place && place.coordinate) {
      const article = pages.find(({ id }) => {
        const entity = cache.get(id)?.entity;
        return entity?.years.includes(event.year) && entity.places.includes(related[0]!);
      });
      return {
        ...event,
        ...(article
          ? {
              url: `https://uk.wikipedia.org/wiki/${encodeURIComponent(article.title.replaceAll(' ', '_'))}`,
            }
          : {}),
        location: {
          ...place.coordinate,
          label: place.label,
          sourceUrl: `https://www.wikidata.org/wiki/${related[0]}`,
          kind: 'event_place' as const,
        },
      };
    }
    if (event.location || related.length > 1) return event;
    const candidates = pages.flatMap(({ id, title }) => {
      const entity = cache.get(id)?.entity;
      return entity?.coordinate ? [{ id, title, entity }] : [];
    });
    if (candidates.length !== 1) return event;
    const candidate = candidates[0]!;
    return {
      ...event,
      location: {
        ...candidate.entity.coordinate!,
        label: candidate.title,
        sourceUrl: `https://www.wikidata.org/wiki/${candidate.id}`,
        kind: 'associated_article' as const,
      },
    };
  });
}
