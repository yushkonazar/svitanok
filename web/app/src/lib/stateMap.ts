import type { CheckinRaw, CheckinSlot } from '../api/schema.ts';

// Карта станів: розбір гарячого вікна чек-інів на зрізи «енергія×настрій».
//
// НАВІЩО ОКРЕМИЙ МОДУЛЬ, а не всередині StateMatrix.tsx: тут живе вся
// арифметика карти, і вона мусить бути покрита кореневим vitest без DOM.
// Компоненту лишається рендер.
//
// ⚠️ ГОЛОВНЕ РІШЕННЯ ЦЬОГО ФАЙЛУ — зріз ЗНАЄ свій слот і свою дату. Доти
// сітка читала energyCurve/moodCurve з checkinSeries і зсипала ранок, день і
// вечір в одну купу: «енергія 2 · настрій 2» вранці (недоспав) і ввечері
// (виснажився за день) ставали одним числом в одній клітинці. Це два різні
// явища з різними причинами — і саме слот робить майбутній звʼязок із
// причинами чесним, бо в ранковому записі лежить сон і час відбою, а у
// вечірньому — блокери, помічники й оцінка дня.

export type SlotFilter = 'all' | CheckinSlot;

// `id`, а не `key` — форма готова прямо для <Segmented>, без перекладання.
// Підписи словами, не самими емодзі: кнопка з одним 🌅 нечитабельна з
// екранного читача, і на дрібному екрані емодзі не пояснює, ранок це чи схід.
export const SLOT_FILTERS: ReadonlyArray<{ id: SlotFilter; label: string }> = [
  { id: 'all', label: 'Усі' },
  { id: 'morning', label: '🌅 Ранок' },
  { id: 'afternoon', label: '☀️ День' },
  { id: 'evening', label: '🌙 Вечір' },
];

const SLOTS: readonly CheckinSlot[] = ['morning', 'afternoon', 'evening'];

/** Один зріз стану: пара «енергія×настрій» із відомим слотом і датою. */
export interface StateReading {
  d: string;
  slot: CheckinSlot;
  energy: number;
  mood: number;
}

const snap = (v: number) => Math.min(5, Math.max(1, Math.round(v)));

/**
 * Усі зрізи вікна, за зростанням дати.
 *
 * Зріз існує, ЛИШЕ коли є обидва виміри: пад дає їх одним тапом, тож половина
 * пари означає биті чи легасі дані, а не «настрій без енергії». Домалювати
 * відсутню вісь нулем — і клітинка на краю сітки набрала б ваги з нічого.
 */
export function readingsOf(raw: CheckinRaw, filter: SlotFilter): StateReading[] {
  const wanted = filter === 'all' ? SLOTS : [filter];
  const out: StateReading[] = [];
  for (const d of Object.keys(raw.records).sort()) {
    const rec = raw.records[d];
    if (!rec) continue;
    for (const slot of wanted) {
      const s = rec[slot];
      if (typeof s?.energy !== 'number' || typeof s?.mood !== 'number') continue;
      out.push({ d, slot, energy: snap(s.energy), mood: snap(s.mood) });
    }
  }
  return out;
}

/**
 * Сітка 5×5 з лічильниками.
 *
 * Геометрія НАВМИСНО повторює AffectPad (введення чек-іну): енергія вгору,
 * настрій вправо, тож [0][0] — «виснажений і в поганому настрої» вгорі-ліворуч
 * за енергією, а рахунок рядків іде згори. Тапаєш по тій самій сітці, по якій
 * відповідаєш.
 */
export function gridOf(readings: StateReading[]): { grid: number[][]; max: number; n: number } {
  const grid: number[][] = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (const r of readings) grid[5 - r.energy]![r.mood - 1]! += 1;
  // max=1 на порожньому: інтенсивність кольору ділиться на нього, і нуль дав
  // би NaN у color-mix, тобто прозорі клітинки замість порожньої сітки.
  return { grid, max: Math.max(1, ...grid.flat()), n: readings.length };
}
