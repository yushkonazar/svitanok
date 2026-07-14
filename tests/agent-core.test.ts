import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as agent from '../web/agent-core.mjs';
// Межа довжини промпту — з реального контракту хоста (той самий репо, окремий деплой).
// @ts-expect-error — JS-модуль хоста без типів.
import { MAX_SYSTEM_PROMPT_LEN } from '../host/llm-host-core.mjs';
const {
  MAX_PROPOSAL_ITEMS,
  ASSISTANT_ACTION_SCHEMA,
  ASSISTANT_FALLBACK_REPLY,
  assistantErrorReply,
  classifyLlmFailure,
  buildAssistantSystemPrompt,
  extractAssistantAction,
  pickAssistantModel,
  sanitizeProposal,
  formatProposalMessage,
  PROPOSAL_CB_PREFIX,
  buildProposalCallbackData,
  parseProposalCallbackData,
} = agent;

// Літо (EEST, UTC+3): 2026-07-10 11:00 Київ.
const SUMMER_NOW = Date.parse('2026-07-10T08:00:00Z');

describe('ASSISTANT_ACTION_SCHEMA', () => {
  it('дозволяє рівно 6 дій (CM3: +cancelReminder)', () => {
    expect(ASSISTANT_ACTION_SCHEMA.properties.action.enum).toEqual([
      'readCalendar',
      'createReminder',
      'cancelReminder',
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

  it('описує readOwnData зі scope-ами; injection-застереження охоплює й історію (CC4/CM)', () => {
    const p = buildAssistantSystemPrompt(SUMMER_NOW);
    expect(p).toContain('readOwnData');
    expect(p).toContain('dataScope');
    expect(p).toContain('Історія розмови'); // ревʼю CM: історія — теж «лише дані»
  });

  it('НЕ перевищує MAX_SYSTEM_PROMPT_LEN хоста в ЖОДЕН день тижня', () => {
    // Регресія: CC1+CC4 роздули промпт до 2555>2000 -> хост давав би
    // system-prompt-too-long на кожен виклик, асистент мовчки падав би у фолбек.
    // weekday:'long' дає різну довжину -> беремо максимум по всіх 7 днях (ревʼю
    // CM: тест раніше міряв лише пʼятницю/зиму й не бачив пікового понеділка).
    const DAY = 86_400_000;
    const base = Date.parse('2026-07-06T09:00:00Z'); // понеділок
    for (let i = 0; i < 7; i++) {
      expect(buildAssistantSystemPrompt(base + i * DAY).length).toBeLessThanOrEqual(
        MAX_SYSTEM_PROMPT_LEN,
      );
    }
  });
});

describe('classifyLlmFailure / assistantErrorReply (A1)', () => {
  // 2026-07-15 21:00 Київ (EEST, UTC+3) — час скидання ліміту.
  const RESET_MS = Date.parse('2026-07-15T18:00:00Z');
  const NOW = RESET_MS - 3 * 3_600_000; // 18:00 Київ

  it('енум usage-limit від нового хоста -> limit + resetAtMs із поля', () => {
    const res = { ok: false, status: 502, error: 'usage-limit', resetAtMs: RESET_MS };
    expect(classifyLlmFailure(res)).toEqual({ kind: 'limit', resetAtMs: RESET_MS });
    expect(assistantErrorReply(res, NOW)).toContain('Ліміти Claude вичерпані');
    expect(assistantErrorReply(res, NOW)).toContain('21:00'); // Київ, не UTC
  });

  it('СИРИЙ текст CLI від СТАРОГО хоста теж упізнається (фікс працює до редеплою)', () => {
    const res = { ok: false, status: 502, error: 'Claude AI usage limit reached|1752620400' };
    const c = classifyLlmFailure(res);
    expect(c.kind).toBe('limit');
    expect(c.resetAtMs).toBe(1752620400_000);
  });

  it('ліміт без часу -> без вигаданої години', () => {
    const res = { ok: false, status: 502, error: "You've hit your weekly limit" };
    expect(classifyLlmFailure(res)).toEqual({ kind: 'limit' });
    const text = assistantErrorReply(res, NOW);
    expect(text).toContain('трохи пізніше');
    expect(text).not.toMatch(/\d{2}:\d{2}/);
  });

  it('час скидання вже минув -> не показуємо його (несвіжа мітка)', () => {
    const res = { ok: false, status: 502, error: 'usage-limit', resetAtMs: RESET_MS };
    expect(assistantErrorReply(res, RESET_MS + 60_000)).toContain('трохи пізніше');
  });

  it('429 хоста -> busy; timeout/offline/невалідна дія -> різні тексти', () => {
    expect(classifyLlmFailure({ ok: false, status: 429, error: 'rate-limited' }).kind).toBe('busy');
    expect(classifyLlmFailure({ ok: false, status: 0, error: 'timeout' }).kind).toBe('timeout');
    expect(classifyLlmFailure({ ok: false, status: 0, error: 'offline' }).kind).toBe('offline');
    expect(classifyLlmFailure({ ok: false, status: 0, error: 'not-configured' }).kind).toBe(
      'offline',
    );
    expect(classifyLlmFailure({ ok: false, status: 502, error: 'overloaded' }).kind).toBe('busy');

    const texts = [
      assistantErrorReply({ ok: false, status: 429, error: 'rate-limited' }, NOW),
      assistantErrorReply({ ok: false, status: 0, error: 'timeout' }, NOW),
      assistantErrorReply({ ok: false, status: 0, error: 'offline' }, NOW),
    ];
    expect(new Set(texts).size).toBe(3); // усі три причини звучать по-різному
  });

  it('успішна відповідь із невалідною дією -> старий фолбек (це не збій інфри)', () => {
    expect(classifyLlmFailure({ ok: true, structured: { action: 'дурня' } }).kind).toBe('unknown');
    expect(assistantErrorReply({ ok: true }, NOW)).toBe(ASSISTANT_FALLBACK_REPLY);
    expect(assistantErrorReply(null, NOW)).toBe(ASSISTANT_FALLBACK_REPLY);
  });

  it('400 хоста (напр. system-prompt-too-long) -> unknown, не «ліміти»', () => {
    // Помилка НАША, не Claude — не брехати користувачу про вичерпані ліміти.
    const res = { ok: false, status: 400, error: 'system-prompt-too-long' };
    expect(classifyLlmFailure(res).kind).toBe('unknown');
    expect(assistantErrorReply(res, NOW)).toBe(ASSISTANT_FALLBACK_REPLY);
  });
});

describe('pickAssistantModel (SL1)', () => {
  it('дефолт haiku для простих запитів (Q&A / нагадування / лукап)', () => {
    expect(pickAssistantModel('яка сьогодні погода?')).toBe('haiku');
    expect(pickAssistantModel('нагадай через 20 хвилин купити хліб')).toBe('haiku');
    expect(pickAssistantModel('скільки в мене вакансій на співбесіді?')).toBe('haiku');
    expect(pickAssistantModel('що завтра в календарі')).toBe('haiku');
    // ревʼю SL: голе «розклад» у простому лукапі має лишатись haiku
    expect(pickAssistantModel('покажи мій розклад на завтра')).toBe('haiku');
    expect(pickAssistantModel('який у мене розклад сьогодні')).toBe('haiku');
    expect(pickAssistantModel('')).toBe('haiku');
    expect(pickAssistantModel(null)).toBe('haiku');
  });

  it('sonnet для планувальних запитів — і імператив, і інфінітив (ревʼю SL)', () => {
    expect(pickAssistantModel('склади план дня')).toBe('sonnet');
    expect(pickAssistantModel('Склади план дня: зустрічі + спортзал')).toBe('sonnet');
    expect(pickAssistantModel('сплануй мені завтрашній день')).toBe('sonnet');
    expect(pickAssistantModel('організуй мій розклад на тиждень')).toBe('sonnet');
    expect(pickAssistantModel('розпиши план підготовки')).toBe('sonnet');
    // інфінітивні форми (раніше падали в haiku)
    expect(pickAssistantModel('допоможи спланувати день')).toBe('sonnet');
    expect(pickAssistantModel('треба розпланувати тиждень')).toBe('sonnet');
    expect(pickAssistantModel('запланувати підготовку до співбесіди')).toBe('sonnet');
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

  it('cancelReminder — потребує непорожній reminderText (опис для збігу, CM3)', () => {
    expect(
      extractAssistantAction({ action: 'cancelReminder', reminderText: ' стоматолог ' }),
    ).toEqual({ action: 'cancelReminder', reminderText: 'стоматолог' });
    expect(extractAssistantAction({ action: 'cancelReminder', reminderText: '' })).toBeNull();
    expect(extractAssistantAction({ action: 'cancelReminder' })).toBeNull();
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
