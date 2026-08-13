import type { Stats } from '../api/schema.ts';

type Trend = Stats['interestsTrend'];

// Що зростає, а що згасає в інтересах.
//
// ⚠️ ПРОГАЛИНА. Блок «Інтереси» показував ЗНІМОК: головна тема тижня, чипи
// решти, сумарний бал і повний графік тренду. Зі стрілочки «↑ vs минулий» був
// видний напрямок ЛИШЕ головної теми — тобто саме тієї, про яку й так усе
// зрозуміло. А цікаве в інтересах — рух: тема, яка тихо піднялась із нізвідки,
// або та, що згасла й досі висить у топі за старими заслугами.
//
// Дані для цього лежали в interestsTrend від самого початку: пів року тижневої
// історії по кожній із топ-тем. Читались із них лише два останні елементи.

/** Скільки тижнів порівнюємо з попередніми стількома ж. */
const HALF = 4;

/** Нижче цього — не рух, а одна-дві реакції. */
const MIN_VOLUME = 3;

/** Нижче цього — коливання, а не зміна інтересу. */
const MIN_RATIO = 1.5;

export interface InterestShift {
  topic: string;
  recent: number;
  prior: number;
  /** >1 — зростає, <1 — згасає. */
  ratio: number;
  direction: 'up' | 'down';
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/**
 * Теми, що помітно зросли або згасли, найсильніший рух перший.
 *
 * ⚠️ Потрібні ОБИДВА боки історії: без попереднього періоду порівнювати нема з
 * чим, і «нова тема» виглядала б як вибухове зростання просто тому, що тиждень
 * тому застосунку ще не було. Тому серії, коротшої за 2×HALF, не вистачає.
 *
 * Згладжування (+1 у знаменнику) навмисне: «0 -> 5» реальне й часте (нова
 * тема), а без нього це нескінченність, тобто число, яке не можна ні
 * відсортувати, ні показати.
 */
export function interestShifts(trend: Trend): InterestShift[] {
  const out: InterestShift[] = [];
  for (const t of trend.topics) {
    if (t.series.length < HALF * 2) continue;
    const recent = sum(t.series.slice(-HALF));
    const prior = sum(t.series.slice(-HALF * 2, -HALF));
    // Обидва боки крихітні -> це тиша, а не рух.
    if (Math.max(recent, prior) < MIN_VOLUME) continue;
    const ratio = (recent + 1) / (prior + 1);
    if (ratio < MIN_RATIO && ratio > 1 / MIN_RATIO) continue;
    out.push({ topic: t.topic, recent, prior, ratio, direction: ratio > 1 ? 'up' : 'down' });
  }
  return out.sort((a, b) => Math.abs(Math.log(b.ratio)) - Math.abs(Math.log(a.ratio)));
}

/**
 * Наскільки інтереси зосереджені: частка найбільшої теми від усіх реакцій.
 *
 * Одне число замість читання всіх чипів: 70% означає «одна тема й трохи шуму»,
 * 25% — «читаю широко». Обидва стани нормальні, тому це описова цифра без
 * оцінки — блок не має вирішувати за людину, як їй цікавитись світом.
 */
export function focusPct(interests: Stats['interests']): number | null {
  const total = sum(interests.map((i) => i.score));
  if (total <= 0) return null;
  return Math.round(((interests[0]?.score ?? 0) / total) * 100);
}
