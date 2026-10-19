import { loadStats, updateStats } from '../../kv-store.mjs';
import {
  leisureFeatures,
  knownLeisurePlace,
  leisurePlaceIndex,
  leisurePreferenceProfile,
} from './discovery.mjs';
import { routesEta } from '../adapters/maps.mjs';
import { readCalendarRange } from '../../google.mjs';
import { kyivDateKey } from '../../kyiv-time.mjs';
import {
  DEFAULT_LEISURE_SETTINGS,
  LEISURE_CATEGORIES,
  LEISURE_OPERATIONS,
  LeisureError,
  cleanText,
  dateKey,
  leisureWeek,
  leisureId,
  normalizeLeisurePlan,
  selectLeisureEdition,
} from './model.mjs';
import { normalizeLeisureFeedback } from './feedback.mjs';
import { leisureIdentity } from './identity.mjs';
import { leisureOpenDuring } from './planning.mjs';
import { leisureSlotMatches } from './schedule.mjs';
import { leisureFilmKeys } from './content-facts.mjs';
import { freshLeisurePlace } from './google-details.mjs';
import { leisurePlanChanges, leisureCatalogChanges } from './availability.mjs';

/** @param {Env} env */
export function leisureDb(env) {
  if (!env.DB) throw new LeisureError('Сховище дозвілля недоступне.', 503);
  return env.DB.withSession ? env.DB.withSession('first-primary') : env.DB;
}
/** @param {any} row */
export function recordOf(row) {
  return {
    ...JSON.parse(row.data_json),
    ...(row.item_id ? { itemId: String(row.item_id) } : {}),
    id: row.id,
    kind: row.kind,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}
/** @param {Env} env @param {string} id */
export async function leisureRecord(env, id) {
  const row = await leisureDb(env)
    .prepare('SELECT * FROM leisure_records WHERE id = ?')
    .bind(id)
    .first();
  return row ? recordOf(row) : null;
}
/** @param {Env} env */
export async function leisureSettings(env) {
  const record = await leisureRecord(env, 'settings');
  const value = { ...DEFAULT_LEISURE_SETTINGS, ...(record?.value ?? {}) };
  if (record?.value?.categoriesVersion !== 3)
    value.categories = [...new Set([...value.categories, 'place', 'meetup', 'podcast'])];
  if (record?.value?.notificationVersion !== 1) value.telegram = true;
  return value;
}
/** @param {Env} env */
export async function leisureItems(env) {
  const { results } = await leisureDb(env)
    .prepare('SELECT data_json FROM leisure_items ORDER BY checked_at DESC')
    .all();
  return results.map((r) => {
    const item = JSON.parse(String(r.data_json));
    // Legacy Google details must never masquerade as fresh availability.
    if (item.placeId) {
      delete item.placeDetails;
      item.siteUrl = null;
      item.hours = '';
    }
    return item;
  });
}
/** @param {Env} env @param {any[]} items */
export async function upsertLeisureItems(env, items) {
  const existing = await leisureItems(env);
  const tombstones = await leisureDb(env)
    .prepare("SELECT * FROM leisure_records WHERE kind='discovery'")
    .all();
  const byId = /** @type {Map<string,any>} */ (new Map());
  for (const item of existing) byId.set(item.id, item);
  for (const r of tombstones.results.map(recordOf))
    if (r.itemId && !byId.has(r.itemId))
      byId.set(r.itemId, {
        id: r.itemId,
        identityKey: r.identityKey,
        startDate: r.startDate ?? /\d{4}-\d{2}-\d{2}/.exec(r.identityKey ?? '')?.[0],
        status: r.status,
      });
  const identities = new Map(existing.map((i) => [i.identityKey ?? leisureIdentity(i), i]));
  const films = new Map();
  const indexFilm = (/** @type {any} */ item) => {
    for (const key of leisureFilmKeys(item)) {
      const prior = films.get(key);
      films.set(
        key,
        prior === null || (prior && prior.id !== item.id && key.startsWith('original:'))
          ? null
          : item,
      );
    }
  };
  existing.forEach(indexFilm);
  const canonical = [];
  for (const incoming of items) {
    const i = { ...incoming, identityKey: leisureIdentity(incoming) };
    if (i.placeId) {
      delete i.placeDetails;
      i.siteUrl = null;
      i.hours = '';
    }
    const prior = byId.get(i.id),
      newOccurrence =
        prior &&
        ['concert', 'festival', 'show', 'exhibition', 'meetup'].includes(i.category) &&
        prior.startDate &&
        i.startDate &&
        Date.parse(i.startDate) - Date.parse(prior.startDate) > 180 * 86400000 &&
        prior.status !== 'postponed';
    if (newOccurrence) i.id = await leisureId('item', i.sourceUrl + '|' + i.identityKey);
    const filmMatch = leisureFilmKeys(i)
      .map((key) => films.get(key))
      .find(
        (item) =>
          item && !(item.film?.imdbId && i.film?.imdbId && item.film.imdbId !== i.film.imdbId),
      );
    const match =
      identities.get(i.identityKey) ??
      filmMatch ??
      (!newOccurrence && prior?.sourceUrl ? prior : null);
    const row = match
      ? { id: match.id, data_json: JSON.stringify(match) }
      : i.placeId
        ? await leisureDb(env)
            .prepare(
              "SELECT id,data_json FROM leisure_items WHERE venue_id=? AND category='food' LIMIT 1",
            )
            .bind(i.venueId)
            .first()
        : null;
    const previous = row ? JSON.parse(String(row.data_json)) : null;
    if (previous?.category === 'cinema' && Array.isArray(i.sessions) && previous.sessions?.length) {
      const refreshedCinemas = new Set(i.sessions.map((/** @type {any} */ s) => s.cinemaSlug));
      const retained = previous.sessions.filter(
        (/** @type {any} */ s) =>
          !(i.source === 'Планета кіно'
            ? ['forum-lviv', 'king-cross-leopolis'].includes(s.cinemaSlug)
            : i.source === 'Multiplex'
              ? s.cinemaSlug === 'multiplex-victoria'
              : refreshedCinemas.has(s.cinemaSlug)) &&
          Date.parse(s.startAt) >= Date.parse(i.checkedAt),
      );
      i.sessions = [...i.sessions, ...retained].sort((a, b) => a.startAt.localeCompare(b.startAt));
      if (i.sessions.length && i.status === 'schedule-pending') i.status = 'available';
      i.startDate = i.sessions.length ? kyivDateKey(new Date(i.sessions[0].startAt)) : i.startDate;
      i.endDate = i.sessions.length ? kyivDateKey(new Date(i.sessions.at(-1).startAt)) : i.endDate;
      if (filmMatch && previous.source !== i.source) {
        i.source = previous.source;
        i.sourceUrl = previous.sourceUrl;
        i.identityKey = previous.identityKey;
        i.media = previous.media?.length ? previous.media : i.media;
      }
    }
    if (previous?.film && i.film)
      i.film = Object.fromEntries(
        Object.entries(i.film).map(([key, value]) => [
          key,
          value == null || value === '' ? (previous.film[key] ?? value) : value,
        ]),
      );
    const changes = previous ? leisureCatalogChanges(previous, i) : [];
    canonical.push(
      previous
        ? {
            ...i,
            id: String(row?.id ?? i.id),
            ...(i.placeId ? {} : { placeDetails: i.placeDetails ?? previous.placeDetails }),
            firstDiscoveredAt: previous.firstDiscoveredAt ?? previous.checkedAt,
            catalogChangedAt: changes.length ? i.checkedAt : (previous.catalogChangedAt ?? null),
            catalogChanges: changes.length ? changes : (previous.catalogChanges ?? []),
            genre: i.genre || previous.genre || '',
            siteUrl: i.placeId ? null : (i.siteUrl ?? previous.siteUrl),
            bookingUrl: i.bookingUrl ?? previous.bookingUrl,
          }
        : { ...i, firstDiscoveredAt: i.checkedAt },
    );
    identities.set(i.identityKey ?? leisureIdentity(i), canonical.at(-1));
    byId.set(i.id, canonical.at(-1));
    indexFilm(canonical.at(-1));
  }
  items = canonical;
  if (!items.length) return;
  for (let offset = 0; offset < items.length; offset += 40)
    await leisureDb(env).batch(
      items
        .slice(offset, offset + 40)
        .map((i) =>
          leisureDb(env)
            .prepare(
              'INSERT INTO leisure_items (id,venue_id,category,start_date,end_date,data_json,checked_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET venue_id=excluded.venue_id,category=excluded.category,start_date=excluded.start_date,end_date=excluded.end_date,data_json=excluded.data_json,checked_at=excluded.checked_at',
            )
            .bind(
              i.id,
              i.venueId,
              i.category,
              i.startDate,
              i.endDate,
              JSON.stringify(i),
              i.checkedAt,
            ),
        ),
    );
}
/** @param {Env} env @param {number} [nowMs] @param {boolean} [allHistory] */
export async function readLeisureWorkspace(env, nowMs = Date.now(), allHistory = false) {
  const db = leisureDb(env);
  const [items, settings, rows, editionRow, stats] = await Promise.all([
    leisureItems(env),
    leisureSettings(env),
    db
      .prepare(
        `SELECT * FROM leisure_records WHERE kind IN ('plan','visit','reaction','familiarity','profile','discovery','draft') ORDER BY updated_at DESC`,
      )
      .all(),
    db.prepare('SELECT * FROM leisure_editions ORDER BY week DESC LIMIT 1').first(),
    loadStats(env),
  ]);
  const learningRecords = rows.results.map(recordOf);
  const allRecords = learningRecords
    .filter((r) => !['profile', 'discovery'].includes(r.kind))
    .map((r) =>
      ['plan', 'draft'].includes(r.kind)
        ? { ...r, alerts: leisurePlanChanges(r, items, nowMs) }
        : r,
    );
  const recent = allRecords.slice(0, 250),
    recentIds = new Set(recent.map((r) => r.id));
  const records = allHistory
    ? allRecords
    : [
        ...recent,
        ...allRecords.filter(
          (r) =>
            !recentIds.has(r.id) && ['familiarity', 'reaction', 'draft', 'plan'].includes(r.kind),
        ),
      ];
  const saved = (stats.saved ?? [])
    .filter((/** @type {any} */ s) => s.kind === 'leisure')
    .map((/** @type {any} */ s) => String(s.id));
  const edition = editionRow ? JSON.parse(String(editionRow.data_json)) : null;
  const historyRows = await db
    .prepare('SELECT data_json FROM leisure_editions WHERE week < ?')
    .bind(leisureWeek(nowMs))
    .all();
  const previousIds = historyRows.results.flatMap((r) => {
    const old = JSON.parse(String(r.data_json));
    return old.offeredIds ?? [...old.ids, ...old.futureIds];
  });
  const selected = selectLeisureEdition(
    items.filter((i) => nowMs - Date.parse(i.checkedAt) <= 8 * 86400000),
    learningRecords,
    previousIds,
    settings,
    nowMs,
  );
  const needed = new Set([
    ...saved,
    ...selected.ids,
    ...selected.futureIds,
    ...records.flatMap((r) =>
      r.itemId ? [r.itemId] : (r.stops?.map((/** @type {any} */ s) => s.itemId) ?? []),
    ),
  ]);
  const total = await db
    .prepare(
      "SELECT COUNT(*) AS count FROM leisure_records WHERE kind IN ('plan','visit','reaction','familiarity')",
    )
    .first();
  const knownIndex = leisurePlaceIndex(allRecords);
  return {
    preferenceProfile: leisurePreferenceProfile(items, learningRecords, nowMs),
    knownPlaces: Object.fromEntries(
      items.map((i) => [i.id, knownLeisurePlace(i, allRecords, knownIndex)]),
    ),
    version: 1,
    discoveryDecisions: learningRecords
      .filter((r) => r.kind === 'discovery')
      .map((r) => ({
        kind: 'discovery',
        itemId: r.itemId,
        identityKey: r.identityKey,
        verdict: r.verdict,
        snoozeUntil: r.snoozeUntil ?? null,
        at: r.at,
      })),
    generatedAt: new Date(nowMs).toISOString(),
    settings,
    items: allHistory ? items : items.filter((i) => needed.has(i.id)),
    records,
    saved,
    edition: edition
      ? {
          ...edition,
          ...selected,
          createdAt: edition.createdAt,
          stale: edition.week !== leisureWeek(nowMs),
        }
      : null,
    historyLimit: allHistory ? records.length : 250,
    historyTotal: Number(total?.count ?? 0),
    refresh: (await leisureRecord(env, 'catalog-job')) ?? null,
    ...(allHistory
      ? {
          editionHistory: (
            await db.prepare('SELECT data_json FROM leisure_editions ORDER BY week DESC').all()
          ).results.map((r) => JSON.parse(String(r.data_json))),
        }
      : {}),
  };
}
/** @param {Env} env @param {any[]} items @param {any[]} sources @param {number} nowMs @param {boolean} [cinemaOnly] */
export async function publishLeisureEdition(env, items, sources, nowMs, cinemaOnly = false) {
  const db = leisureDb(env),
    week = leisureWeek(nowMs);
  await upsertLeisureItems(env, items);
  const [settings, records, editions, allItems] = await Promise.all([
    leisureSettings(env),
    db
      .prepare(
        "SELECT * FROM leisure_records WHERE kind IN ('visit','reaction','plan','familiarity','profile','discovery','draft')",
      )
      .all(),
    db.prepare('SELECT data_json FROM leisure_editions WHERE week < ?').bind(week).all(),
    leisureItems(env),
  ]);
  const previousIds = [
    ...new Set(
      editions.results.flatMap((r) => {
        const edition = JSON.parse(String(r.data_json));
        return edition.offeredIds ?? [...edition.ids, ...edition.futureIds];
      }),
    ),
  ];
  const currentRow = await db
    .prepare('SELECT data_json FROM leisure_editions WHERE week = ?')
    .bind(week)
    .first();
  const current = currentRow ? JSON.parse(String(currentRow.data_json)) : null;
  const selected = selectLeisureEdition(
    allItems.filter((i) => nowMs - Date.parse(i.checkedAt) <= 8 * 86400000),
    records.results.map(recordOf),
    previousIds,
    settings,
    nowMs,
  );
  const edition = {
    ...selected,
    catalogVersion: 4,
    offeredIds: [
      ...new Set([
        ...(current?.offeredIds ?? current?.ids ?? []),
        ...(current?.futureIds ?? []),
        ...selected.ids,
        ...selected.futureIds,
      ]),
    ],
    sources:
      cinemaOnly && current
        ? [
            ...current.sources.filter(
              (/** @type {any} */ s) => !sources.some((next) => next.id === s.id),
            ),
            ...sources,
          ]
        : sources,
    cinemaUpdatedAt: sources.some((s) => s.id === 'planeta' && s.status === 'ok')
      ? new Date(nowMs).toISOString()
      : (current?.cinemaUpdatedAt ?? null),
  };
  // Failed collection cannot replace an existing useful edition with an empty list.
  if (!items.length && current) {
    const kept = { ...current, sources: edition.sources };
    await db
      .prepare('UPDATE leisure_editions SET data_json=? WHERE week=?')
      .bind(JSON.stringify(kept), week)
      .run();
    return kept;
  }
  await db
    .prepare(
      'INSERT INTO leisure_editions (week,data_json,created_at) VALUES (?,?,?) ON CONFLICT(week) DO UPDATE SET data_json=excluded.data_json',
    )
    .bind(week, JSON.stringify(edition), edition.createdAt)
    .run();
  await compactLeisureCatalog(env, nowMs);
  return edition;
}
/** Retire unprotected ended cards during batch catalog updates, not on opens.
 * Personal visits/plans and their notes remain independently addressable.
 * @param {Env} env @param {number} nowMs */
export async function compactLeisureCatalog(env, nowMs) {
  const db = leisureDb(env);
  const [items, rows, stats] = await Promise.all([
    leisureItems(env),
    db.prepare('SELECT * FROM leisure_records').all(),
    loadStats(env),
  ]);
  const records = rows.results.map(recordOf);
  const protectedIds = new Set([
    ...(stats.saved ?? [])
      .filter((/** @type {any} */ s) => s.kind === 'leisure')
      .map((/** @type {any} */ s) => s.id),
    ...records
      .filter((r) => ['visit', 'plan', 'familiarity', 'draft'].includes(r.kind))
      .flatMap((r) =>
        r.itemId ? [r.itemId] : (r.stops ?? []).map((/** @type {any} */ s) => s.itemId),
      ),
    ...records
      .filter((r) => r.kind === 'reaction' && r.verdict === 'interested')
      .map((r) => r.itemId),
  ]);
  const expired = items
    .filter((i) => i.endDate && i.endDate < kyivDateKey(new Date(nowMs)) && !protectedIds.has(i.id))
    .slice(0, 80);
  if (!expired.length) return { removed: 0 };
  const ids = expired.map((i) => i.id),
    old = records.find((r) => r.kind === 'profile');
  const profile = leisurePreferenceProfile(
    items,
    records.filter(
      (r) => r.kind === 'profile' || (r.kind === 'reaction' && ids.includes(r.itemId)),
    ),
    nowMs,
  );
  const token = crypto.randomUUID();
  const snapshot = records
    .filter((r) => r.kind !== 'profile')
    .map((r) => `${r.id}:${r.revision}`)
    .sort()
    .join('|');
  const durableWeights = Object.fromEntries(
    Object.entries(profile.weights).filter(
      ([tag]) => !tag.startsWith('topic:') && !tag.startsWith('place:'),
    ),
  );
  const value = {
    id: 'preference-profile',
    kind: 'profile',
    weights: durableWeights,
    signals: profile.signals,
    at: new Date(nowMs).toISOString(),
    compactionId: token,
  };
  const placeholders = ids.map(() => '?').join(',');
  const guard =
    "EXISTS (SELECT 1 FROM leisure_records WHERE id='preference-profile' AND json_extract(data_json,'$.compactionId')=?)";
  const results = await db.batch([
    db
      .prepare(
        "INSERT INTO leisure_records(id,kind,data_json,revision,updated_at) SELECT 'preference-profile','profile',?,1,? WHERE COALESCE((SELECT group_concat(entry,'|') FROM (SELECT id || ':' || revision AS entry FROM leisure_records WHERE kind!='profile' ORDER BY id)), '')=? ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,revision=revision+1,updated_at=excluded.updated_at WHERE leisure_records.revision=?",
      )
      .bind(JSON.stringify(value), value.at, snapshot, old?.revision ?? 0),
    ...records
      .filter(
        (r) =>
          r.kind === 'reaction' &&
          ids.includes(r.itemId) &&
          ['uninterested', 'later'].includes(r.verdict),
      )
      .map((r) => {
        const item = items.find((i) => i.id === r.itemId),
          identityKey = r.identityKey ?? leisureIdentity(item);
        return db
          .prepare(
            "INSERT INTO leisure_records(id,kind,item_id,data_json,updated_at) SELECT ?,'discovery',?,?,? WHERE " +
              guard +
              ' ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json,updated_at=excluded.updated_at',
          )
          .bind(
            'discovery-' + r.itemId,
            r.itemId,
            JSON.stringify({
              identityKey,
              verdict: r.verdict,
              snoozeUntil: r.snoozeUntil ?? null,
              at: r.at,
              category: item?.category,
              startDate: item?.startDate,
              status: item?.status,
            }),
            value.at,
            token,
          );
      }),
    db
      .prepare(
        `DELETE FROM leisure_records WHERE kind='reaction' AND item_id IN (${placeholders}) AND ${guard}`,
      )
      .bind(...ids, token),
    db
      .prepare(`DELETE FROM leisure_items WHERE id IN (${placeholders}) AND ${guard}`)
      .bind(...ids, token),
  ]);
  return { removed: Number(results.at(-1)?.meta?.changes ?? 0) };
}
/** @param {any} input */
export function validateLeisureCommand(input) {
  if (!input || typeof input !== 'object' || !LEISURE_OPERATIONS.includes(input.op))
    throw new LeisureError('Цю дію не вдалося розпізнати.');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(input.commandId ?? ''))
    throw new LeisureError('Повтори дію з новим ідентифікатором.');
  const payload = input.payload ?? {};
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    JSON.stringify(payload).length > 20000
  )
    throw new LeisureError('Дані дії завеликі або некоректні.');
  return {
    op: input.op,
    commandId: input.commandId,
    id: input.id ? cleanText(input.id, 320) : null,
    payload,
  };
}
/** @param {Env} env @param {any} plan */
export async function checkLeisureCalendar(env, plan) {
  const events = await readCalendarRange(
    env,
    kyivDateKey(new Date(plan.startAt)),
    kyivDateKey(new Date(plan.endAt)),
  );
  return {
    available: events !== null,
    conflicts:
      events == null
        ? []
        : events
            .filter(
              (e) =>
                !e.transparent &&
                e.id !== plan.calendarId &&
                e.startMs != null &&
                e.endMs != null &&
                e.startMs < Date.parse(plan.endAt) &&
                e.endMs > Date.parse(plan.startAt),
            )
            .map((e) => ({
              id: e.id,
              title: e.title,
              startAt: new Date(e.startMs ?? 0).toISOString(),
              endAt: new Date(e.endMs ?? 0).toISOString(),
            })),
  };
}
/** @param {Env} env @param {any} record @param {number} nowMs @param {number | null} [expected] @param {boolean} [uniqueFilmDay] */
async function writeRecord(env, record, nowMs, expected = null, uniqueFilmDay = false) {
  const db = leisureDb(env),
    at = record.startAt ?? record.visitedOn ?? null;
  if (expected == null) {
    const inserted = await db
      .prepare(
        uniqueFilmDay
          ? "INSERT INTO leisure_records (id,kind,item_id,venue_id,at,data_json,revision,updated_at) SELECT ?,?,?,?,?,?,1,? WHERE NOT EXISTS (SELECT 1 FROM leisure_records WHERE kind='visit' AND item_id=? AND json_extract(data_json,'$.visitedOn')=?) ON CONFLICT(id) DO NOTHING"
          : 'INSERT INTO leisure_records (id,kind,item_id,venue_id,at,data_json,revision,updated_at) VALUES (?,?,?,?,?,?,1,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(
        record.id,
        record.kind,
        record.itemId ?? null,
        record.venueId ?? null,
        at,
        JSON.stringify(record),
        new Date(nowMs).toISOString(),
        ...(uniqueFilmDay ? [record.itemId, record.visitedOn] : []),
      )
      .run();
    if (!inserted.meta.changes) {
      const duplicate = await leisureRecord(env, record.id);
      if (
        record.lastCommandId &&
        duplicate?.lastCommandId === record.lastCommandId &&
        duplicate?.lastCommandFingerprint === record.lastCommandFingerprint
      )
        return;
      throw new LeisureError('Запис уже збережено або змінено. Онови дані перед повтором.', 409);
    }
  } else {
    const result = await db
      .prepare(
        'UPDATE leisure_records SET at=?,data_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND sync_claim_until < ?',
      )
      .bind(at, JSON.stringify(record), new Date(nowMs).toISOString(), record.id, expected, nowMs)
      .run();
    if (!result.meta.changes)
      throw new LeisureError(
        'Запис уже змінився або синхронізується. Онови дозвілля й повтори дію.',
        409,
      );
  }
}
/** Read-only acknowledgement lookup, also recovers a record whose receipt write
 * was interrupted. Never replay a mutation just to find out whether it committed.
 * @param {Env} env @param {string} commandId */
export async function inspectLeisureCommand(env, commandId) {
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(commandId))
    throw new LeisureError('Некоректний ідентифікатор дії.');
  const db = leisureDb(env);
  const saved = await db
    .prepare('SELECT receipt_json FROM leisure_commands WHERE id=?')
    .bind(commandId)
    .first();
  if (saved) return { found: true, ...JSON.parse(String(saved.receipt_json)) };
  const row = await db
    .prepare(
      "SELECT * FROM leisure_records WHERE json_extract(data_json,'$.lastCommandId')=? LIMIT 1",
    )
    .bind(commandId)
    .first();
  if (!row) return { found: false };
  const record = recordOf(row);
  return {
    found: true,
    fingerprint: record.lastCommandFingerprint,
    receipt: { message: 'Збережено.', id: record.id },
  };
}
/** Shared Mini App/assistant command boundary. No unsolicited messages.
 * @param {Env} env @param {any} raw @param {number} [nowMs] */
export async function executeLeisureCommand(env, raw, nowMs = Date.now()) {
  const command = validateLeisureCommand(raw),
    { op, id, payload, commandId } = command;
  const db = leisureDb(env);
  const fingerprint = JSON.stringify({ op, id, payload });
  const prior = await db
    .prepare('SELECT receipt_json FROM leisure_commands WHERE id=?')
    .bind(commandId)
    .first();
  if (prior) {
    const cached = JSON.parse(String(prior.receipt_json));
    if (cached.fingerprint !== fingerprint)
      throw new LeisureError('Цей ідентифікатор уже використано для іншої дії.', 409);
    return cached.receipt;
  }
  // Recover a committed record when the response/receipt write was interrupted.
  // Retrying the same command must not create another visit or fail its own CAS.
  const applied = await db
    .prepare(
      "SELECT * FROM leisure_records WHERE json_extract(data_json,'$.lastCommandId')=? LIMIT 1",
    )
    .bind(commandId)
    .first();
  if (applied) {
    const recovered = recordOf(applied);
    if (recovered.lastCommandFingerprint !== fingerprint)
      throw new LeisureError('Цей ідентифікатор уже використано для іншої дії.', 409);
    const receipt = { message: 'Збережено.', id: recovered.id, revision: recovered.revision };
    await db
      .prepare(
        'INSERT INTO leisure_commands(id,receipt_json,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(commandId, JSON.stringify({ fingerprint, receipt }), new Date(nowMs).toISOString())
      .run();
    return receipt;
  }
  /** @param {Env} targetEnv @param {any} record @param {number} atMs @param {number|null} [expected] @param {boolean} [uniqueFilmDay] */
  const writeCommandRecord = (targetEnv, record, atMs, expected = null, uniqueFilmDay = false) =>
    writeRecord(
      targetEnv,
      { ...record, lastCommandId: commandId, lastCommandFingerprint: fingerprint },
      atMs,
      expected,
      uniqueFilmDay,
    );
  /** @type {any} */ let receipt = { message: 'Збережено.' };
  const item = id
    ? await db.prepare('SELECT data_json FROM leisure_items WHERE id=?').bind(id).first()
    : null;
  const selectedItem = item ? JSON.parse(String(item.data_json)) : null;
  if (
    ['save', 'reaction', 'visit', 'familiarity', 'place-check', 'source-check'].includes(op) &&
    !selectedItem
  )
    throw new LeisureError('Цього варіанта вже немає. Онови добірку.', 404);
  if (op === 'settings') {
    const previous = await leisureSettings(env);
    if (payload.enabled != null && typeof payload.enabled !== 'boolean')
      throw new LeisureError('Укажи, чи ввімкнено оновлення.');
    if (payload.telegram != null && typeof payload.telegram !== 'boolean')
      throw new LeisureError('Укажи, чи надсилати дайджест.');
    if (payload.planAlerts != null && typeof payload.planAlerts !== 'boolean')
      throw new LeisureError('Укажи, чи повідомляти про зміни планів.');
    const categories = payload.categories ?? previous.categories;
    if (
      !Array.isArray(categories) ||
      !categories.length ||
      categories.some((c) => !LEISURE_CATEGORIES.includes(c))
    )
      throw new LeisureError('Обери хоча б один напрямок.');
    const cinemas = payload.cinemas ?? previous.cinemas;
    if (
      !Array.isArray(cinemas) ||
      !cinemas.length ||
      cinemas.some((c) => !['forum-lviv', 'king-cross', 'multiplex-victoria'].includes(c))
    )
      throw new LeisureError('Обери кінотеатр.');
    const students = payload.students ?? previous.students;
    if (!Number.isInteger(students) || students < 0 || students > 2)
      throw new LeisureError('Укажи кількість студентських квитків: 0, 1 або 2.');
    const current = await leisureRecord(env, 'settings');
    await writeCommandRecord(
      env,
      {
        id: 'settings',
        kind: 'settings',
        value: {
          ...previous,
          categories: [...new Set(categories)],
          categoriesVersion: 3,
          notificationVersion: 1,
          cinemas: [...new Set(cinemas)],
          students,
          enabled: payload.enabled ?? previous.enabled,
          retention: 'until-deleted',
          telegram: payload.telegram ?? previous.telegram,
          planAlerts: payload.planAlerts ?? previous.planAlerts,
        },
      },
      nowMs,
      current?.revision ?? null,
    );
  } else if (op === 'save') {
    if (typeof payload.saved !== 'boolean')
      throw new LeisureError('Уточни, зберегти чи прибрати варіант.');
    await updateStats(env, (stats) => {
      const saved = Array.isArray(stats.saved) ? stats.saved : [];
      stats.saved = saved.filter((/** @type {any} */ s) => !(s.kind === 'leisure' && s.id === id));
      if (payload.saved)
        stats.saved.unshift({
          kind: 'leisure',
          id,
          title: selectedItem.title,
          ts: kyivDateKey(new Date(nowMs)),
        });
      return stats;
    });
  } else if (op === 'reaction') {
    if (!['interested', 'uninterested', 'later', 'clear'].includes(payload.verdict))
      throw new LeisureError('Обери реакцію на варіант.');
    const key = `reaction-${id}`,
      current = await leisureRecord(env, key);
    if (payload.revision != null && payload.revision !== (current?.revision ?? 0))
      throw new LeisureError('Вибір уже змінився. Онови дозвілля.', 409);
    let feedback;
    try {
      feedback = normalizeLeisureFeedback(selectedItem, payload, current, nowMs);
    } catch (error) {
      throw new LeisureError(error instanceof Error ? error.message : 'Перевір причини вибору.');
    }
    await writeCommandRecord(
      env,
      {
        id: key,
        kind: 'reaction',
        itemId: id,
        venueId: selectedItem.venueId,
        verdict: payload.verdict,
        ...feedback,
        category: selectedItem.category,
        identityKey: selectedItem.identityKey ?? leisureIdentity(selectedItem),
        reason: cleanText(feedback.reason, 300),
        features: leisureFeatures(selectedItem),
        at: new Date(nowMs).toISOString(),
      },
      nowMs,
      current?.revision ?? null,
    );
    receipt = { message: 'Вибір збережено.', revision: (current?.revision ?? 0) + 1 };
  } else if (op === 'familiarity') {
    if (!['unknown', 'many', 'count', 'clear'].includes(payload.mode))
      throw new LeisureError('Обери, що пам’ятаєш про попередні відвідування.');
    const previousCount = payload.mode === 'count' ? Number(payload.previousCount) : null;
    if (
      payload.mode === 'count' &&
      (!Number.isSafeInteger(previousCount) ||
        Number(previousCount) < 1 ||
        Number(previousCount) > 100000)
    )
      throw new LeisureError('Укажи цілу додатну кількість попередніх відвідувань.');
    const key = `familiarity-${selectedItem.venueId ?? id}`;
    const current = await leisureRecord(env, key);
    if (payload.revision != null && Number(payload.revision) !== (current?.revision ?? 0))
      throw new LeisureError('Попередній досвід уже змінився. Онови дані.', 409);
    await writeCommandRecord(
      env,
      {
        id: key,
        kind: 'familiarity',
        itemId: id,
        venueId: selectedItem.venueId,
        title: selectedItem.title,
        mode: payload.mode,
        previousCount,
        trackingSince: current?.trackingSince ?? new Date(nowMs).toISOString(),
        cleared: payload.mode === 'clear',
      },
      nowMs,
      current?.revision ?? null,
    );
    receipt = {
      message: 'Попередній досвід збережено. Нові відвідування рахуватимуться окремо.',
      id: key,
    };
  } else if (op === 'source-check') {
    const { checkLeisureSource } = await import('./catalog.mjs');
    const result = await checkLeisureSource(selectedItem, nowMs);
    if (result.item !== selectedItem) await upsertLeisureItems(env, [result.item]);
    return {
      message: result.verified
        ? 'Дату й статус звірено з джерелом.'
        : 'Сторінка доступна. Остаточні умови перевір у джерелі.',
      status: result.item.status,
      verified: result.verified,
    };
  } else if (op === 'place-check') {
    if (!selectedItem.placeId) throw new LeisureError('Для цього місця ще немає Google Place ID.');
    const place = await freshLeisurePlace(env, selectedItem.placeId, nowMs);
    return { message: 'Інформацію закладу перевірено для цього перегляду.', place };
  } else if (op === 'journey-check') {
    const normalized = normalizeLeisurePlan(payload),
      items = await leisureItems(env),
      lookup = new Map(items.map((i) => [i.id, i]));
    const legs = [];
    for (let n = 1; n < normalized.stops.length; n++) {
      const a = normalized.stops[n - 1],
        b = normalized.stops[n],
        ai = lookup.get(a.itemId),
        bi = lookup.get(b.itemId);
      const address = (/** @type {any} */ item, /** @type {any} */ stop) =>
        item?.sessions?.find((/** @type {any} */ session) => session.id === stop.sessionId)
          ?.address ?? item?.address;
      const from = address(ai, a),
        to = address(bi, b);
      if (!from || !to) {
        legs.push({ from: a.itemId, to: b.itemId, available: false });
        continue;
      }
      try {
        const eta = await routesEta(
          env,
          {
            from: { address: from },
            to: { address: to },
            mode: normalized.transport,
            departAtMs: Date.parse(a.endAt),
          },
          nowMs,
        );
        const gap = Math.floor((Date.parse(b.startAt) - Date.parse(a.endAt)) / 60000);
        legs.push({
          from: a.itemId,
          to: b.itemId,
          available: true,
          minutes: eta.duration_min,
          distanceM: eta.distance_m,
          gapMinutes: gap,
          enoughTime: gap >= eta.duration_min,
        });
      } catch {
        legs.push({ from: a.itemId, to: b.itemId, available: false });
      }
    }
    return { message: 'Дорогу перевірено.', legs };
  } else if (op === 'visit') {
    if (payload.rating != null && !['liked', 'neutral', 'disliked'].includes(payload.rating))
      throw new LeisureError('Обери коротку оцінку.');
    const visitedOn = dateKey(payload.visitedOn, true);
    if (visitedOn && visitedOn > kyivDateKey(new Date(nowMs)))
      throw new LeisureError('Відвідування не може бути в майбутньому.');
    const plan = payload.planId ? await leisureRecord(env, cleanText(payload.planId, 320)) : null;
    if (
      payload.planId &&
      (!plan || plan.kind !== 'plan' || !plan.stops.some((/** @type {any} */ s) => s.itemId === id))
    )
      throw new LeisureError('Цей варіант не належить до обраного плану.');
    const existingVisit = payload.visitId
      ? await leisureRecord(env, cleanText(payload.visitId, 320))
      : null;
    if (
      payload.visitId &&
      (!existingVisit || existingVisit.kind !== 'visit' || existingVisit.itemId !== id)
    )
      throw new LeisureError('Відвідування не знайдено.', 404);
    if (existingVisit && Number(payload.revision) !== existingVisit.revision)
      throw new LeisureError('Відгук уже змінився. Онови історію.', 409);
    if (
      !existingVisit &&
      visitedOn &&
      selectedItem.category === 'cinema' &&
      payload.allowRepeat !== true
    ) {
      const duplicate = await db
        .prepare(
          "SELECT id FROM leisure_records WHERE kind='visit' AND item_id=? AND json_extract(data_json,'$.visitedOn')=? LIMIT 1",
        )
        .bind(id, visitedOn)
        .first();
      if (duplicate)
        throw new LeisureError(
          'Цей перегляд за цю дату вже записано. Відкрий історію й доповни враження або підтвердь, що це окремий повторний перегляд.',
          409,
        );
    }
    const visitId = existingVisit?.id ?? (plan ? `visit-${plan.id}-${id}` : `visit-${commandId}`);
    await writeCommandRecord(
      env,
      {
        id: visitId,
        kind: 'visit',
        itemId: id,
        venueId: selectedItem.venueId,
        category: selectedItem.category,
        title: selectedItem.title,
        visitedOn,
        features: leisureFeatures(selectedItem),
        legacy: payload.legacy === true || existingVisit?.legacy === true,
        rating: payload.rating ?? null,
        reason: cleanText(payload.reason, 500),
        at: new Date(nowMs).toISOString(),
        planId: plan?.id ?? existingVisit?.planId ?? null,
      },
      nowMs,
      existingVisit?.revision ?? null,
      selectedItem.category === 'cinema' && !!visitedOn && payload.allowRepeat !== true,
    );
    receipt = {
      message:
        selectedItem.category === 'podcast'
          ? 'Прослуховування збережено.'
          : 'Відвідування збережено.',
      id: visitId,
    };
  } else if (op === 'draft') {
    const normalized = normalizeLeisurePlan({ ...payload, calendar: false }),
      draftId = id ?? 'draft-' + commandId,
      old = id ? await leisureRecord(env, id) : null;
    const candidates = await leisureItems(env);
    if (
      normalized.stops.some(
        (/** @type {any} */ s) =>
          !candidates.some((i) => i.id === s.itemId && i.category !== 'podcast'),
      )
    )
      throw new LeisureError('Перевір місця у чернетці.');
    if (old && (old.kind !== 'draft' || old.revision !== normalized.revision))
      throw new LeisureError('Чернетка вже змінилася. Онови її.', 409);
    for (const stop of normalized.stops) {
      const item = candidates.find((i) => i.id === stop.itemId),
        session = item.sessions?.find((/** @type {any} */ s) => s.id === stop.sessionId);
      Object.assign(stop, {
        title: item.title,
        address: session?.address ?? item.address,
        venueId: item.venueId,
        sourceUrl: session?.url ?? item.sourceUrl,
        catalogCheckedAt: item.checkedAt,
      });
    }
    await writeCommandRecord(
      env,
      {
        ...normalized,
        id: draftId,
        kind: 'draft',
        createdAt: old?.createdAt ?? new Date(nowMs).toISOString(),
      },
      nowMs,
      old?.revision ?? null,
    );
    receipt = { message: 'Чернетку збережено.', id: draftId };
  } else if (op === 'discard-draft') {
    const draft = id ? await leisureRecord(env, id) : null;
    if (!draft || draft.kind !== 'draft') throw new LeisureError('Чернетку не знайдено.', 404);
    if (payload.revision !== draft.revision) throw new LeisureError('Чернетка вже змінилася.', 409);
    await writeCommandRecord(env, { ...draft, discarded: true }, nowMs, draft.revision);
    receipt = { message: 'Чернетку прибрано.' };
  } else if (op === 'plan' || op === 'calendar-check') {
    const normalized = normalizeLeisurePlan(payload),
      old = id ? await leisureRecord(env, id) : null;
    if (id && (!old || old.kind !== 'plan')) throw new LeisureError('План не знайдено.', 404);
    if (old && old.revision !== normalized.revision)
      throw new LeisureError('План уже змінився. Онови його перед редагуванням.', 409);
    const items = await leisureItems(env),
      lookup = new Map(items.map((i) => [i.id, i]));
    const sourceWarnings = [];
    let checkedPlaces = 0;
    for (const stop of normalized.stops) {
      const candidate = lookup.get(stop.itemId);
      if (!candidate?.placeId) continue;
      if (checkedPlaces < 3) {
        checkedPlaces++;
        try {
          candidate.placeDetails = await freshLeisurePlace(env, candidate.placeId, nowMs);
        } catch {
          /* Manual confirmation remains explicit. */
        }
      }
      if (leisureOpenDuring(candidate, Date.parse(stop.startAt), Date.parse(stop.endAt)) == null)
        sourceWarnings.push(candidate.title);
    }
    for (const stop of normalized.stops) {
      const candidate = lookup.get(stop.itemId);
      if (candidate?.category === 'podcast')
        throw new LeisureError('Онлайн-подкаст зберігається в колекції, а не в маршруті виходу.');
      if (!candidate || ['cancelled', 'sold-out', 'postponed'].includes(candidate.status))
        throw new LeisureError('Один із варіантів недоступний. Перевір склад плану.');
      const hours = leisureOpenDuring(candidate, Date.parse(stop.startAt), Date.parse(stop.endAt));
      const uncertainSchedule =
        ['inferred', 'conflicting'].includes(candidate.schedule?.precision) ||
        ['on-request', 'unverified'].includes(candidate.schedule?.kind) ||
        candidate.schedule?.confirmationRequired;
      const manualConfirmation =
        uncertainSchedule &&
        (op === 'calendar-check' ||
          (normalized.sourceAvailabilityConfirmed &&
            (candidate.schedule?.kind !== 'on-request' || stop.reservation || stop.tickets)));
      if (
        !leisureSlotMatches(candidate, Date.parse(stop.startAt), Date.parse(stop.endAt)) &&
        !manualConfirmation
      )
        throw new LeisureError(
          'Розклад або умови участі не підтверджують цей час. Звір подію з організатором.',
        );
      if (hours === false)
        throw new LeisureError('Заклад зачинений у вибраний час. Зміни години плану.');
      if (Date.parse(stop.startAt) < nowMs)
        throw new LeisureError(
          'Для нового плану обери майбутній час. Минулі відвідування записуються окремо.',
        );
      if (
        !['food', 'trip'].includes(candidate.category) &&
        nowMs - Date.parse(candidate.checkedAt) > 8 * 86400000
      )
        throw new LeisureError(
          'Цей варіант давно не перевірявся. Онови добірку перед плануванням.',
        );
      if (
        candidate.schedule?.kind !== 'recurring' &&
        candidate.endAt &&
        Date.parse(candidate.endAt) <= nowMs
      )
        throw new LeisureError('Ця подія вже завершилася. Можна записати минуле відвідування.');
      const stopDate = kyivDateKey(new Date(stop.startAt));
      if (
        (candidate.startDate && stopDate < candidate.startDate) ||
        (candidate.endDate && stopDate > candidate.endDate)
      )
        throw new LeisureError('Обраний день поза датами цієї події.');
      stop.title = candidate.title;
      stop.address = candidate.address;
      stop.venueId = candidate.venueId;
      stop.sourceUrl = candidate.sourceUrl;
      if (
        candidate.category === 'cinema' &&
        (['Планета кіно', 'Multiplex'].includes(candidate.source) || candidate.sessions?.length)
      ) {
        const session = candidate.sessions.find((/** @type {any} */ s) => s.id === stop.sessionId);
        if (!session || Date.parse(session.startAt) !== Date.parse(stop.startAt))
          throw new LeisureError('Обери підтверджений сеанс у кінотеатрі.');
        const expectedEnd = session.endAt
          ? Date.parse(session.endAt)
          : candidate.durationMinutes
            ? Date.parse(session.startAt) + candidate.durationMinutes * 60000
            : null;
        if (expectedEnd != null && Date.parse(stop.endAt) < expectedEnd)
          throw new LeisureError('У плані потрібно врахувати повну тривалість сеансу.');
        stop.address = session.address;
        stop.venueId = `${candidate.source === 'Multiplex' ? 'multiplex' : 'planeta'}:${session.cinemaSlug}`;
        stop.sourceUrl = session.url ?? candidate.sourceUrl;
      }
    }
    const check = await checkLeisureCalendar(env, { ...normalized, calendarId: old?.calendarId });
    if (op === 'calendar-check')
      return { message: 'Календар перевірено.', ...check, sourceWarnings };
    if (sourceWarnings.length && !normalized.sourceAvailabilityConfirmed)
      throw new LeisureError(
        'Не вдалося підтвердити години всіх закладів. Перевір їх самостійно та явно погодь доступність.',
        409,
      );
    if (check.conflicts.length && !normalized.conflictConfirmed)
      throw new LeisureError('У календарі є накладка. Перевір її та явно погодь час.', 409);
    if (!check.available && !normalized.calendarUnavailableConfirmed)
      throw new LeisureError(
        'Календар не вдалося перевірити. Погодь збереження без перевірки або повтори пізніше.',
        409,
      );
    const planId = id ?? `plan-${commandId}`;
    const plan = {
      ...old,
      ...normalized,
      id: planId,
      kind: 'plan',
      status: 'planned',
      calendarState: normalized.calendar ? 'pending' : old?.calendarId ? 'delete-pending' : 'none',
      calendarId: old?.calendarId ?? null,
      lastSynced: old?.lastSynced ?? null,
    };
    await writeCommandRecord(env, plan, nowMs, old?.revision ?? null);
    if (normalized.sourceDraftId) {
      const draft = await leisureRecord(env, normalized.sourceDraftId);
      if (draft?.kind === 'draft' && !draft.discarded)
        await writeRecord(env, { ...draft, discarded: true, planId }, nowMs, draft.revision).catch(
          () => console.warn('leisure.draft-conversion-pending'),
        );
    }
    const { syncLeisurePlan } = await import('./calendar.mjs');
    await syncLeisurePlan(env, planId, nowMs);
    const stored = await leisureRecord(env, planId);
    receipt = {
      message:
        stored?.calendarState === 'synced'
          ? 'План збережено й додано в Google Calendar.'
          : stored?.calendarState === 'none'
            ? 'План збережено без календарного запису.'
            : stored?.calendarState === 'conflict'
              ? 'План збережено. У календарі є ручні зміни — потрібна перевірка.'
              : 'План збережено. Синхронізація з Google Calendar ще не підтверджена.',
      id: planId,
      title: normalized.title,
      calendarState: stored?.calendarState,
    };
  } else if (op === 'cancel' || op === 'outcome') {
    const plan = id ? await leisureRecord(env, id) : null;
    if (!plan || plan.kind !== 'plan') throw new LeisureError('План не знайдено.', 404);
    if (Number(payload.revision) !== plan.revision)
      throw new LeisureError('План уже змінився. Онови його.', 409);
    if (op === 'outcome' && !['went', 'not-went'].includes(payload.status))
      throw new LeisureError('Обери, чи відбулося відвідування.');
    const status = op === 'cancel' ? 'cancelled' : payload.status;
    await writeCommandRecord(
      env,
      {
        ...plan,
        status,
        calendarState: op === 'cancel' && plan.calendarId ? 'delete-pending' : plan.calendarState,
        reason: cleanText(payload.reason, 300),
      },
      nowMs,
      plan.revision,
    );
    if (op === 'cancel') {
      const { syncLeisurePlan } = await import('./calendar.mjs');
      await syncLeisurePlan(env, plan.id, nowMs);
    }
  } else if (op === 'refresh') {
    if (!env.LEISURE_CATALOG) throw new LeisureError('Фонове оновлення ще налаштовується.', 503);
    receipt = await env.LEISURE_CATALOG.getByName('owner').request('full', nowMs);
  } else if (op === 'clear') {
    if (payload.confirmed !== true)
      throw new LeisureError(
        'Підтвердь очищення історії. Події Google Calendar лишаться в календарі.',
      );
    await db.batch([
      db.prepare("DELETE FROM leisure_records WHERE kind != 'settings'"),
      db.prepare('DELETE FROM leisure_editions'),
      db.prepare('DELETE FROM leisure_commands'),
    ]);
    await updateStats(env, (stats) => {
      stats.saved = (stats.saved ?? []).filter((/** @type {any} */ s) => s.kind !== 'leisure');
      return stats;
    });
    receipt = { message: 'Історію дозвілля очищено. Календарні події залишилися.' };
  }
  await db
    .prepare(
      'INSERT INTO leisure_commands (id,receipt_json,created_at) VALUES (?,?,?) ON CONFLICT(id) DO NOTHING',
    )
    .bind(commandId, JSON.stringify({ fingerprint, receipt }), new Date(nowMs).toISOString())
    .run();
  return receipt;
}
