import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Stats } from '../../api/schema.ts';
import { inTelegram } from '../../telegram.ts';
import { useTick } from '../../lib/useTick.ts';
import { usePresentation } from '../../lib/presentation.ts';
import { useReducedMotion } from '../../lib/useReducedMotion.ts';
import { kyivParts } from '../../../../core/finance/planning.mjs';
import { shiftCheckinDate } from '../../../../core/checkin/observations.mjs';
import {
  stateReport,
  demoStateRecords,
  type StateInsight,
} from '../../../../core/checkin/state-analysis.mjs';
import { StateTimeline } from './StateTimeline.tsx';
import { StateDayDetail } from './StateDayDetail.tsx';
import {
  StateDates,
  StateComparisons,
  ComparisonResult,
  StateDistributionView,
} from './StateComparisons.tsx';
import { StateThemes } from './StateThemes.tsx';
import { StateHistory } from './StateHistory.tsx';
import { ObservationReview } from './ObservationReview.tsx';
import { stateDate, stateNumber, stateCount } from './state-format.ts';

function SleepMetric({ value }: { value: number | null }) {
  if (value == null) return <>—</>;
  const minutes = Math.round((value * 60) / 5) * 5;
  return (
    <>
      {value > 0 ? '≈ ' : ''}
      {Math.floor(minutes / 60)} <small>год{minutes % 60 ? ` ${minutes % 60} хв` : ''}</small>
    </>
  );
}

function Insight({
  item,
  report,
  onDay,
  explanations,
}: {
  item: StateInsight;
  report: ReturnType<typeof stateReport>;
  onDay: (d: string) => void;
  explanations: boolean;
}) {
  const relevant = report.current.filter((day) => item.dates.includes(day.date));
  return (
    <article className="state-insight">
      <span className="state-insight-kind">
        {item.kind === 'comparison'
          ? 'Зіставлення записів'
          : item.kind === 'self-report'
            ? 'Твоє враження'
            : 'Спостереження'}
      </span>
      <h3>{item.title}</h3>
      <p>{item.text}</p>
      {item.idea && (
        <p className="state-idea">
          <span>Можна спробувати</span>
          {item.idea}
        </p>
      )}
      <details className="state-evidence">
        <summary>
          На чому це ґрунтується{' '}
          <span>
            {item.n} {item.kind === 'self-report' ? 'відповідей' : 'днів'}
          </span>
        </summary>
        <div>
          {item.comparison ? (
            <ComparisonResult result={item.comparison} onDay={onDay} />
          ) : (
            <StateDates dates={item.dates} onDay={onDay} />
          )}
          {['daily-energy', 'work_breaks'].includes(item.id) && (
            <StateDistributionView
              days={relevant}
              slot="evening"
              stem="energyFactors"
              title="Твої пояснення втоми"
              onDay={onDay}
            />
          )}
          {item.id === 'sleep_duration' && (
            <>
              <StateDistributionView
                days={relevant}
                slot="morning"
                stem="sleepBlockers"
                title="Твої пояснення: що заважало сну"
                onDay={onDay}
              />
              <StateDistributionView
                days={relevant}
                slot="morning"
                stem="sleepHelpers"
                title="Твої пояснення: що допомагало сну"
                onDay={onDay}
              />
            </>
          )}
          {item.id === 'recovery' && (
            <StateDistributionView
              days={relevant}
              slot="evening"
              stem="recoveryHelpers"
              revision={4}
              title="Твої пояснення відновлення"
              onDay={onDay}
            />
          )}
          {item.id === 'mood-change' && (
            <StateDistributionView
              days={relevant}
              slot="evening"
              stem="moodFactors"
              title="Твої пояснення вечірнього настрою"
              onDay={onDay}
            />
          )}
          {explanations && (
            <p className="state-caption">
              Це опис власних відповідей за обраний період. Уточнення пояснюють твій досвід і не
              доводять причину змін.
            </p>
          )}
        </div>
      </details>
    </article>
  );
}

export function StateDashboard({
  s,
  days,
  setDays,
}: {
  s: Stats;
  days: number;
  setDays: (n: number) => void;
}) {
  const now = useTick(60000),
    to = s.checkinDate ?? kyivParts(now).date,
    demo = !inTelegram();
  const preferences = usePresentation(),
    reduced = useReducedMotion();
  const records = useMemo(() => {
    const initial = demo ? demoStateRecords(to) : {};
    const raw = demo
      ? Object.fromEntries(
          Object.entries(s.checkinRaw.records).filter(([, day]) =>
            Object.values(day).some((record) => [3, 4].includes(Number(record?.questionVersion))),
          ),
        )
      : s.checkinRaw.records;
    const today = demo
      ? Object.fromEntries(
          Object.entries(s.checkinToday ?? {}).filter(([, record]) =>
            [3, 4].includes(Number(record?.questionVersion)),
          ),
        )
      : s.checkinToday;
    return {
      ...initial,
      ...raw,
      [to]: { ...initial[to], ...raw[to], ...today },
    };
  }, [s.checkinRaw.records, s.checkinToday, to, demo]);
  const report = useMemo(() => stateReport(records, to, days), [records, to, days]);
  const [metric, setMetric] = useState<'energy' | 'mood'>('energy'),
    [selection, setSelection] = useState<{ date: string; period: string } | null>(null),
    [explorer, setExplorer] = useState(false),
    [legacy, setLegacy] = useState(false);
  const period = `${report.from}/${to}`,
    fallback =
      report.current
        .filter((d) => d.morning.confirmed || d.afternoon.confirmed || d.evening.confirmed)
        .at(-1) ?? report.current.at(-1)!;
  const selected = selection?.period === period ? selection.date : fallback.date;
  const chosen = report.current.find((d) => d.date === selected) ?? fallback;
  const timeline = useRef<HTMLElement>(null),
    detail = useRef<HTMLDetailsElement>(null);
  const select = (date: string) =>
    setSelection((prior) =>
      prior?.date === date && prior.period === period ? prior : { date, period },
    );
  const reveal = (date: string) => {
    if (!report.current.some((d) => d.date === date)) return;
    select(date);
    if (detail.current) {
      detail.current.open = true;
      detail.current.scrollIntoView?.({
        behavior: preferences.calm || reduced ? 'instant' : 'smooth',
        block: 'start',
      });
    }
  };
  const primary = report.overview.filter((item) => item.n > 0);
  return (
    <>
      <header className="state-page-heading">
        <div>
          <p>ТВОЇ СПОСТЕРЕЖЕННЯ</p>
          <h1>Мій стан</h1>
        </div>
        <Link to="/checkin" className="state-quiet-link">
          До чек-іну ↗
        </Link>
      </header>
      <div className="state-period">
        <div className="renewal-segments" aria-label="Період статистики">
          {[7, 30, 90].map((n) => (
            <button type="button" key={n} aria-pressed={days === n} onClick={() => setDays(n)}>
              {n} днів
            </button>
          ))}
        </div>
        <p className="state-caption">
          {stateDate(report.from)} — {stateDate(to)} · {report.recordedDays} з {days} днів із
          записами
        </p>
      </div>
      {!report.recordedDays ? (
        <div className="state-panel state-empty">
          <h2>Тут з’явиться твій ритм</h2>
          <p>
            Після підтверджених чек-інів побачиш стан, зміни й короткі спостереження. Порожні дні не
            знижують показники.
          </p>
          <Link className="renewal-primary" to="/checkin">
            Відкрити чек-ін
          </Link>
        </div>
      ) : (
        <>
          <div className="state-overview">
            {primary.map((item) => (
              <button
                type="button"
                className={`state-metric state-metric-${item.id}`}
                key={item.id}
                onClick={() => {
                  if (item.id === 'energy' || item.id === 'mood') {
                    setMetric(item.id);
                    timeline.current?.scrollIntoView?.({
                      behavior: preferences.calm || reduced ? 'instant' : 'smooth',
                      block: 'start',
                    });
                  } else if (item.id === 'sleep') {
                    const target = document.getElementById(
                      'state-sleep',
                    ) as HTMLDetailsElement | null;
                    if (target) {
                      target.open = true;
                      target.scrollIntoView?.({
                        behavior: preferences.calm || reduced ? 'instant' : 'smooth',
                        block: 'start',
                      });
                    }
                  } else reveal(chosen.date);
                }}
              >
                <span>
                  {item.label}
                  <span aria-hidden="true">↗</span>
                </span>
                <b>
                  {item.unit === 'hours' ? (
                    <SleepMetric value={item.value} />
                  ) : (
                    <>
                      {stateNumber(item.value)}
                      <small>/5</small>
                    </>
                  )}
                </b>
                <span className="state-metric-n">
                  {item.id === 'sleep'
                    ? stateCount(item.n, 'ранковий запис', 'ранкові записи', 'ранкових записів')
                    : item.id === 'satisfaction'
                      ? stateCount(item.n, 'вечірній запис', 'вечірні записи', 'вечірніх записів')
                      : stateCount(item.n, 'оцінка', 'оцінки', 'оцінок')}
                </span>
                {item.delta != null ? (
                  <span
                    className={`state-delta ${item.unit === 'hours' || Math.abs(item.delta) < 0.05 ? '' : item.delta >= 0 ? 'is-up' : 'is-down'}`}
                  >
                    {Math.abs(item.delta) < (item.unit === 'hours' ? 5 / 60 : 0.05)
                      ? '≈ Без змін'
                      : `${item.delta > 0 ? '↑' : '↓'} ${item.unit === 'hours' ? `${Math.round(Math.abs(item.delta) * 12) * 5} хв` : `${stateNumber(Math.abs(item.delta))} б.`}`}{' '}
                    проти попередніх {days} днів
                  </span>
                ) : (
                  <span className="state-metric-context">
                    {item.id === 'sleep'
                      ? 'Середня зазначена тривалість'
                      : item.id === 'satisfaction'
                        ? 'Твоя підсумкова оцінка'
                        : 'Середнє за часом дня'}
                  </span>
                )}
              </button>
            ))}
          </div>
          <details
            className="state-subdetails state-method"
            open={preferences.explanations || undefined}
          >
            <summary>Як читати показники</summary>
            <p className="state-caption">
              Настрій і енергія — середнє доступних ранкових, денних та вечірніх оцінок з однаковою
              вагою часу дня. Зміну показуємо, коли склад записів можна зіставити.
            </p>
            <p className="state-caption">
              Попередній період: {stateDate(report.previousFrom)} — {stateDate(report.previousTo)}.
              Для зміни потрібно щонайменше по 3 оцінки в кожному зіставному часі дня.
            </p>
            {primary.map((item) => (
              <p className="state-caption" key={item.id}>
                {item.label}: {item.n} відповідей зараз · {item.previousN} у попередньому періоді
                {item.delta == null ? ' · поки без зіставної зміни' : ''}.
              </p>
            ))}
          </details>
          <section className="state-insights" aria-label="Спостереження за період">
            {report.insights.length ? (
              report.insights.map((item) => (
                <Insight
                  key={item.id}
                  item={item}
                  report={report}
                  onDay={reveal}
                  explanations={preferences.explanations}
                />
              ))
            ) : (
              <p className="state-empty">
                Відповіді вже є в огляді. Короткі спостереження з’являться, коли буде достатньо
                записів для зіставлення.
              </p>
            )}
          </section>
          <section ref={timeline} className="state-panel state-timeline-panel">
            <div className="state-section-heading">
              <h2>Як змінюється стан</h2>
              <div className="renewal-segments">
                <button
                  type="button"
                  aria-pressed={metric === 'energy'}
                  onClick={() => setMetric('energy')}
                >
                  Енергія
                </button>
                <button
                  type="button"
                  aria-pressed={metric === 'mood'}
                  onClick={() => setMetric('mood')}
                >
                  Настрій
                </button>
              </div>
            </div>
            <StateTimeline
              days={report.current}
              metric={metric}
              selected={chosen.date}
              onSelect={select}
            />
            <details key={period} ref={detail} className="state-record-details">
              <summary>
                Відповіді за {stateDate(chosen.date)} <span>↗</span>
              </summary>
              <label className="renewal-field">
                <span>День для перегляду</span>
                <input
                  type="date"
                  min={report.from}
                  max={to}
                  value={chosen.date}
                  onChange={(e) => {
                    if (e.target.value >= report.from && e.target.value <= to)
                      select(e.target.value);
                  }}
                />
              </label>
              <StateDayDetail day={chosen} />
            </details>
          </section>
          <StateThemes report={report} onDay={reveal} explanations={preferences.explanations} />
          <details className="state-panel" onToggle={(e) => setExplorer(e.currentTarget.open)}>
            <summary>
              <span>Дослідити власні зв’язки</span>
              <small>Порівняння · твої пояснення</small>
            </summary>
            {explorer && (
              <div className="state-panel-body">
                <StateComparisons days={report.current} onDay={reveal} />
              </div>
            )}
          </details>
        </>
      )}
      <StateHistory
        records={records}
        from={demo ? shiftCheckinDate(to, -41) : s.checkinRaw.from}
        to={to}
      />
      {Object.values(s.checkinRaw.records).some((day) =>
        Object.values(day).some(
          (record) => record?.confirmed && ![3, 4].includes(Number(record.questionVersion)),
        ),
      ) && (
        <details className="state-panel" onToggle={(e) => setLegacy(e.currentTarget.open)}>
          <summary>
            <span>Попередні формулювання чек-інів</span>
          </summary>
          {legacy && (
            <div className="state-panel-body">
              <ObservationReview s={s} days={days} setDays={setDays} />
            </div>
          )}
        </details>
      )}
      <Link to="/weekly-report" className="state-quiet-link state-weekly-link">
        Тижневі огляди <span>→</span>
      </Link>
    </>
  );
}
