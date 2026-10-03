/** Explicit IANA zones; never infer a country's one timezone from its name.
 * @param {unknown} value @param {string} fallback */
export function tripZone(value, fallback = 'Europe/Kyiv') {
  const zone = String(value ?? fallback);
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone }).format(0);
  } catch {
    throw new Error('Уточни часовий пояс міста, наприклад Europe/Vienna.');
  }
  return zone;
}

/** @param {number} ms @param {string} zone */
export function tripLocalParts(ms, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tripZone(zone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (/** @type {string} */ key) => parts.find((p) => p.type === key)?.value;
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    clock: `${get('hour')}:${get('minute')}`,
  };
}

/** Reject DST gaps and folds instead of silently shifting an owner's time.
 * @param {string} local YYYY-MM-DDTHH:MM @param {string} zone */
export function tripInstant(local, zone) {
  tripZone(zone);
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(local))
    throw new Error('Уточни дату і час у форматі РРРР-ММ-ДДTГГ:ХХ.');
  const guess = Date.parse(`${local}:00Z`);
  if (!Number.isFinite(guess) || new Date(guess).toISOString().slice(0, 16) !== local)
    throw new Error('Такої календарної дати немає.');
  const offsets = new Set();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const probe = guess + delta * 3_600_000;
    const p = tripLocalParts(probe, zone);
    offsets.add(Date.parse(`${p.date}T${p.clock}:00Z`) - probe);
  }
  const matches = [...offsets]
    .map((offset) => guess - offset)
    .filter((ms) => {
      const p = tripLocalParts(ms, zone);
      return `${p.date}T${p.clock}` === local;
    });
  if (matches.length !== 1)
    throw new Error(
      'Ця година пропущена або повторюється при зміні часу. Обери іншу однозначну годину.',
    );
  return /** @type {number} */ (matches[0]);
}

/** Skip a nonexistent/ambiguous automatic slot, never move it arbitrarily.
 * @param {string} date @param {string} clock @param {string} zone */
export function tripSlot(date, clock, zone) {
  try {
    return tripInstant(`${date}T${clock}`, zone);
  } catch {
    return null;
  }
}
