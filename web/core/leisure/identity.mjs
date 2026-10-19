const key = (/** @type {unknown} */ value) =>
  String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase('uk')
    .replace(/[^\p{L}\p{N}]/gu, '');
/** A film is independent of sessions; a performance is independent of its listing URL.
 * No fuzzy merging of distinct performances or branches. @param {any} item */
export function leisureIdentity(item) {
  if (item.placeId) return 'place:' + item.placeId;
  if (item.category === 'cinema') {
    // The official movie page is preferable to a title-only guess (remakes exist).
    const slug = /planetakino\.ua\/movie\/([^/?#]+)/i.exec(item.sourceUrl ?? '')?.[1];
    return (
      'film:' +
      (item.filmId ??
        slug ??
        [key(item.title), item.year ?? '', item.durationMinutes ?? item.sourceUrl].join(':'))
    );
  }
  if (['food', 'trip', 'place'].includes(item.category))
    return item.venueId
      ? 'venue:' + item.venueId
      : 'place-url:' + (String(item.sourceUrl ?? '').split(/[?#]/)[0] ?? '').replace(/\/$/, '');
  if (item.category === 'podcast') return 'episode:' + (item.guid ?? item.sourceUrl);
  const time =
    item.startAt && Number.isFinite(Date.parse(item.startAt))
      ? new Date(item.startAt).toISOString()
      : (item.startDate ?? '');
  return ['event', key(item.title), time, key(item.venue ?? item.address ?? item.sourceUrl)].join(
    ':',
  );
}
/** @param {any} reaction @param {number} nowMs */
export function leisureReactionHidden(reaction, nowMs) {
  if (reaction.verdict === 'uninterested') return true;
  // Unscheduled postponement stays out of discovery until explicitly restored.
  if (reaction.verdict === 'later')
    return !reaction.snoozeUntil || Date.parse(reaction.snoozeUntil) > nowMs;
  return false;
}
/** The newest explicit decision wins across listing aliases and compacted records.
 * @param {any[]} items @param {any[]} records */
export function leisureDecisionIndex(items, records) {
  const byId = new Map(items.map((i) => [i.id, i])),
    decisions = new Map();
  for (const record of records) {
    if (!['reaction', 'discovery'].includes(record.kind)) continue;
    const item = byId.get(record.itemId),
      identity = record.identityKey ?? (item ? leisureIdentity(item) : null);
    if (!identity) continue;
    for (const alias of new Set([
      identity,
      ...(item ? [item.identityKey ?? leisureIdentity(item)] : []),
    ])) {
      const previous = decisions.get(alias),
        at = Date.parse(record.at ?? record.updatedAt ?? '') || 0;
      if (!previous || at >= (Date.parse(previous.at ?? previous.updatedAt ?? '') || 0))
        decisions.set(alias, record);
    }
  }
  return decisions;
}
