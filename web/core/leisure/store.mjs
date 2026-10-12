import { loadStats, updateStats } from '../../kv-store.mjs';
import {
  FEEDBACK_REASONS,
  leisureFeatures,
  knownLeisurePlace,
  leisurePlaceIndex,
} from './discovery.mjs';
import { placeDetails, routesEta } from '../adapters/maps.mjs';
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
  normalizeLeisurePlan,
  httpLink,
  selectLeisureEdition,
} from './model.mjs';

/** @param {Env} env */
export function leisureDb(env) {
  if (!env.DB) throw new LeisureError('Сховище дозвілля недоступне.', 503);
  return env.DB;
}
/** @param {any} row */
export function recordOf(row) {
  return { ...JSON.parse(row.data_json), id: row.id, kind: row.kind, revision: row.revision };
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
  return { ...DEFAULT_LEISURE_SETTINGS, ...(record?.value ?? {}) };
}
/** @param {Env} env */
export async function leisureItems(env) {
  const { results } = await leisureDb(env)
    .prepare('SELECT data_json FROM leisure_items ORDER BY checked_at DESC')
    .all();
  return results.map((r) => JSON.parse(String(r.data_json)));
}
/** @param {Env} env @param {any[]} items */
export async function upsertLeisureItems(env, items) {
  const canonical = [];
  for (const i of items) {
    const row = i.placeId
      ? await leisureDb(env)
          .prepare(
            "SELECT id,data_json FROM leisure_items WHERE venue_id=? AND category='food' LIMIT 1",
          )
          .bind(i.venueId)
          .first()
      : null;
    const previous = row ? JSON.parse(String(row.data_json)) : null;
    canonical.push(
      previous
        ? {
            ...i,
            id: String(row?.id ?? i.id),
            placeDetails: i.placeDetails ?? previous.placeDetails,
            siteUrl: i.siteUrl ?? previous.siteUrl,
            bookingUrl: i.bookingUrl ?? previous.bookingUrl,
          }
        : i,
    );
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
        `SELECT * FROM leisure_records WHERE kind IN ('plan','visit','reaction','familiarity') ORDER BY updated_at DESC`,
      )
      .all(),
    db.prepare('SELECT * FROM leisure_editions ORDER BY week DESC LIMIT 1').first(),
    loadStats(env),
  ]);
  const allRecords = rows.results.map(recordOf);
  const recent = allRecords.slice(0, 250),
    recentIds = new Set(recent.map((r) => r.id));
  const records = allHistory
    ? allRecords
    : [
        ...recent,
        ...allRecords.filter(
          (r) => !recentIds.has(r.id) && ['familiarity', 'reaction'].includes(r.kind),
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
    allRecords,
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
    knownPlaces: Object.fromEntries(
      items.map((i) => [i.id, knownLeisurePlace(i, allRecords, knownIndex)]),
    ),
    version: 1,
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
        "SELECT * FROM leisure_records WHERE kind IN ('visit','reaction','plan','familiarity')",
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
    catalogVersion: 2,
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
  return edition;
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
/** @param {Env} env @param {any} record @param {number} nowMs @param {number | null} [expected] */
async function writeRecord(env, record, nowMs, expected = null) {
  const db = leisureDb(env),
    at = record.startAt ?? record.visitedOn ?? null;
  if (expected == null) {
    await db
      .prepare(
        'INSERT INTO leisure_records (id,kind,item_id,venue_id,at,data_json,revision,updated_at) VALUES (?,?,?,?,?,?,1,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(
        record.id,
        record.kind,
        record.itemId ?? null,
        record.venueId ?? null,
        at,
        JSON.stringify(record),
        new Date(nowMs).toISOString(),
      )
      .run();
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
    const receipt = { message: 'Збережено.', id: recovered.id };
    await db
      .prepare(
        'INSERT INTO leisure_commands(id,receipt_json,created_at) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING',
      )
      .bind(commandId, JSON.stringify({ fingerprint, receipt }), new Date(nowMs).toISOString())
      .run();
    return receipt;
  }
  /** @param {Env} targetEnv @param {any} record @param {number} atMs @param {number|null} [expected] */
  const writeCommandRecord = (targetEnv, record, atMs, expected = null) =>
    writeRecord(
      targetEnv,
      { ...record, lastCommandId: commandId, lastCommandFingerprint: fingerprint },
      atMs,
      expected,
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
      cinemas.some((c) => !['forum-lviv', 'king-cross'].includes(c))
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
          cinemas: [...new Set(cinemas)],
          students,
          enabled: payload.enabled ?? previous.enabled,
          retention: 'until-deleted',
          telegram: false,
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
    if (payload.reasonCode != null && !FEEDBACK_REASONS.includes(payload.reasonCode))
      throw new LeisureError('Обери коректну причину.');
    const key = `reaction-${id}`,
      current = await leisureRecord(env, key);
    await writeCommandRecord(
      env,
      {
        id: key,
        kind: 'reaction',
        itemId: id,
        venueId: selectedItem.venueId,
        verdict: payload.verdict,
        reasonCode: payload.reasonCode ?? null,
        reason: cleanText(payload.reason, 300),
        features: leisureFeatures(selectedItem),
        at: new Date(nowMs).toISOString(),
      },
      nowMs,
      current?.revision ?? null,
    );
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
    };
  } else if (op === 'place-check') {
    if (!selectedItem.placeId) throw new LeisureError('Для цього місця ще немає Google Place ID.');
    const details = await placeDetails(env, selectedItem.placeId, nowMs);
    const updated = {
      ...selectedItem,
      siteUrl: httpLink(details.place.site),
      hours: details.place.hours.join(' · '),
      placeDetails: { ...details.place, source: details.source },
    };
    await upsertLeisureItems(env, [updated]);
    return { message: 'Інформацію закладу перевірено.', place: updated.placeDetails };
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
            mode: 'car',
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
        planId: plan?.id ?? existingVisit?.planId ?? null,
      },
      nowMs,
      existingVisit?.revision ?? null,
    );
    receipt = { message: 'Відвідування збережено.', id: visitId };
  } else if (op === 'plan' || op === 'calendar-check') {
    const normalized = normalizeLeisurePlan(payload),
      old = id ? await leisureRecord(env, id) : null;
    if (id && (!old || old.kind !== 'plan')) throw new LeisureError('План не знайдено.', 404);
    if (old && old.revision !== normalized.revision)
      throw new LeisureError('План уже змінився. Онови його перед редагуванням.', 409);
    const items = await leisureItems(env),
      lookup = new Map(items.map((i) => [i.id, i]));
    for (const stop of normalized.stops) {
      const candidate = lookup.get(stop.itemId);
      if (!candidate || ['cancelled', 'sold-out', 'postponed'].includes(candidate.status))
        throw new LeisureError('Один із варіантів недоступний. Перевір склад плану.');
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
      if (candidate.endAt && Date.parse(candidate.endAt) <= nowMs)
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
      if (candidate.source === 'Планета кіно') {
        const session = candidate.sessions.find((/** @type {any} */ s) => s.id === stop.sessionId);
        if (!session || Date.parse(session.startAt) !== Date.parse(stop.startAt))
          throw new LeisureError('Обери підтверджений сеанс у кінотеатрі.');
        stop.address = session.address;
        stop.venueId = `planeta:${session.cinemaSlug}`;
        stop.sourceUrl = session.url ?? candidate.sourceUrl;
      }
    }
    const check = await checkLeisureCalendar(env, { ...normalized, calendarId: old?.calendarId });
    if (op === 'calendar-check') return { message: 'Календар перевірено.', ...check };
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
