import { DurableObject } from 'cloudflare:workers';
import { collectSource, checkLeisureSource, PUBLIC_LEISURE_SOURCES } from './catalog.mjs';
import { placesSearch } from '../adapters/maps.mjs';
import {
  leisureSettings,
  readLeisureWorkspace,
  leisureItems,
  upsertLeisureItems,
  publishLeisureEdition,
} from './store.mjs';
import { kyivHour } from '../../kyiv-time.mjs';
import { leisureWeek, normalizeLeisureItem } from './model.mjs';
import {
  leisureDiscoveryQueries,
  leisureDiscoveryBounds,
  leisureDiscoveredCategory,
} from './discovery-queries.mjs';
import { leisureSourceCoverage, leisureSourceDiagnostics } from './venue-sources.mjs';
import { queueLeisureDigest, queueLeisurePlanAlerts } from './notifications.mjs';
/** Separate alarm invocations keep each batch below the Free external-request limit. */
export class LeisureCatalogDO extends DurableObject {
  #busy = false;
  #requests = Promise.resolve();
  /** @param {'full'|'daily'} mode @param {number} [nowMs] */
  async request(mode = 'full', nowMs = Date.now()) {
    const next = this.#requests.then(() => this.enqueue(mode, nowMs));
    this.#requests = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
  /** @param {'full'|'daily'} mode @param {number} nowMs */
  async enqueue(mode, nowMs) {
    const job = /** @type {any} */ (await this.ctx.storage.get('job'));
    if (job?.active) return { message: 'Каталог уже оновлюється у фоні.' };
    if (job?.completedAt && nowMs - Date.parse(job.completedAt) < 300000)
      return { message: 'Каталог щойно оновлено.' };
    if (
      mode === 'daily' &&
      job?.mode === 'daily' &&
      job?.completedAt &&
      nowMs - Date.parse(job.completedAt) < 3 * 3600000
    )
      return { message: 'Повторна перевірка кіно запланована пізніше.' };
    const workspace = await readLeisureWorkspace(/** @type {Env} */ (this.env), nowMs, true);
    const watched = workspace
      ? new Set([
          ...workspace.saved,
          ...workspace.records
            .filter((r) => r.kind === 'plan' && r.status === 'planned')
            .flatMap((r) => r.stops.map((/** @type {any} */ stop) => stop.itemId)),
        ])
      : new Set();
    const tasks =
      mode === 'daily'
        ? [
            { id: 'planeta', offset: 0 },
            ...(workspace.settings.cinemas.includes('multiplex-victoria')
              ? [{ id: 'multiplex', offset: 0 }]
              : []),
            ...(workspace?.items ?? [])
              .filter(
                (i) =>
                  (watched.has(i.id) ||
                    workspace.records.some(
                      (r) =>
                        r.kind === 'reaction' &&
                        r.itemId === i.id &&
                        r.verdict === 'interested' &&
                        nowMs - Date.parse(i.checkedAt) >=
                          (r.interestLevel === 'priority'
                            ? 86400000
                            : i.startAt && Date.parse(i.startAt) - nowMs < 3 * 86400000
                              ? 86400000
                              : 3 * 86400000),
                    )) &&
                  !['food', 'cinema', 'trip', 'place', 'podcast'].includes(i.category) &&
                  (!i.endDate || i.endDate >= new Date(nowMs).toISOString().slice(0, 10)),
              )
              .map((i) => ({ id: `watched-${i.id}`, item: i, offset: 0 })),
          ]
        : [
            ...PUBLIC_LEISURE_SOURCES.map((s) => ({ id: s.id, offset: 0 })),
            ...leisureDiscoveryQueries(workspace.settings, workspace.preferenceProfile, nowMs).map(
              (entry, index) => ({ id: 'places-' + index, ...entry, offset: 0 }),
            ),
          ];
    const next = {
      active: true,
      mode,
      week: leisureWeek(nowMs),
      tasks,
      index: 0,
      sources: [],
      requestedAt: new Date(nowMs).toISOString(),
    };
    await this.ctx.storage.put('job', next);
    await this.status(next);
    await this.ctx.storage.setAlarm(Date.now() + 50);
    return { message: 'Оновлення запущено. Каталог поповнюється у фоні.' };
  }
  /** @param {any} job */
  async status(job) {
    const env = /** @type {Env} */ (this.env);
    if (!env.DB) throw new Error('Catalogue database unavailable');
    const data = {
      active: job.active,
      done: job.index,
      total: job.tasks.length,
      requestedAt: job.requestedAt,
      completedAt: job.completedAt ?? null,
    };
    await env.DB.prepare(
      "INSERT INTO leisure_records(id,kind,data_json,updated_at) VALUES('catalog-job','system',?,?) ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at",
    )
      .bind(JSON.stringify(data), new Date().toISOString())
      .run();
  }
  /** @override */
  async alarm() {
    if (this.#busy) return;
    this.#busy = true;
    try {
      await this.advance();
    } finally {
      this.#busy = false;
    }
  }
  async advance() {
    const env = /** @type {Env} */ (this.env),
      job = /** @type {any} */ (await this.ctx.storage.get('job'));
    if (!job?.active) return;
    const settings = await leisureSettings(env);
    if (!settings.enabled) {
      job.active = false;
      await this.ctx.storage.put('job', job);
      await this.status(job);
      return;
    }
    if (job.index === job.tasks.length) {
      const now = Date.now(),
        hour = kyivHour(new Date(now));
      if (hour < settings.updateHour) {
        const d = new Date(now);
        await this.ctx.storage.setAlarm(
          now +
            (settings.updateHour - hour) * 3600000 -
            d.getUTCMinutes() * 60000 -
            d.getUTCSeconds() * 1000 -
            d.getUTCMilliseconds(),
        );
        return;
      }
      const collected = (await leisureItems(env)).filter(
        (i) => Date.parse(i.checkedAt) >= Date.parse(job.requestedAt),
      );
      await publishLeisureEdition(env, collected, job.sources, now, job.mode === 'daily');
      await queueLeisurePlanAlerts(env, now).catch(() => console.warn('leisure.plan-alert-failed'));
      if (job.mode === 'full')
        await queueLeisureDigest(env, now).catch((error) =>
          console.warn('leisure.digest-failed', error instanceof Error ? error.message : 'unknown'),
        );
      job.active = false;
      job.completedAt = new Date(now).toISOString();
      await this.ctx.storage.put('job', job);
      await this.status(job);
      return;
    }
    const task = job.tasks[job.index],
      now = Date.now();
    const source = PUBLIC_LEISURE_SOURCES.find((s) => s.id === task.id);
    let nextOffset = null,
      count = 0,
      coverage = leisureSourceCoverage([]),
      diagnostics = leisureSourceDiagnostics(0, 0, [], now),
      state = 'unavailable',
      errorCode = null;
    try {
      let items;
      if (task.item) {
        const result = await checkLeisureSource(task.item, now);
        items = result.item !== task.item ? [result.item] : [];
        diagnostics = leisureSourceDiagnostics(1, items.length, items, now);
      } else if (task.id.startsWith('places-')) {
        const result = await placesSearch(
          env,
          {
            query: task.query,
            city: settings.city,
            limit: 20,
            scope: 'leisure',
            bounds: leisureDiscoveryBounds(settings.city),
          },
          now,
        );
        if (result.source !== 'api') throw new Error('places-not-fresh');
        items = (
          await Promise.all(
            result.places.map((p) =>
              normalizeLeisureItem(
                {
                  title: p.name,
                  category: leisureDiscoveredCategory(p, task.category ?? 'food'),
                  placeId: p.place_id,
                  placeType: p.place_type,
                  address: p.address,
                  venue: p.name,
                  lat: p.lat,
                  lon: p.lon,
                  source: 'Google Places',
                  sourceUrl:
                    p.maps_uri ??
                    `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name)}&query_place_id=${encodeURIComponent(p.place_id)}`,
                  summary:
                    'Заклад у Львові. Меню, години роботи й бронювання перевіряються перед плануванням.',
                },
                now,
              ),
            ),
          )
        ).filter(Boolean);
        diagnostics = leisureSourceDiagnostics(result.places.length, items.length, items, now);
      } else {
        const result = /** @type {any} */ (
          await collectSource(source, now, {
            ...settings,
            sourceOffset: task.offset,
            sourceBatch: 10,
          })
        );
        items = result;
        nextOffset = result.nextOffset ?? null;
        diagnostics =
          result.diagnostics ?? leisureSourceDiagnostics(items.length, items.length, items, now);
      }
      await upsertLeisureItems(env, items);
      count = items.length;
      coverage = leisureSourceCoverage(items);
      state = count ? 'ok' : 'empty';
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      errorCode =
        /^source-[a-z-]+(?:-\d{3})?$|^planeta-schedule-unavailable$|^places-not-fresh$/.test(
          message,
        )
          ? message
          : error instanceof Error && /Timeout|Abort/.test(error.name)
            ? 'source-timeout'
            : 'source-fetch-failed';
      // One bounded retry of the approved source, with no new domains or model calls.
      if (source && !task.retried) {
        task.retried = true;
        await this.ctx.storage.put('job', job);
        await this.status(job);
        await this.ctx.storage.setAlarm(Date.now() + 30000);
        return;
      }
    }
    const prior = job.sources.find((/** @type {any} */ s) => s.id === task.id);
    const status = {
      id: task.id,
      name: source?.name ?? task.item?.source ?? `Google Places · ${task.query}`,
      url: source?.url ?? task.item?.sourceUrl ?? 'https://maps.google.com/',
      status: count + (prior?.count ?? 0) > 0 ? 'ok' : state,
      checkedAt: new Date(now).toISOString(),
      errorCode,
      count: count + (prior?.count ?? 0),
      diagnostics: Object.fromEntries(
        Object.entries(diagnostics).map(([key, value]) => [
          key,
          value + (prior?.diagnostics?.[key] ?? 0),
        ]),
      ),
      coverage: Object.fromEntries(
        Object.entries(coverage).map(([key, value]) => [
          key,
          value + (prior?.coverage?.[key] ?? 0),
        ]),
      ),
    };
    job.sources = job.sources.filter((/** @type {any} */ s) => s.id !== task.id);
    job.sources.push(status);
    if (nextOffset != null) task.offset = nextOffset;
    else job.index++;
    await this.ctx.storage.put('job', job);
    await this.status(job);
    if (job.active) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
}
