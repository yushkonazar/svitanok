// Детермінований шар «на що звернути увагу сьогодні».
//
// Це НЕ LLM-резюме і не планувальник дій. Функції нижче працюють лише з уже
// отриманими snapshots/виміряними полями, тож кожен сигнал має перевірювані
// source + freshness + reason. Модель може пізніше ранжувати або пояснювати
// ці дані, але не має права підміняти їх вигаданими критичними фактами.

import type { WeatherToday } from '../modules/weather.js';
import type { CalendarEvent, CalendarSnapshot } from '../modules/calendar.js';
import type { MailTriageState } from '../modules/mail.js';

export type DecisionSignalLevel = 'critical' | 'attention';
export type DecisionSource = 'reminders' | 'calendar' | 'mail' | 'weather';

export interface DecisionSignal {
  id: string;
  level: DecisionSignalLevel;
  source: DecisionSource;
  /** Машинно-читана, пояснювана причина; не LLM-висновок. */
  reason: string;
  /** Людський стислий опис на основі тільки зафіксованих даних. */
  summary: string;
  /** ISO момент snapshot-а/виміру, або null коли джерело не надало його чесно. */
  freshness: string | null;
}

export interface DecisionBrief {
  generatedAt: string;
  signals: DecisionSignal[];
}

export interface ReminderSnapshotForDecision {
  date?: string;
  ready?: boolean;
  updatedAt?: string;
  source?: 'both' | 'd1' | 'legacy';
  reminders?: { id?: string; text?: string; dueAt?: string }[];
}

export interface DecisionBriefInput {
  todayKey: string;
  generatedAt: string;
  calendar?: CalendarSnapshot;
  reminders?: ReminderSnapshotForDecision;
  mail?: MailTriageState;
  weather?: WeatherToday;
}

function finiteMs(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoFromMs(value: unknown): string | null {
  const ms = finiteMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

function validIso(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function timedSpan(event: CalendarEvent): { startMs: number; endMs: number } | null {
  // All-day events intentionally do not become a "calendar conflict": they
  // describe availability, but contain no precise meeting interval.
  if (!event.time) return null;
  const startMs = finiteMs(event.startMs);
  const endMs = finiteMs(event.endMs);
  return startMs !== null && endMs !== null && endMs > startMs ? { startMs, endMs } : null;
}

/** Усі парні перетини точних timed-подій, максимум один раз на пару. */
export function findCalendarConflicts(
  events: readonly CalendarEvent[],
): [CalendarEvent, CalendarEvent][] {
  const conflicts: [CalendarEvent, CalendarEvent][] = [];
  for (let i = 0; i < events.length; i += 1) {
    const left = events[i]!;
    const leftSpan = timedSpan(left);
    if (!leftSpan) continue;
    for (let j = i + 1; j < events.length; j += 1) {
      const right = events[j]!;
      const rightSpan = timedSpan(right);
      if (!rightSpan) continue;
      if (leftSpan.startMs < rightSpan.endMs && rightSpan.startMs < leftSpan.endMs) {
        conflicts.push([left, right]);
      }
    }
  }
  return conflicts;
}

function compactReminderSummary(reminders: { text: string; dueAt: string }[]): string {
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const sample = reminders.slice(0, 3).map((r) => `${fmt.format(new Date(r.dueAt))} — ${r.text}`);
  const more = reminders.length > sample.length ? `; ще ${reminders.length - sample.length}` : '';
  return `Нагадування до кінця дня: ${sample.join('; ')}${more}.`;
}

/**
 * Зібрати критичні й attention-сигнали. Невідоме/застаріле джерело просто не
 * дає сигнал — краще відсутність підказки, ніж «сьогодні» з учорашніх даних.
 */
export function buildDecisionBrief(input: DecisionBriefInput): DecisionBrief {
  const signals: DecisionSignal[] = [];
  const nowIso = validIso(input.generatedAt) ?? input.generatedAt;

  const reminderSnapshot = input.reminders;
  if (reminderSnapshot?.ready && reminderSnapshot.date === input.todayKey) {
    const reminders = (reminderSnapshot.reminders ?? [])
      .filter(
        (r): r is { id: string; text: string; dueAt: string } =>
          typeof r?.id === 'string' && typeof r.text === 'string' && validIso(r.dueAt) !== null,
      )
      .sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    if (reminders.length > 0) {
      signals.push({
        id: 'reminders-today',
        level: 'critical',
        source: 'reminders',
        reason: 'due_today_or_overdue',
        summary: compactReminderSummary(reminders),
        freshness: validIso(reminderSnapshot.updatedAt),
      });
    }
  }

  const calendarSnapshot = input.calendar;
  if (calendarSnapshot?.ready && calendarSnapshot.date === input.todayKey) {
    const events = Array.isArray(calendarSnapshot.events) ? calendarSnapshot.events : [];
    const conflicts = findCalendarConflicts(events);
    const firstConflict = conflicts[0];
    if (firstConflict) {
      const [first, second] = firstConflict;
      signals.push({
        id: 'calendar-conflict',
        level: 'critical',
        source: 'calendar',
        reason: 'overlapping_timed_events',
        summary:
          conflicts.length === 1
            ? `Перетин у календарі: ${first.time ?? '—'} ${first.title} і ${second.time ?? '—'} ${second.title}.`
            : `Перетинів у календарі: ${conflicts.length}. Перший: ${first.time ?? '—'} ${first.title} і ${second.time ?? '—'} ${second.title}.`,
        freshness: validIso(calendarSnapshot.updatedAt),
      });
    }
  }

  const candidates = input.mail?.candidates ?? [];
  const criticalMail = candidates.filter((c) => c.attention?.level === 'critical');
  const attentionMail = candidates.filter((c) => c.attention?.level === 'attention');
  const mailFreshness = isoFromMs(input.mail?.lastRunMs);
  if (criticalMail.length > 0) {
    const reasons = [...new Set(criticalMail.flatMap((c) => c.attention?.reasons ?? []))].sort();
    signals.push({
      id: 'mail-critical',
      level: 'critical',
      source: 'mail',
      reason: reasons.join(',') || 'deterministic_urgent_mail_signal',
      summary: `Пошта: ${criticalMail.length} терміновий сигнал${criticalMail.length === 1 ? '' : 'и'} (співбесіда, дедлайн або чутливий час).`,
      freshness: mailFreshness,
    });
  } else if (attentionMail.length > 0) {
    const reasons = [...new Set(attentionMail.flatMap((c) => c.attention?.reasons ?? []))].sort();
    signals.push({
      id: 'mail-attention',
      level: 'attention',
      source: 'mail',
      reason: reasons.join(',') || 'deterministic_job_signal',
      summary: `Пошта: ${attentionMail.length} сигнал${attentionMail.length === 1 ? '' : 'и'} щодо вакансій або рекрутингу.`,
      freshness: mailFreshness,
    });
  }

  const weather = input.weather;
  if (weather) {
    if (Array.isArray(weather.alerts) && weather.alerts.length > 0) {
      signals.push({
        id: 'weather-alert',
        level: 'critical',
        source: 'weather',
        reason: 'official_weather_alert',
        summary: `Погода (${weather.name}): офіційне попередження — ${weather.alerts.slice(0, 2).join('; ')}.`,
        freshness: nowIso,
      });
    } else if (weather.willRain) {
      signals.push({
        id: 'weather-rain',
        level: 'attention',
        source: 'weather',
        reason: 'daytime_precipitation_probability',
        summary: `Погода (${weather.name}): опади ймовірні на ${weather.popPercent}%${weather.rainWindow ? `, ${weather.rainWindow}` : ''}.`,
        freshness: nowIso,
      });
    } else if (weather.willBeCold) {
      signals.push({
        id: 'weather-cold',
        level: 'attention',
        source: 'weather',
        reason: 'cold_threshold',
        summary: `Погода (${weather.name}): прохолодно, ${weather.tempC}° (відчувається ${weather.feelsLikeC}°).`,
        freshness: nowIso,
      });
    }
  }

  const sourceOrder: Record<DecisionSource, number> = {
    reminders: 0,
    calendar: 1,
    mail: 2,
    weather: 3,
  };
  signals.sort(
    (a, b) =>
      (a.level === b.level ? 0 : a.level === 'critical' ? -1 : 1) ||
      sourceOrder[a.source] - sourceOrder[b.source],
  );
  return { generatedAt: nowIso, signals };
}

/** Один рядок для Telegram; деталі лишаються у структурованому briefing.json. */
export function formatDecisionHeadline(decision: DecisionBrief): string | null {
  const critical = decision.signals.filter((s) => s.level === 'critical');
  if (critical.length === 0) return null;
  const labels: Record<DecisionSource, string> = {
    reminders: 'нагадування',
    calendar: 'перетин у календарі',
    mail: 'важлива пошта',
    weather: 'попередження про погоду',
  };
  const unique = [...new Set(critical.map((s) => labels[s.source]))];
  return `⚠️ Сьогодні: ${unique.join(' · ')}`;
}
