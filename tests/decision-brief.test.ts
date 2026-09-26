import { describe, expect, it } from 'vitest';
import {
  buildDecisionBrief,
  buildDecisionSummaryPrompt,
  findCalendarConflicts,
  formatDecisionHeadline,
  parseDecisionAiSummary,
} from '../src/core/decision-brief.js';
import type { CalendarEvent } from '../src/modules/calendar.js';
import type { WeatherToday } from '../src/modules/weather.js';

const TODAY = '2026-09-08';
const GENERATED = '2026-09-08T05:00:00.000Z';

const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  title: 'Подія',
  time: '10:00',
  startMs: Date.parse('2026-09-08T07:00:00.000Z'),
  endMs: Date.parse('2026-09-08T08:00:00.000Z'),
  ...over,
});

const weather = (over: Partial<WeatherToday> = {}): WeatherToday =>
  ({
    name: 'Львів',
    tempC: 14,
    minC: 10,
    maxC: 17,
    feelsLikeC: 13,
    windMps: 3,
    condition: 'хмарно',
    emoji: '☁️',
    willRain: false,
    willBeCold: false,
    popPercent: 0,
    sunrise: 1,
    sunset: 2,
    ...over,
  }) as WeatherToday;

describe('decision brief — exact deterministic facts only', () => {
  it('detects an actual timed overlap, but not boundary-touching or all-day events', () => {
    const events = [
      event({ title: 'A', startMs: 100, endMs: 200 }),
      event({ title: 'B', startMs: 150, endMs: 250 }),
      event({ title: 'C', startMs: 250, endMs: 300 }),
      event({ title: 'Весь день', time: null, startMs: 0, endMs: 1_000 }),
    ];
    expect(findCalendarConflicts(events)).toEqual([[events[0], events[1]]]);
  });

  it('makes a critical signal for each supported critical source with source/freshness/reason', () => {
    const decision = buildDecisionBrief({
      todayKey: TODAY,
      generatedAt: GENERATED,
      reminders: {
        date: TODAY,
        ready: true,
        updatedAt: '2026-09-08T04:30:00.000Z',
        source: 'd1',
        reminders: [{ id: 'r1', text: 'Зателефонувати', dueAt: '2026-09-08T06:00:00.000Z' }],
      },
      calendar: {
        date: TODAY,
        ready: true,
        updatedAt: '2026-09-08T04:00:00.000Z',
        events: [
          event({ title: 'Дзвінок', time: '10:00', startMs: 100, endMs: 200 }),
          event({ title: 'Зустріч', time: '10:30', startMs: 150, endMs: 250 }),
        ],
      },
      mail: {
        lastRunMs: Date.parse('2026-09-08T04:45:00.000Z'),
        candidates: [
          {
            id: 'm1',
            attention: { level: 'critical', reasons: ['interview_or_deadline'] },
          },
        ],
      },
      weather: weather({ alerts: ['Strong wind'] }),
    });

    expect(decision.signals.map((s) => [s.source, s.level, s.reason])).toEqual([
      ['reminders', 'critical', 'due_today_or_overdue'],
      ['calendar', 'critical', 'overlapping_timed_events'],
      ['mail', 'critical', 'interview_or_deadline'],
      ['weather', 'critical', 'official_weather_alert'],
    ]);
    expect(decision.signals.every((s) => s.freshness !== null)).toBe(true);
    expect(decision.signals[0]?.summary).toContain('Зателефонувати');
    expect(formatDecisionHeadline(decision)).toBe(
      '⚠️ Сьогодні: нагадування · перетин у календарі · важлива пошта · попередження про погоду',
    );
  });

  it('does not promote stale snapshots and keeps rain/job signals as non-critical attention', () => {
    const decision = buildDecisionBrief({
      todayKey: TODAY,
      generatedAt: GENERATED,
      reminders: {
        date: '2026-09-07',
        ready: true,
        reminders: [{ id: 'r1', text: 'Учора', dueAt: '2026-09-07T06:00:00.000Z' }],
      },
      calendar: {
        date: '2026-09-07',
        ready: true,
        events: [event({ startMs: 100, endMs: 200 }), event({ startMs: 150, endMs: 250 })],
      },
      mail: {
        lastRunMs: Date.parse('2026-09-08T04:45:00.000Z'),
        candidates: [{ id: 'm1', attention: { level: 'attention', reasons: ['job_signal'] } }],
      },
      weather: weather({ willRain: true, popPercent: 80, rainWindow: '14:00–17:00' }),
    });
    expect(decision.signals.map((s) => [s.source, s.level])).toEqual([
      ['mail', 'attention'],
      ['weather', 'attention'],
    ]);
    expect(formatDecisionHeadline(decision)).toBeNull();
  });

  it('accepts an AI enhancement only when it cites existing IDs and is bounded', () => {
    const decision = buildDecisionBrief({
      todayKey: TODAY,
      generatedAt: GENERATED,
      reminders: {
        date: TODAY,
        ready: true,
        updatedAt: GENERATED,
        reminders: [{ id: 'r1', text: 'CV', dueAt: '2026-09-08T06:00:00.000Z' }],
      },
    });
    expect(buildDecisionSummaryPrompt(decision)).toContain('SIGNALS_JSON=');
    expect(
      parseDecisionAiSummary(
        '{"rankedSignalIds":["reminders-today"],"summary":"Спершу перевірити нагадування."}',
        decision.signals,
      ),
    ).toEqual({
      rankedSignalIds: ['reminders-today'],
      summary: 'Спершу перевірити нагадування.',
    });
    expect(
      parseDecisionAiSummary(
        '{"rankedSignalIds":["invented"],"summary":"Вигаданий факт"}',
        decision.signals,
      ),
    ).toBeNull();
  });
});
