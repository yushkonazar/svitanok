// Розкладка дня (ADR-035, S-P-11): детермінований модуль без D1 і мережі.
// Вхід - пункти наміру (від Денного працівника або з plan.* інструментів),
// події календаря, звички з facts, енергія за чек-іном; вихід - блоки з
// часом, «гнучке без часу» і запас. Денний працівник розкладку не робить
// (day-planner.md «Чого не робити»), інакше план не тестується і не вчиться.
//
// Правила S-P-11: вільні вікна = день − сон/їжа − події календаря (з буфером)
// − ланцюги/нагадування; жорсткі пункти першими; deep-блоки у вікна з
// найвищою енергією (≥ 14 діб даних, інакше ранок); оцінка × estimate_bias
// (типово 1,3); заповнення ≤ fill_ratio вільного часу; ≤ max_deep глибоких;
// errand групуються за місцем; що не влізло - «гнучке без часу».

/** Дефолти налаштувань плану (S-P-8 `facts.setting.day_plan`). */
export const DAY_PLAN_DEFAULTS = {
  intent_at: '20:30',
  morning_at: '08:30',
  review_at: '21:00',
  fill_ratio: 0.6,
  max_deep: 3,
  weekdays: 'пн-пт',
};

/** Дефолти звичок (S-P-6 `facts.habit.*`). */
export const HABIT_DEFAULTS = {
  day_start: '08:00',
  day_end: '22:00',
  lunch_at: '13:00',
  lunch_min: 60,
  estimate_bias: 1.3,
};

/** Типова тривалість за видом, коли власник її не назвав (день-planner.md §4.6). */
export const DEFAULT_EST_MIN = { deep: 90, routine: 30, call: 15, errand: 45, move: 30 };
export const ITEM_KINDS = Object.keys(DEFAULT_EST_MIN);
/** Буфер навколо події календаря: дійти/зібратись. */
export const EVENT_BUFFER_MIN = 15;
/** Найменший блок, який ще має сенс класти у вікно. */
export const MIN_BLOCK_MIN = 15;
/** Крок округлення блоків. */
export const ROUND_MIN = 5;
/** Мінімум діб чек-іну, щоб довіряти енергетичним вікнам (S-P-11). */
export const ENERGY_MIN_DAYS = 14;

/** Вікна доби для енергії: ранок / день / вечір - межі у хвилинах від опівночі. */
export const ENERGY_WINDOWS = {
  morning: [8 * 60, 13 * 60],
  afternoon: [13 * 60, 18 * 60],
  evening: [18 * 60, 23 * 60],
};

/**
 * @typedef {{ id: string, title: string, kind: string, est_min: number | null,
 *   hard_at: string | null, deadline: string | null, place: string | null,
 *   flexible: boolean, priority: number, carried_from?: string | null }} PlanItemInput
 * @typedef {{ id: string, title: string, kind: string, est_min: number,
 *   window_start: string, window_end: string, why: string }} PlacedItem
 * @typedef {{ start: number, end: number, title: string }} Busy
 */

/** «HH:MM» → хвилини від опівночі; крива форма - null. @param {unknown} s */
export function hhmmToMin(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** хвилини → «HH:MM». @param {number} min */
export function minToHhmm(min) {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(min)));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Дні тижня з рядка «пн-пт», «пн,ср,пт», «пн-сб» → множина 1..7 (пн=1).
 * @param {unknown} raw
 */
export function parseWeekdays(raw) {
  const names = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'нд'];
  const s = String(raw ?? DAY_PLAN_DEFAULTS.weekdays)
    .toLowerCase()
    .replace(/\s+/g, '');
  const out = new Set();
  for (const part of s.split(',')) {
    const range = /^(..)-(..)$/.exec(part);
    if (range) {
      const a = names.indexOf(String(range[1]));
      const b = names.indexOf(String(range[2]));
      if (a < 0 || b < 0) continue;
      for (let i = a; i <= (b >= a ? b : b + 7); i += 1) out.add((i % 7) + 1);
      continue;
    }
    const i = names.indexOf(part);
    if (i >= 0) out.add(i + 1);
  }
  return out;
}

/** ISO-день тижня (пн=1 … нд=7) для YYYY-MM-DD. @param {string} dateKey */
export function isoWeekday(dateKey) {
  const d = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/**
 * Середня енергія за слотами чек-іну з сирих записів (checkins[date][slot].energy).
 * Менше ENERGY_MIN_DAYS діб з даними - null (беремо ранок).
 * @param {Record<string, any>} checkins
 * @returns {{ morning: number, afternoon: number, evening: number, days: number } | null}
 */
export function energyBySlot(checkins) {
  const sums = { morning: 0, afternoon: 0, evening: 0 };
  const counts = { morning: 0, afternoon: 0, evening: 0 };
  let days = 0;
  for (const rec of Object.values(checkins ?? {})) {
    let any = false;
    for (const slot of /** @type {const} */ (['morning', 'afternoon', 'evening'])) {
      const e = rec?.[slot]?.energy;
      if (typeof e === 'number') {
        sums[slot] += e;
        counts[slot] += 1;
        any = true;
      }
    }
    if (any) days += 1;
  }
  if (days < ENERGY_MIN_DAYS) return null;
  const avg = (/** @type {'morning'|'afternoon'|'evening'} */ s) =>
    counts[s] ? sums[s] / counts[s] : 0;
  return { morning: avg('morning'), afternoon: avg('afternoon'), evening: avg('evening'), days };
}

/**
 * Оцінка блоку з множником запасу, округлена до 5 хв.
 * @param {PlanItemInput} item @param {number} bias
 */
export function estimateMin(item, bias) {
  const base =
    typeof item.est_min === 'number' && item.est_min > 0
      ? item.est_min
      : (DEFAULT_EST_MIN[/** @type {keyof typeof DEFAULT_EST_MIN} */ (item.kind)] ??
        DEFAULT_EST_MIN.routine);
  return Math.max(MIN_BLOCK_MIN, Math.round((base * bias) / ROUND_MIN) * ROUND_MIN);
}

/**
 * Розкладка дня.
 * @param {{
 *   date: string,
 *   items: PlanItemInput[],
 *   events: { title: string, startMin: number | null, endMin: number | null }[],
 *   settings?: Partial<typeof DAY_PLAN_DEFAULTS>,
 *   habits?: Partial<typeof HABIT_DEFAULTS>,
 *   energy?: { morning: number, afternoon: number, evening: number } | null,
 * }} input
 * @returns {{ placed: PlacedItem[], flexible: (PlanItemInput & { why: string })[],
 *   freeMin: number, usedMin: number, capacityMin: number, busy: Busy[] }}
 */
export function computeSlots(input) {
  const settings = { ...DAY_PLAN_DEFAULTS, ...(input.settings ?? {}) };
  const habits = { ...HABIT_DEFAULTS, ...(input.habits ?? {}) };
  const dayStart = hhmmToMin(habits.day_start) ?? hhmmToMin(HABIT_DEFAULTS.day_start) ?? 480;
  const dayEnd = hhmmToMin(habits.day_end) ?? hhmmToMin(HABIT_DEFAULTS.day_end) ?? 1320;
  const bias = Number(habits.estimate_bias) > 0 ? Number(habits.estimate_bias) : 1.3;
  const fillRatio = clamp(Number(settings.fill_ratio), 0.1, 1);
  const maxDeep = Math.max(0, Math.trunc(Number(settings.max_deep)));

  /** @type {Busy[]} */
  const busy = [];
  const lunchAt = hhmmToMin(habits.lunch_at);
  if (lunchAt != null)
    busy.push({ start: lunchAt, end: lunchAt + habits.lunch_min, title: 'обід' });
  for (const e of input.events) {
    if (e.startMin == null || e.endMin == null) continue;
    busy.push({
      start: Math.max(dayStart, e.startMin - EVENT_BUFFER_MIN),
      end: Math.min(dayEnd, e.endMin + EVENT_BUFFER_MIN),
      title: e.title,
    });
  }

  /** @type {PlacedItem[]} */
  const placed = [];
  /** @type {(PlanItemInput & { why: string })[]} */
  const flexible = [];

  // 1. Жорсткі за часом - першими, у свій час (навіть поверх події - це
  //    рішення власника; перетин лише позначаємо в why).
  const hard = input.items.filter((i) => hhmmToMin(i.hard_at) != null);
  for (const item of hard) {
    const start = /** @type {number} */ (hhmmToMin(item.hard_at));
    const est = estimateMin(item, bias);
    const overlap = busy.find((b) => start < b.end && start + est > b.start);
    placed.push({
      id: item.id,
      title: item.title,
      kind: item.kind,
      est_min: est,
      window_start: minToHhmm(start),
      window_end: minToHhmm(start + est),
      why: overlap ? `жорсткий час; перетин з «${overlap.title}»` : 'жорсткий час',
    });
    busy.push({ start, end: start + est, title: item.title });
  }

  const freeMin = freeMinutes(dayStart, dayEnd, busy);
  const capacityMin = Math.floor(freeMin * fillRatio);

  // 2. Решта - за пріоритетом: дедлайн сьогодні/завтра → перенесені → порядок власника.
  const rest = input.items
    .filter((i) => hhmmToMin(i.hard_at) == null)
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => rank(a.i, input.date) - rank(b.i, input.date) || a.idx - b.idx)
    .map((x) => x.i);

  // Errand групуються за місцем: ті самі place - підряд.
  const ordered = groupErrands(rest);

  const energy = input.energy;
  let used = 0;
  let deepCount = 0;
  for (const item of ordered) {
    const est = estimateMin(item, bias);
    if (item.kind === 'deep' && deepCount >= maxDeep) {
      flexible.push({ ...item, why: `понад ${maxDeep} глибоких блоків` });
      continue;
    }
    if (used + est > capacityMin) {
      flexible.push({ ...item, why: `не влізло в ${Math.round(fillRatio * 100)} % вільного часу` });
      continue;
    }
    const preferred = item.kind === 'deep' ? energyOrder(energy) : null;
    const slot = findSlot(dayStart, dayEnd, busy, est, preferred);
    if (!slot) {
      flexible.push({ ...item, why: 'немає вікна потрібної довжини' });
      continue;
    }
    placed.push({
      id: item.id,
      title: item.title,
      kind: item.kind,
      est_min: est,
      window_start: minToHhmm(slot.start),
      window_end: minToHhmm(slot.start + est),
      why:
        item.kind === 'deep'
          ? energy
            ? `глибокий блок · енергія ${slot.window} вища`
            : 'глибокий блок · ранок (енергії за чек-іном ще замало)'
          : item.carried_from
            ? `перенесено з ${item.carried_from}`
            : item.deadline
              ? `дедлайн ${item.deadline}`
              : 'за порядком',
    });
    busy.push({ start: slot.start, end: slot.start + est, title: item.title });
    used += est;
    if (item.kind === 'deep') deepCount += 1;
  }

  placed.sort((a, b) => (hhmmToMin(a.window_start) ?? 0) - (hhmmToMin(b.window_start) ?? 0));
  return { placed, flexible, freeMin, usedMin: used, capacityMin, busy };
}

/**
 * Рядок для власника з розкладки (резерв, коли працівник недоступний;
 * Денний робить те саме словами - day-planner.md «explain»).
 * @param {string} date
 * @param {ReturnType<typeof computeSlots>} slots
 * @param {{ title: string, startMin: number | null }[]} events
 */
export function formatDraft(date, slots, events) {
  const [, m, d] = date.split('-');
  const lines = [`План на ${d}.${m}`];
  for (const p of slots.placed) {
    lines.push(`• ${p.window_start}-${p.window_end} ${p.title} · ${p.kind} · ${p.why}`);
  }
  for (const e of events) {
    if (e.startMin != null) lines.push(`• ${minToHhmm(e.startMin)} ${e.title} (календар)`);
  }
  if (slots.flexible.length) {
    lines.push(`Гнучке, без часу: ${slots.flexible.map((f) => f.title).join(', ')}`);
  }
  const free = slots.freeMin - slots.usedMin;
  lines.push(`Запас: ${Math.floor(free / 60)} год ${free % 60} хв вільно`);
  return lines.slice(0, 14).join('\n');
}

// ── Внутрішнє ──────────────────────────────────────────────────────────────

/** @param {PlanItemInput} item @param {string} date */
function rank(item, date) {
  if (item.deadline && item.deadline <= date) return 0;
  if (item.carried_from) return 1;
  return 2 + Math.max(0, Math.min(9, Number(item.priority) || 5));
}

/** @param {PlanItemInput[]} items */
function groupErrands(items) {
  /** @type {PlanItemInput[]} */
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) continue;
    out.push(item);
    seen.add(item.id);
    if (item.kind === 'errand' && item.place) {
      const key = item.place.toLowerCase();
      for (const other of items) {
        if (!seen.has(other.id) && other.kind === 'errand' && other.place?.toLowerCase() === key) {
          out.push(other);
          seen.add(other.id);
        }
      }
    }
  }
  return out;
}

/**
 * Порядок вікон для deep: за спаданням енергії; без даних - ранок → день → вечір.
 * @param {{ morning: number, afternoon: number, evening: number } | null | undefined} energy
 * @returns {('morning' | 'afternoon' | 'evening')[]}
 */
function energyOrder(energy) {
  const names = /** @type {('morning' | 'afternoon' | 'evening')[]} */ ([
    'morning',
    'afternoon',
    'evening',
  ]);
  if (!energy) return names;
  return [...names].sort((a, b) => energy[b] - energy[a] || names.indexOf(a) - names.indexOf(b));
}

/**
 * Перше вільне вікно довжини est; для deep - спершу в бажаних енергетичних
 * вікнах, потім будь-де.
 * @param {number} dayStart @param {number} dayEnd @param {Busy[]} busy @param {number} est
 * @param {('morning' | 'afternoon' | 'evening')[] | null} preferred
 * @returns {{ start: number, window: string } | null}
 */
function findSlot(dayStart, dayEnd, busy, est, preferred) {
  const gaps = freeGaps(dayStart, dayEnd, busy);
  if (preferred) {
    for (const w of preferred) {
      const [ws, we] = /** @type {[number, number]} */ (ENERGY_WINDOWS[w]);
      for (const g of gaps) {
        const start = Math.max(g.start, ws);
        if (start + est <= Math.min(g.end, we)) return { start, window: labelUa(w) };
      }
    }
  }
  for (const g of gaps) {
    if (g.end - g.start >= est) return { start: g.start, window: '' };
  }
  return null;
}

/** @param {'morning' | 'afternoon' | 'evening'} w */
function labelUa(w) {
  return w === 'morning' ? 'зранку' : w === 'afternoon' ? 'вдень' : 'ввечері';
}

/** @param {number} dayStart @param {number} dayEnd @param {Busy[]} busy */
function freeGaps(dayStart, dayEnd, busy) {
  const sorted = [...busy].sort((a, b) => a.start - b.start);
  /** @type {{ start: number, end: number }[]} */
  const gaps = [];
  let cursor = dayStart;
  for (const b of sorted) {
    if (b.start > cursor) gaps.push({ start: cursor, end: Math.min(b.start, dayEnd) });
    cursor = Math.max(cursor, b.end);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) gaps.push({ start: cursor, end: dayEnd });
  return gaps.filter((g) => g.end - g.start >= MIN_BLOCK_MIN);
}

/** @param {number} dayStart @param {number} dayEnd @param {Busy[]} busy */
function freeMinutes(dayStart, dayEnd, busy) {
  return freeGaps(dayStart, dayEnd, busy).reduce((a, g) => a + (g.end - g.start), 0);
}

/** @param {number} v @param {number} lo @param {number} hi */
function clamp(v, lo, hi) {
  return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo;
}
