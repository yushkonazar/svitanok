import type { Stats } from '../../api/schema.ts';
import { useInView } from '../../lib/useInView.ts';
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

const BLOCKER_LABEL: Record<string, string> = {
  tired: 'Втома',
  anxious: 'Тривога',
  stuck: 'Не знав з чого',
  distract: 'Відволікання',
  health: 'Здоровʼя',
  external: 'Зовнішнє',
};
const HELPER_LABEL: Record<string, string> = {
  early: 'Ранній старт',
  list: 'Список',
  breaks: 'Перерви',
  support: 'Підтримка',
};
const CATEGORY_LABEL: Record<string, string> = {
  work: '💼 Робота',
  learn: '📚 Навчання',
  project: '🛠 Проєкт',
  travel: '🧭 Дорога',
  chores: '🔁 Побут',
  sport: '🏃 Спорт',
  rest: '🌿 Відпочинок',
  people: '👥 Люди',
  create: '🎨 Творчість',
};

// Колір оцінки: червоний (погано) -> жовтий -> зелений (добре). Щоб число саме
// по собі казало «це добре чи ні», а не було просто цифрою.
const scoreHsl = (t: number) => `hsl(${Math.round(Math.max(0, Math.min(1, t)) * 125)}, 62%, 58%)`;
/** Шкала 1–5 (енергія, оцінка дня, настрій). */
const ratingColor = (v: number | null): string | undefined =>
  v == null ? undefined : scoreHsl((v - 1) / 4);
/** Сон у годинах: 4 і менше — червоне, 8+ — зелене (плато на «виспався»). */
const sleepColor = (h: number | null): string | undefined =>
  h == null ? undefined : scoreHsl((h - 4) / 4);

/** Число з кольором-оцінкою. */
function Score({
  v,
  color,
  suffix = '',
  className = '',
}: {
  v: number | null;
  color: string | undefined;
  suffix?: string;
  className?: string;
}) {
  return (
    <span className={className} style={color ? { color } : undefined}>
      {v == null ? '—' : `${v}${suffix}`}
    </span>
  );
}

/** Мінімальна спарклайн-крива. Нулі-дірки НЕ малюємо — вони не нулі, а «немає». */
function Spark({ points, lo, hi }: { points: Array<number | null>; lo: number; hi: number }) {
  // Хук ДО раннього return — порядок хуків мусить бути сталим між рендерами.
  const [ref, inView] = useInView<SVGSVGElement>();
  const vals = points.filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  const W = 100;
  const H = 26;
  // Відступи, щоб пік/спад не торкались країв і не обрізались півтовщиною лінії
  // (це й був «баг»: верхні точки лягали на y=0 і зрізались зверху картки).
  const PX = 1.5;
  const PY = 3;
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
    const x = PX + (i / Math.max(1, points.length - 1)) * (W - PX * 2);
    // Клампимо в межі картки: значення поза [lo,hi] (напр. сон 3.5 з опції «<4»
    // при lo=4) інакше вилазить за відступ, майже до краю.
    const raw = PY + (H - PY * 2) * (1 - (v - lo) / span);
    const y = Math.max(PY, Math.min(H - PY, raw));
    cur.push(`${cur.length ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (cur.length > 1) segs.push(cur.join(' '));
  if (!segs.length) return null;

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      width="100%"
      height={H}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      {segs.map((d, i) => (
        // pathLength="1" — щоб CSS міг намалювати відрізок від початку до кінця,
        // не знаючи його довжини в пікселях. Сегменти йдуть один за одним, бо
        // саме розриви (пропущені дні) тут несуть сенс — хай їх буде видно.
        <path
          key={i}
          d={d}
          pathLength="1"
          fill="none"
          stroke="var(--color-a2)"
          strokeWidth="1.5"
          // Товщина не розтягується з viewBox (preserveAspectRatio none інакше
          // робить лінію товстою по горизонталі й тонкою по вертикалі).
          vectorEffect="non-scaling-stroke"
          strokeLinecap="round"
          strokeDasharray="1"
          strokeDashoffset="0"
          style={{
            animation: `lineDraw .7s cubic-bezier(.4,0,.2,1) ${i * 120}ms backwards`,
            animationPlayState: inView ? 'running' : 'paused',
          }}
        />
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

  const svd = s.sleepVsDayScore;
  const bve = s.bedtimeVsEnergy;
  const cat = s.categoryInsight;
  const cal = s.appliedCalibration;
  const tops = s.checkinTops;
  const kept = s.planVsFact;
  // «Намір проти факту» — джоб-опційне: показуємо лише коли були робочі дні.
  const keptHit = kept.filter((r) => r.actual >= r.planned).length;

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Чек-ін</SectionHead>

      <div className="flex flex-col gap-2.5 rounded-2xl border border-glassb bg-glass p-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            СОН ЗА {filledDays} ДІБ
          </span>
          <Score
            v={avgSleep}
            color={sleepColor(avgSleep)}
            suffix=" год"
            className="ml-auto font-mono text-[17px] font-semibold"
          />
        </div>
        <Spark points={sleep} lo={4} hi={10} />
        {week && (
          <span className="text-[10.5px] font-medium text-tx2">
            Цей тиждень:{' '}
            <Score v={week.sleepAvg} color={sleepColor(week.sleepAvg)} suffix=" год" />
            {trend}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-2.5 rounded-2xl border border-glassb bg-glass p-4">
        <div className="flex items-baseline gap-2">
          <span className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            ЕНЕРГІЯ (СЕРЕДНЄ ЗА ДОБУ)
          </span>
          <Score
            v={week?.energyAvg ?? null}
            color={ratingColor(week?.energyAvg ?? null)}
            className="ml-auto font-mono text-[17px] font-semibold"
          />
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

      {/* Куди йде час (v2): розподіл денної категорії + як вона повʼязана з
          оцінкою дня. Розподіл чесний за будь-якого N; середню оцінку категорії
          даємо лише коли в неї набралось >=4 оцінені дні (інакше без числа). */}
      {cat.total >= 5 && (
        <div className="rounded-2xl border border-glassb bg-glass p-4">
          <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            КУДИ ЙДЕ ЧАС · {cat.total} ДІБ
          </div>
          <div className="mt-2 flex flex-col gap-1.5">
            {cat.rows.slice(0, 4).map((r) => (
              <div key={r.cat} className="flex items-baseline gap-2 text-[13px]">
                <span className="font-semibold">{CATEGORY_LABEL[r.cat] ?? r.cat}</span>
                <span className="font-mono text-[11px] text-tx3">
                  {Math.round((r.n / cat.total) * 100)}%
                </span>
                {r.dayScore != null && (
                  <span className="ml-auto font-mono text-[11px] text-tx2">
                    настрій <Score v={r.dayScore} color={ratingColor(r.dayScore)} />
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Сон -> оцінка дня. Кореляція лише коли є що порівнювати. */}
      <div className="rounded-2xl border border-glassb bg-glass p-4">
        <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
          СОН І ОЦІНКА ДНЯ
        </div>
        {svd.ready ? (
          <>
            <div className="mt-1.5 text-[13px] font-semibold">
              Спав &lt;6.5 год — оцінка дня{' '}
              <Score v={svd.lowAvg ?? null} color={ratingColor(svd.lowAvg ?? null)} />
            </div>
            <div className="text-[13px] font-semibold">
              Спав більше — <Score v={svd.okAvg ?? null} color={ratingColor(svd.okAvg ?? null)} />
            </div>
            <div className="mt-1 text-[10.5px] text-tx3">
              {svd.low} і {svd.ok} днів. Це спостереження, не причина.
            </div>
          </>
        ) : (
          <div className="mt-1.5 text-[12px] leading-[1.5] text-tx2">
            Ще рано порівнювати: {svd.low} коротких ночей і {svd.ok} нормальних, а треба
            щонайменше по {svd.needed}. На меншій вибірці будь-яка цифра тут була б
            вигадкою, тому її немає.
          </div>
        )}
      </div>

      {bve.ready && (
        <div className="rounded-2xl border border-glassb bg-glass p-4">
          <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            КОЛИ ЛЯГАЄШ І РАНКОВА ЕНЕРГІЯ
          </div>
          <div className="mt-1.5 text-[13px] font-semibold">
            Лягав рано (до 00:00) — енергія{' '}
            <Score v={bve.earlyAvg ?? null} color={ratingColor(bve.earlyAvg ?? null)} />
          </div>
          <div className="text-[13px] font-semibold">
            Пізно (після 01:00) —{' '}
            <Score v={bve.lateAvg ?? null} color={ratingColor(bve.lateAvg ?? null)} />
          </div>
          <div className="mt-1 text-[10.5px] text-tx3">
            {bve.early} і {bve.late} днів. Спостереження, не причина.
          </div>
        </div>
      )}

      {/* Що піднімає / тягне — мода за N діб. */}
      {tops.blocker && (
        <StatRow
          label="🚧 Найчастіше заважало"
          value={`${BLOCKER_LABEL[tops.blocker.value] ?? tops.blocker.value} · ${tops.blocker.n}×`}
        />
      )}
      {tops.helper && (
        <StatRow
          label="✨ Найчастіше допомагало"
          value={`${HELPER_LABEL[tops.helper.value] ?? tops.helper.value} · ${tops.helper.n}×`}
        />
      )}

      {/* Джоб-опційне — зʼявляється лише в дні пошуку роботи (є подачі в журналі
          / самозвіт). У «загальні» дні цих рядків просто немає. */}
      {kept.length > 0 && (
        <StatRow label="🎯 Виконав план подач" value={`${keptHit} з ${kept.length} днів`} />
      )}
      {cal.n > 0 && (
        <div className="rounded-2xl border border-glassb bg-glass p-4">
          <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">
            📊 ПОДАЧІ: ЗВІТ ↔ ЖУРНАЛ
          </div>
          <div className="mt-1.5 text-[13px] font-semibold">
            Збіглося {cal.matched} з {cal.n} днів
          </div>
          {(cal.more > 0 || cal.fewer > 0) && (
            <div className="mt-1 text-[10.5px] leading-[1.5] text-tx3">
              {cal.more > 0 && `${cal.more} дн. подавав поза застосунком`}
              {cal.more > 0 && cal.fewer > 0 && ' · '}
              {cal.fewer > 0 && `${cal.fewer} дн. у журналі більше`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
