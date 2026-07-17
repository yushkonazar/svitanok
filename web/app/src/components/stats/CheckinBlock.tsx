import type { Stats } from '../../api/schema.ts';
import { SectionHead, StatRow, Ph } from '../ui/primitives.tsx';

// Статистика чек-іну (фідбек власника, п.7: «статистику і тижневий розбір у
// Статистика»).
//
// ⚠️ Цей блок ЛЕГКО зробив би брехливим. «У дні, коли ти спав менше 6 — подач
// удвічі менше» звучить як висновок, а на третьому тижні це три точки проти
// чотирьох. І така брехня ВИГЛЯДАЄ як аналітика, тобто підштовхує до рішень.
// Тому все, що претендує на звʼязок, гейтиться на сервері (sleepVsApplied.ready)
// і мовчить, поки в кожному кошику менше 8 днів. Доти показуємо лише те, що
// нічого не стверджує: ряди й явку.

const FMT = (v: number | null, suffix = '') => (v === null ? '—' : `${v}${suffix}`);

/** Мінімальна спарклайн-крива. Нулі-дірки НЕ малюємо — вони не нулі, а «немає». */
function Spark({ points, lo, hi }: { points: Array<number | null>; lo: number; hi: number }) {
  const vals = points.filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  const W = 100;
  const H = 26;
  const span = hi - lo || 1;
  // Дірки розривають лінію: з'єднати їх означало б домалювати дані, яких немає.
  const segs: string[] = [];
  let cur: string[] = [];
  points.forEach((v, i) => {
    if (v === null) {
      if (cur.length > 1) segs.push(cur.join(' '));
      cur = [];
      return;
    }
    const x = (i / Math.max(1, points.length - 1)) * W;
    const y = H - ((v - lo) / span) * H;
    cur.push(`${cur.length ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (cur.length > 1) segs.push(cur.join(' '));
  if (!segs.length) return null;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} preserveAspectRatio="none" aria-hidden="true">
      {segs.map((d, i) => (
        <path key={i} d={d} fill="none" stroke="var(--color-a2)" strokeWidth="1.5" strokeLinecap="round" />
      ))}
    </svg>
  );
}

export function CheckinBlock({ s }: { s: Stats }) {
  const series = s.checkinSeries;
  const fill = s.checkinFill;
  const filledDays = series.length;

  if (!filledDays)
    return (
      <div className="flex flex-col gap-3">
        <SectionHead>Чек-ін</SectionHead>
        <Ph>Заповни чек-ін кілька днів — і тут з’являться твої ряди</Ph>
      </div>
    );

  const sleep = series.map((p) => p.sleepH);
  const energy = series.map((p) => p.energy);
  const sleepVals = sleep.filter((v): v is number => v !== null);
  const avgSleep = sleepVals.length
    ? Math.round((sleepVals.reduce((a, b) => a + b, 0) / sleepVals.length) * 10) / 10
    : null;

  const week = s.checkinWeekly.at(-1);
  const prev = s.checkinWeekly.at(-2);
  const trend =
    week?.sleepAvg != null && prev?.sleepAvg != null
      ? week.sleepAvg > prev.sleepAvg
        ? ' · ↑ vs минулий'
        : week.sleepAvg < prev.sleepAvg
          ? ' · ↓ vs минулий'
          : ' · = vs минулий'
      : '';

  const sva = s.sleepVsApplied;
  const kept = s.planVsFact;
  // «Намір проти факту» — єдине, що застосунок ПЕРЕВІРЯЄ, а не записує зі слів.
  const keptHit = kept.filter((r) => r.actual >= r.planned).length;

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Чек-ін</SectionHead>

      <div className="flex flex-col gap-2.5 rounded-2xl border border-glassb bg-glass p-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            СОН ЗА {filledDays} ДІБ
          </span>
          <span className="ml-auto font-mono text-[17px] font-semibold">
            {FMT(avgSleep, ' год')}
          </span>
        </div>
        <Spark points={sleep} lo={4} hi={10} />
        {week && (
          <span className="text-[10.5px] font-medium text-tx2">
            Цей тиждень: {FMT(week.sleepAvg, ' год')}
            {trend}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2.5 rounded-2xl border border-glassb bg-glass p-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            ЕНЕРГІЯ (СЕРЕДНЄ ЗА ДОБУ)
          </span>
          <span className="ml-auto font-mono text-[17px] font-semibold">
            {FMT(week?.energyAvg ?? null)}
          </span>
        </div>
        <Spark points={energy} lo={1} hi={5} />
      </div>

      {/* Явка: пропуски — теж дані. Ранок 25 разів проти вечора 4 каже більше,
          ніж самі відповіді. */}
      <StatRow
        label="🌅 Ранок"
        value={`${fill.morning} з ${fill.days}`}
      />
      <StatRow label="☀️ Післяобід" value={`${fill.afternoon} з ${fill.days}`} />
      <StatRow label="🌙 Вечір" value={`${fill.evening} з ${fill.days}`} />

      {kept.length > 0 && (
        <StatRow
          label="🎯 Виконав план подач"
          value={`${keptHit} з ${kept.length} днів`}
        />
      )}

      {/* Кореляція — лише коли є що порівнювати. Інакше чесно кажемо, чого чекаємо. */}
      <div className="rounded-2xl border border-glassb bg-glass p-4">
        <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
          СОН І ПОДАЧІ
        </div>
        {sva.ready ? (
          <>
            <div className="mt-1.5 flex items-baseline gap-3">
              <span className="text-[13px] font-semibold">
                Спав &lt;6.5 год — {sva.lowAvg} подач/день
              </span>
            </div>
            <div className="text-[13px] font-semibold">
              Спав більше — {sva.okAvg} подач/день
            </div>
            <div className="mt-1 text-[10.5px] text-tx3">
              {sva.low} і {sva.ok} днів. Це спостереження, не причина.
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[12px] leading-[1.5] text-tx2">
            Ще рано порівнювати: {sva.low} коротких ночей і {sva.ok} нормальних, а треба
            щонайменше по {sva.needed}. На меншій вибірці будь-яка цифра тут була б
            вигадкою, тому її немає.
          </div>
        )}
      </div>
    </div>
  );
}
