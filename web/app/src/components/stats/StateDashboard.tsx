import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CheckinSlot, Stats } from '../../api/schema.ts';
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
import { StateOverview } from './StateOverview.tsx';
import { stateWeek } from '../../../../core/checkin/state-week.mjs';
import { StateWeekOverview } from './StateWeekOverview.tsx';
import { StateTimeline } from './StateTimeline.tsx';
import { StateDayDetail } from './StateDayDetail.tsx';
import {
  StateDates,
  StateComparisons,
  ComparisonResult,
  StateDistributionView,
  type StateEvidence,
} from './StateComparisons.tsx';
import { StateThemes } from './StateThemes.tsx';
import { StateHistory } from './StateHistory.tsx';
import { ObservationReview } from './ObservationReview.tsx';
import { stateDate, stateDays, slotNames } from './state-format.ts';
import {
  stateHasSlots,
  stateMetricNames,
  stateSlots,
  type StateMetricKey,
  type StateSlotFilter,
} from './state-series.ts';

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

const modes = { overview: 'Огляд', rhythm: 'Ритм', links: 'Зв’язки' } as const;
type Mode = keyof typeof modes;

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
  const { current } = report;
  const week = useMemo(() => (days === 7 ? stateWeek(current) : null), [days, current]);
  const [mode, setMode] = useState<Mode>('overview');
  const [metric, setMetric] = useState<StateMetricKey>('energy');
  const [slot, setSlot] = useState<StateSlotFilter>('all');
  const [selection, setSelection] = useState<{ date: string; evidencePeriod?: string } | null>(
    null,
  );
  const [overlay, setOverlay] = useState<StateEvidence | null>(null);
  const [linksVisited, setLinksVisited] = useState(false);
  const [workEntry, setWorkEntry] = useState(0);
  const [legacy, setLegacy] = useState(false);
  const nav = useRef<HTMLDivElement>(null);
  const detail = useRef<HTMLElement>(null);
  const pendingScroll = useRef<'nav' | 'day' | null>(null);

  const period = `${report.from}/${to}`;
  const fallback =
    report.current.filter((day) => stateSlots.some((slot) => day[slot].confirmed)).at(-1) ??
    report.current.at(-1)!;
  const chosen = report.current.find((day) => day.date === selection?.date) ?? fallback;
  const showDay = mode === 'rhythm' || (mode === 'links' && selection?.evidencePeriod === period);
  const remaining = report.insights.filter(
    (item) => item.id !== 'work_breaks' && item.id !== 'daily-energy',
  );
  const active = report.recordedDays > 0;

  useEffect(() => {
    const target = pendingScroll.current;
    if (!target) return;
    pendingScroll.current = null;
    const element = target === 'nav' ? nav.current : detail.current;
    element?.scrollIntoView?.({
      behavior: preferences.calm || reduced ? 'instant' : 'smooth',
      block: 'start',
    });
    element
      ?.querySelector<HTMLElement>(target === 'nav' ? '[aria-pressed="true"]' : 'h2')
      ?.focus({ preventScroll: true });
  });

  const openMode = (next: Mode) => {
    if (next === 'links') setLinksVisited(true);
    setMode(next);
  };
  const select = (date: string) =>
    setSelection((prior) => (prior?.date === date ? prior : { date }));
  const reveal = (date: string) => {
    if (!report.current.some((day) => day.date === date)) return;
    pendingScroll.current = 'day';
    setSelection({ date, evidencePeriod: period });
    if (mode === 'overview') openMode('rhythm');
  };
  const openMetric = (metric: StateMetricKey, slot: CheckinSlot) => {
    pendingScroll.current = 'nav';
    setMetric(metric);
    setSlot(slot);
    setOverlay(null);
    openMode('rhythm');
  };
  const showEvidence = (group: StateEvidence) => {
    const date = group.dates.includes(chosen.date) ? chosen.date : group.dates.at(-1);
    if (!date) return;
    openMetric(group.metric, group.slot);
    select(date);
    setOverlay(group);
  };

  return (
    <>
      <header className="state-page-heading">
        <h1>Мій стан</h1>
        <Link to="/checkin" className="state-quiet-link">
          До чек-іну ↗
        </Link>
      </header>
      <div className="state-period">
        <div className="renewal-segments" role="group" aria-label="Період статистики">
          {[7, 30, 90].map((n) => (
            <button
              type="button"
              key={n}
              aria-pressed={days === n}
              onClick={() => {
                if (n !== days) setOverlay(null);
                setDays(n);
              }}
            >
              {n} днів
            </button>
          ))}
        </div>
        <p className="state-caption" aria-live="polite">
          {stateDate(report.from)} — {stateDate(to)} · {report.recordedDays} з {days} днів із
          записами
        </p>
      </div>
      {active && (
        <div className="state-modes" ref={nav} role="group" aria-label="Подання статистики">
          {(Object.keys(modes) as Mode[]).map((item) => (
            <button
              type="button"
              key={item}
              aria-pressed={mode === item}
              onClick={() => openMode(item)}
            >
              {modes[item]}
            </button>
          ))}
        </div>
      )}
      <section
        className="state-mode-panel"
        aria-label="Огляд за період"
        hidden={active && mode !== 'overview'}
      >
        {active ? (
          <>
            {week ? (
              <StateWeekOverview
                signals={week.signals}
                automatic={week.focus}
                days={report.current}
                demo={demo}
                selected={selection?.date}
                onSelect={select}
              />
            ) : (
              <StateOverview
                report={report}
                onMetric={openMetric}
                onWork={() => {
                  pendingScroll.current = 'nav';
                  setWorkEntry((entry) => entry + 1);
                  openMode('links');
                }}
                explanations={preferences.explanations}
              />
            )}
            {remaining.length > 0 && (
              <details className="state-panel">
                <summary>Інші спостереження</summary>
                <div className="state-panel-body state-insights">
                  {remaining.map((item) => (
                    <Insight
                      key={item.id}
                      item={item}
                      report={report}
                      onDay={reveal}
                      explanations={preferences.explanations}
                    />
                  ))}
                </div>
              </details>
            )}
            <StateThemes report={report} onDay={reveal} explanations={preferences.explanations} />
          </>
        ) : (
          <div className="state-panel state-empty">
            <h2>Тут з’явиться твій ритм</h2>
            <p>Після підтверджених чек-інів побачиш стан, зміни й короткі спостереження.</p>
            <Link className="renewal-primary" to="/checkin">
              Відкрити чек-ін
            </Link>
          </div>
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
          <details
            className="state-panel"
            onToggle={(event) => setLegacy(event.currentTarget.open)}
          >
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
          Тижневі огляди <span aria-hidden="true">→</span>
        </Link>
      </section>
      {active && mode === 'rhythm' && (
        <section className="state-panel state-timeline-panel" aria-label="Ритм чек-інів">
          <label className="renewal-field">
            <span>Показник графіка</span>
            <select
              value={metric}
              onChange={(event) => {
                setMetric(event.target.value as StateMetricKey);
                setOverlay(null);
              }}
            >
              {Object.entries(stateMetricNames).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {stateHasSlots(metric) && (
            <div
              className="renewal-segments state-slot-filter"
              role="group"
              aria-label="Частина дня"
            >
              {([...stateSlots, 'all'] as const).map((key) => (
                <button
                  type="button"
                  key={key}
                  aria-pressed={slot === key}
                  onClick={() => {
                    setSlot(key);
                    if (key !== 'all' && key !== overlay?.slot) setOverlay(null);
                  }}
                >
                  {key === 'all' ? 'Усі' : slotNames[key]}
                </button>
              ))}
            </div>
          )}
          {overlay && (
            <div className="state-overlay">
              <span>
                {overlay.label} · {stateDays(overlay.dates.length)}
                {days === 90 ? ' · виділені їхні тижні' : ''}
              </span>
              <button
                type="button"
                aria-label="Прибрати виділення днів"
                onClick={() => setOverlay(null)}
              >
                ×
              </button>
            </div>
          )}
          <StateTimeline
            days={report.current}
            previous={report.previous}
            metric={metric}
            slot={slot}
            selected={chosen.date}
            highlighted={overlay?.dates}
            onSelect={select}
          />
        </section>
      )}
      {active && linksVisited && (
        <section
          className="state-panel state-links-panel"
          aria-label="Зв’язки й пояснення"
          hidden={mode !== 'links'}
        >
          <StateComparisons
            key={workEntry}
            days={report.current}
            onDay={reveal}
            onGraph={showEvidence}
            onContextChange={() =>
              setSelection((prior) => (prior?.evidencePeriod ? { date: prior.date } : prior))
            }
          />
        </section>
      )}
      {active && showDay && (
        <section ref={detail} className="state-panel state-day-panel" aria-label="Записи дня">
          <div className="state-day-heading">
            <h2 tabIndex={-1}>Відповіді за {stateDate(chosen.date)}</h2>
            <label className="state-day-picker">
              <span className="state-range-label">День для перегляду</span>
              <input
                type="date"
                min={report.from}
                max={to}
                value={chosen.date}
                onChange={(event) => {
                  const date = event.target.value;
                  if (date >= report.from && date <= to)
                    setSelection({ date, evidencePeriod: mode === 'links' ? period : undefined });
                }}
              />
            </label>
          </div>
          <StateDayDetail day={chosen} />
        </section>
      )}
    </>
  );
}
