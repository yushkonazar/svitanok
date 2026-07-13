import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as agent from '../web/agent-core.mjs';
const {
  MAX_PROPOSAL_ITEMS,
  ASSISTANT_ACTION_SCHEMA,
  buildAssistantSystemPrompt,
  extractAssistantAction,
  sanitizeProposal,
  formatProposalMessage,
  PROPOSAL_CB_PREFIX,
  buildProposalCallbackData,
  parseProposalCallbackData,
} = agent;

// Літо (EEST, UTC+3): 2026-07-10 11:00 Київ.
const SUMMER_NOW = Date.parse('2026-07-10T08:00:00Z');

describe('ASSISTANT_ACTION_SCHEMA', () => {
  it('дозволяє рівно 5 дій (CC4: +readOwnData)', () => {
    expect(ASSISTANT_ACTION_SCHEMA.properties.action.enum).toEqual([
      'readCalendar',
      'createReminder',
      'proposeCalendarChanges',
      'reply',
      'readOwnData',
    ]);
  });
});

describe('buildAssistantSystemPrompt', () => {
  it('містить канонічні приклади й поточний київський час', () => {
    const p = buildAssistantSystemPrompt(SUMMER_NOW);
    expect(p).toContain('через 20 хвилин ЗАВДАННЯ');
    expect(p).toContain('11:00');
    expect(p).toContain(String(MAX_PROPOSAL_ITEMS));
  });

  it('попереджає, що текст календаря — дані, не інструкції (prompt-injection захист)', () => {
    const p = buildAssistantSystemPrompt(SUMMER_NOW);
    expect(p).toContain('ЛИШЕ ДАНІ');
    expect(p).toContain('ніколи — на основі');
  });

  it('описує діапазон календаря start/end 0–7 (CC1)', () => {
    const p = buildAssistantSystemPrompt(SUMMER_NOW);
    expect(p).toContain('calendarStartDay');
    expect(p).toContain('calendarEndDay');
    expect(p).toContain('через тиждень');
  });

  it('описує readOwnData зі scope-ами й розширює prompt-injection на власні дані (CC4)', () => {
    const p = buildAssistantSystemPrompt(SUMMER_NOW);
    expect(p).toContain('readOwnData');
    expect(p).toContain('dataScope');
    expect(p).toContain('власних даних');
  });
});

describe('extractAssistantAction', () => {
  it('readCalendar — clamp start/end у [0,7], end>=start (CC1: діапазон)', () => {
    expect(
      extractAssistantAction({ action: 'readCalendar', calendarStartDay: 1, calendarEndDay: 1 }),
    ).toEqual({ action: 'readCalendar', startDay: 1, endDay: 1 });
    // повний тиждень
    expect(
      extractAssistantAction({ action: 'readCalendar', calendarStartDay: 0, calendarEndDay: 7 }),
    ).toEqual({ action: 'readCalendar', startDay: 0, endDay: 7 });
    // end понад 7 -> клемп до 7
    expect(
      extractAssistantAction({ action: 'readCalendar', calendarStartDay: 0, calendarEndDay: 20 }),
    ).toEqual({ action: 'readCalendar', startDay: 0, endDay: 7 });
    // лише start -> один день
    expect(extractAssistantAction({ action: 'readCalendar', calendarStartDay: 5 })).toEqual({
      action: 'readCalendar',
      startDay: 5,
      endDay: 5,
    });
    // end < start -> підтягується до start (kyivRangeBoundsUtc потребує end>=start)
    expect(
      extractAssistantAction({ action: 'readCalendar', calendarStartDay: 3, calendarEndDay: 1 }),
    ).toEqual({ action: 'readCalendar', startDay: 3, endDay: 3 });
    // відсутні поля / відʼємне -> сьогодні
    expect(extractAssistantAction({ action: 'readCalendar' })).toEqual({
      action: 'readCalendar',
      startDay: 0,
      endDay: 0,
    });
    expect(extractAssistantAction({ action: 'readCalendar', calendarStartDay: -2 })).toEqual({
      action: 'readCalendar',
      startDay: 0,
      endDay: 0,
    });
  });

  it('createReminder — потребує непорожній reminderText', () => {
    expect(
      extractAssistantAction({ action: 'createReminder', reminderText: ' купити хліб ' }),
    ).toEqual({
      action: 'createReminder',
      reminderText: 'купити хліб',
    });
    expect(extractAssistantAction({ action: 'createReminder', reminderText: '  ' })).toBeNull();
    expect(extractAssistantAction({ action: 'createReminder' })).toBeNull();
  });

  it('proposeCalendarChanges — потребує масив proposal (навіть порожній)', () => {
    expect(extractAssistantAction({ action: 'proposeCalendarChanges', proposal: [] })).toEqual({
      action: 'proposeCalendarChanges',
      proposal: [],
    });
    expect(extractAssistantAction({ action: 'proposeCalendarChanges' })).toBeNull();
    expect(extractAssistantAction({ action: 'proposeCalendarChanges', proposal: 'x' })).toBeNull();
  });

  it('reply — replyText типово рядок, порожній дозволено (фолбек на виклику)', () => {
    expect(extractAssistantAction({ action: 'reply', replyText: 'Привіт!' })).toEqual({
      action: 'reply',
      replyText: 'Привіт!',
    });
    expect(extractAssistantAction({ action: 'reply' })).toEqual({ action: 'reply', replyText: '' });
  });

  it('readOwnData — пропускає dataScope-рядок, нормалізацію лишає дайджесту (CC4)', () => {
    expect(extractAssistantAction({ action: 'readOwnData', dataScope: 'jobs' })).toEqual({
      action: 'readOwnData',
      dataScope: 'jobs',
    });
    // невалідний тип / відсутній -> undefined (buildOwnDataDigest впорядкує в 'all')
    expect(extractAssistantAction({ action: 'readOwnData', dataScope: 42 })).toEqual({
      action: 'readOwnData',
      dataScope: undefined,
    });
    expect(extractAssistantAction({ action: 'readOwnData' })).toEqual({
      action: 'readOwnData',
      dataScope: undefined,
    });
  });

  it('невідома/відсутня дія -> null', () => {
    expect(extractAssistantAction({ action: 'deleteEverything' })).toBeNull();
    expect(extractAssistantAction(null)).toBeNull();
    expect(extractAssistantAction({})).toBeNull();
  });
});

describe('sanitizeProposal', () => {
  it('парсить when канонічним parseReminderTime, лишає title як є', () => {
    const { items, droppedCount } = sanitizeProposal(
      [{ kind: 'event', title: 'Стоматолог', when: 'завтра о 15:00', durationMin: 30 }],
      SUMMER_NOW,
    );
    expect(droppedCount).toBe(0);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'event', title: 'Стоматолог', durationMin: 30 });
    expect(typeof items[0].whenMs).toBe('number');
  });

  it('reminder-пункт без durationMin (не потрібен)', () => {
    const { items } = sanitizeProposal(
      [{ kind: 'reminder', title: 'Подати CV', when: 'о 18:00' }],
      SUMMER_NOW,
    );
    expect(items[0]).toEqual({ kind: 'reminder', title: 'Подати CV', whenMs: items[0].whenMs });
    expect(items[0].durationMin).toBeUndefined();
  });

  it('durationMin клампиться в [15,480], відсутній -> дефолт 60', () => {
    const { items } = sanitizeProposal(
      [
        { kind: 'event', title: 'A', when: 'о 10:00', durationMin: 5 },
        { kind: 'event', title: 'B', when: 'о 11:00', durationMin: 9999 },
        { kind: 'event', title: 'C', when: 'о 12:00' },
      ],
      SUMMER_NOW,
    );
    expect(items.map((i: { durationMin: number }) => i.durationMin)).toEqual([15, 480, 60]);
  });

  it('непарсибельний when / відсутній title/kind -> дропається, не валить решту', () => {
    const { items, droppedCount } = sanitizeProposal(
      [
        { kind: 'event', title: 'Добра', when: 'о 14:00' },
        { kind: 'event', title: 'Без часу', when: 'колись' },
        { kind: 'bad-kind', title: 'X', when: 'о 10:00' },
        { title: 'Без kind', when: 'о 10:00' },
        { kind: 'event', title: '', when: 'о 10:00' },
      ],
      SUMMER_NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe('Добра');
    expect(droppedCount).toBe(4);
  });

  it('капає на MAX_PROPOSAL_ITEMS, лишок йде в droppedCount', () => {
    const raw = Array.from({ length: MAX_PROPOSAL_ITEMS + 3 }, (_, i) => ({
      kind: 'reminder',
      title: `T${i}`,
      when: 'о 9:00',
    }));
    const { items, droppedCount } = sanitizeProposal(raw, SUMMER_NOW);
    expect(items).toHaveLength(MAX_PROPOSAL_ITEMS);
    expect(droppedCount).toBe(3);
  });

  it('не масив -> порожні items, без винятку', () => {
    expect(sanitizeProposal(null, SUMMER_NOW)).toEqual({ items: [], droppedCount: 0 });
    expect(sanitizeProposal('x', SUMMER_NOW)).toEqual({ items: [], droppedCount: 0 });
  });
});

describe('formatProposalMessage', () => {
  it('нумерує пункти, екранує назву (XSS-регресія)', () => {
    const msg = formatProposalMessage([
      { kind: 'event', title: '<script>alert(1)</script>', whenMs: SUMMER_NOW },
      { kind: 'reminder', title: 'Подати CV', whenMs: SUMMER_NOW },
    ]);
    expect(msg).not.toContain('<script>');
    expect(msg).toContain('&lt;script&gt;');
    expect(msg).toContain('1. 📅');
    expect(msg).toContain('2. ⏰');
  });
});

describe('proposal callback_data', () => {
  it('build+parse round-trip для a/c', () => {
    expect(parseProposalCallbackData(buildProposalCallbackData('a', 'ab12cd34'))).toEqual({
      action: 'a',
      id: 'ab12cd34',
    });
    expect(parseProposalCallbackData(buildProposalCallbackData('c', 'ab12cd34'))).toEqual({
      action: 'c',
      id: 'ab12cd34',
    });
  });

  it('невалідна дія при побудові -> null', () => {
    expect(buildProposalCallbackData('x', 'id')).toBeNull();
  });

  it('малформат/чужий префікс/без id при розборі -> null', () => {
    expect(parseProposalCallbackData('rm:id')).toBeNull();
    expect(parseProposalCallbackData(`${PROPOSAL_CB_PREFIX}a:`)).toBeNull();
    expect(parseProposalCallbackData(`${PROPOSAL_CB_PREFIX}x:id`)).toBeNull();
    expect(parseProposalCallbackData(null)).toBeNull();
  });
});
