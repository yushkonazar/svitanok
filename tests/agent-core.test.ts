import { describe, it, expect } from 'vitest';
import { USAGE_LIMIT_TEXTS, NON_LIMIT_TEXTS } from './usage-limit-fixtures.js';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as agent from '../web/agent-core.mjs';
// Межі довжини — з реального контракту хоста (той самий репо, окремий деплой).
// @ts-expect-error — JS-модуль хоста без типів.
import { MAX_SYSTEM_PROMPT_LEN, MAX_PROMPT_LEN } from '../host/llm-host-core.mjs';
const {
  MAX_PROPOSAL_ITEMS,
  ASSISTANT_ACTION_SCHEMA,
  ASSISTANT_FALLBACK_REPLY,
  MAX_TRANSCRIPT_LEN,
  assistantErrorReply,
  classifyLlmFailure,
  clipTranscript,
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
  it('дозволяє рівно 9 дій (CRUD: +updateReminder)', () => {
    expect(ASSISTANT_ACTION_SCHEMA.properties.action.enum).toEqual([
      'readCalendar',
      'createReminder',
      'cancelReminder',
      'updateReminder',
      'proposeCalendarChanges',
      'reply',
      'readOwnData',
      'readMail',
      'readMailBody',
    ]);
  });

  it('proposal.items.kind охоплює create ТА мутацію ІСНУЮЧОЇ події (updateEvent/deleteEvent)', () => {
    expect(ASSISTANT_ACTION_SCHEMA.properties.proposal.items.properties.kind.enum).toEqual([
      'event',
      'reminder',
      'updateEvent',
      'deleteEvent',
    ]);
    expect(ASSISTANT_ACTION_SCHEMA.properties.proposal.items.properties.eventId).toBeTruthy();
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
    expect(p).toContain('лише за прямим проханням');
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

describe('readMail + бюджет транскрипту (B3/B4)', () => {
  it('extractAssistantAction приймає readMail; порожній запит валідний', () => {
    expect(extractAssistantAction({ action: 'readMail', mailQuery: 'kontramarka' })).toEqual({
      action: 'readMail',
      mailQuery: 'kontramarka',
    });
    // Дефолт (свіжий inbox) підставить sanitizeMailQuery — не відкидаємо дію.
    expect(extractAssistantAction({ action: 'readMail' })).toEqual({
      action: 'readMail',
      mailQuery: '',
    });
  });

  it('системний промпт описує пошту й позначає листи як ЛИШЕ ДАНІ', () => {
    const p = buildAssistantSystemPrompt(SUMMER_NOW);
    expect(p).toContain('readMail');
    expect(p).toContain('ЛИСТИ'); // anti-injection застереження охоплює пошту
    expect(p).toContain('ПРОДОВЖЕННЯ РОЗМОВИ'); // B2: відповідь на уточнення — не новий запит
  });

  /* ── readMailBody: повне тіло ОДНОГО листа (дозвіл власника 18.07.2026) ──
     mailId іде в ШЛЯХ URL Gmail API, а обирає його модель, яка щойно читала
     листи від сторонніх людей. Тому валідація сувора: усе, що не схоже на
     справжній id Gmail, відкидається ще до мережі. */
  it('extractAssistantAction приймає лише коректний id листа', () => {
    expect(extractAssistantAction({ action: 'readMailBody', mailId: '18f2ab-cd_9' })).toEqual({
      action: 'readMailBody',
      mailId: '18f2ab-cd_9',
    });
    expect(extractAssistantAction({ action: 'readMailBody', mailId: '  18f2ab  ' })).toEqual({
      action: 'readMailBody',
      mailId: '18f2ab',
    });
  });

  it('відкидає id зі слешами, крапками, запитом і кирилицею (path traversal / підміна URL)', () => {
    for (const mailId of [
      '',
      '   ',
      '../../users/me/settings',
      'abc/def',
      'abc?alt=media',
      'abc#frag',
      'abc.def',
      'лист',
      'a'.repeat(129),
    ]) {
      expect(extractAssistantAction({ action: 'readMailBody', mailId })).toBeNull();
    }
    expect(extractAssistantAction({ action: 'readMailBody' })).toBeNull();
  });

  it('системний промпт пояснює, коли брати повне тіло', () => {
    const p = buildAssistantSystemPrompt(SUMMER_NOW);
    expect(p).toContain('readMailBody');
  });

  it('clipTranscript тримає промпт ПІД лімітом хоста (інакше 400 і мовчазний фолбек)', () => {
    expect(MAX_TRANSCRIPT_LEN).toBeLessThan(MAX_PROMPT_LEN);
    const huge = 'я'.repeat(MAX_PROMPT_LEN * 2);
    const out = clipTranscript(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_LEN);
    expect(out).toContain('обрізано'); // модель бачить, що дані неповні
    expect(clipTranscript('коротко')).toBe('коротко'); // короткий — без змін
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

  it('скидання НЕ сьогодні -> показуємо й дату (ревʼю A)', () => {
    // Тижневий ліміт із голим «09:00» читався б як «за годину», а чекати 4 дні.
    const inFourDays = Date.parse('2026-07-19T06:00:00Z'); // 09:00 Київ, неділя
    const res = { ok: false, status: 502, error: 'usage-limit', resetAtMs: inFourDays };
    const text = assistantErrorReply(res, NOW); // NOW = 15.07
    expect(text).toContain('19.07');
    expect(text).toContain('09:00');
  });

  it('паритет зі спільним фікстур-набором (web vs host vs src)', () => {
    for (const t of USAGE_LIMIT_TEXTS) {
      expect(classifyLlmFailure({ ok: false, status: 502, error: t }).kind, t).toBe('limit');
    }
    for (const t of NON_LIMIT_TEXTS) {
      expect(classifyLlmFailure({ ok: false, status: 502, error: t }).kind, t).not.toBe('limit');
    }
  });
});

/* Евристику pickAssistantModel (haiku за замовчуванням, sonnet лише на
   планувальних запитах) прибрано разом із переходом на хост: ланцюжки стали
   багатокроковими, а на довгому ланцюжку слабша модель губить нитку — «економія»
   оберталась провалом усього запиту. Рішення власника 18.07.2026 — завжди sonnet. */
describe('ASSISTANT_MODEL', () => {
  it('агент завжди на sonnet', () => {
    expect(agent.ASSISTANT_MODEL).toBe('sonnet');
  });

  it('модель — рядок-alias CLI, а не повний id (хост віддає його як --model)', () => {
    expect(agent.ASSISTANT_MODEL).toMatch(/^[a-z0-9-]{1,40}$/i);
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

  describe('updateReminder — текстовий пошук (як cancelReminder) + патч', () => {
    it('приймає reminderNewText+when разом', () => {
      expect(
        extractAssistantAction({
          action: 'updateReminder',
          reminderText: ' стоматолог ',
          reminderNewText: ' стоматолог, узяти картку ',
          when: 'завтра о 10:00',
        }),
      ).toEqual({
        action: 'updateReminder',
        reminderText: 'стоматолог',
        reminderNewText: 'стоматолог, узяти картку',
        when: 'завтра о 10:00',
      });
    });

    it('приймає ЛИШЕ when (переніс, без зміни тексту)', () => {
      expect(
        extractAssistantAction({
          action: 'updateReminder',
          reminderText: 'стоматолог',
          when: 'о 18:00',
        }),
      ).toEqual({
        action: 'updateReminder',
        reminderText: 'стоматолог',
        reminderNewText: undefined,
        when: 'о 18:00',
      });
    });

    it('приймає ЛИШЕ reminderNewText (перейменування, без зміни часу)', () => {
      expect(
        extractAssistantAction({
          action: 'updateReminder',
          reminderText: 'стоматолог',
          reminderNewText: 'дантист',
        }),
      ).toEqual({
        action: 'updateReminder',
        reminderText: 'стоматолог',
        reminderNewText: 'дантист',
        when: undefined,
      });
    });

    it('без reminderText -> null (нема що шукати)', () => {
      expect(extractAssistantAction({ action: 'updateReminder', reminderNewText: 'x' })).toBeNull();
    });

    it('без reminderNewText І without when -> null (патч нічого не змінює)', () => {
      expect(
        extractAssistantAction({ action: 'updateReminder', reminderText: 'стоматолог' }),
      ).toBeNull();
    });
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

  describe('updateEvent/deleteEvent — мутація ІСНУЮЧОЇ події за eventId', () => {
    it('deleteEvent: лише валідний eventId потрібен', () => {
      const { items, droppedCount } = sanitizeProposal(
        [{ kind: 'deleteEvent', eventId: 'abcDEF123_-' }],
        SUMMER_NOW,
      );
      expect(droppedCount).toBe(0);
      expect(items).toEqual([{ kind: 'deleteEvent', eventId: 'abcDEF123_-' }]);
    });

    it('deleteEvent: невалідний/відсутній eventId -> дропається', () => {
      for (const eventId of [undefined, '', '../etc/passwd', 'a'.repeat(129)]) {
        expect(sanitizeProposal([{ kind: 'deleteEvent', eventId }], SUMMER_NOW)).toEqual({
          items: [],
          droppedCount: 1,
        });
      }
    });

    it('updateEvent: часткові поля (лише when) -> в item лише whenMs, БЕЗ title/durationMin', () => {
      const { items } = sanitizeProposal(
        [{ kind: 'updateEvent', eventId: 'ev1', when: 'завтра о 16:00' }],
        SUMMER_NOW,
      );
      expect(items).toHaveLength(1);
      expect(items[0].eventId).toBe('ev1');
      expect(typeof items[0].whenMs).toBe('number');
      expect(items[0].title).toBeUndefined();
      expect(items[0].durationMin).toBeUndefined();
    });

    it('updateEvent: лише title (перейменування без зміни часу)', () => {
      const { items } = sanitizeProposal(
        [{ kind: 'updateEvent', eventId: 'ev1', title: 'Дантист' }],
        SUMMER_NOW,
      );
      expect(items[0]).toEqual({ kind: 'updateEvent', eventId: 'ev1', title: 'Дантист' });
    });

    it('updateEvent: усі поля разом', () => {
      const { items } = sanitizeProposal(
        [
          {
            kind: 'updateEvent',
            eventId: 'ev1',
            title: 'Дантист',
            when: 'завтра о 16:00',
            durationMin: 45,
          },
        ],
        SUMMER_NOW,
      );
      expect(items[0]).toMatchObject({
        kind: 'updateEvent',
        eventId: 'ev1',
        title: 'Дантист',
        durationMin: 45,
      });
      expect(typeof items[0].whenMs).toBe('number');
    });

    it('updateEvent: жодного патч-поля -> дропається (нічого не змінює)', () => {
      expect(sanitizeProposal([{ kind: 'updateEvent', eventId: 'ev1' }], SUMMER_NOW)).toEqual({
        items: [],
        droppedCount: 1,
      });
    });

    it('updateEvent: невалідний eventId -> дропається, навіть якщо решта валідна', () => {
      expect(
        sanitizeProposal([{ kind: 'updateEvent', eventId: '', title: 'X' }], SUMMER_NOW),
      ).toEqual({ items: [], droppedCount: 1 });
    });
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

  it('updateEvent: показує лише ЗМІНЕНІ поля (було -> стане), не чіпані — мовчать', () => {
    const base = { title: 'Стендап', whenMs: SUMMER_NOW, durationMin: 60 };
    // лише час змінено -> лише один рядок діфу
    const onlyTime = formatProposalMessage([
      { kind: 'updateEvent', eventId: 'ev1', whenMs: SUMMER_NOW + 3_600_000, base },
    ]);
    expect(onlyTime).toContain('✏️');
    expect(onlyTime).not.toContain('Стендап» → «Стендап»'); // title не в диффі, хоч і в base

    // нічого не змінено (лише shiftMin=0, editable поля відсутні) -> «без змін»
    const noChange = formatProposalMessage([{ kind: 'updateEvent', eventId: 'ev1', base }]);
    expect(noChange).toContain('без змін');
  });

  it('deleteEvent: показує назву й час із base (не голий id)', () => {
    const msg = formatProposalMessage([
      { kind: 'deleteEvent', eventId: 'ev1', base: { title: 'Стендап', whenMs: SUMMER_NOW } },
    ]);
    expect(msg).toContain('🗑');
    expect(msg).toContain('Стендап');
    expect(msg).not.toContain('ev1'); // id не показуємо власнику
  });

  it('deleteEvent без base (захисно) -> фолбек на eventId, не падає', () => {
    expect(() => formatProposalMessage([{ kind: 'deleteEvent', eventId: 'ev1' }])).not.toThrow();
  });

  it('warnings (extra a): рядок ⚠️ під пунктом з накладкою; без запису — тиша', () => {
    const items = [
      { kind: 'event', title: 'Обід', whenMs: SUMMER_NOW },
      { kind: 'event', title: 'Кава', whenMs: SUMMER_NOW },
    ];
    const warnings = new Map([[0, ['Стендап 15:00']]]);
    const msg = formatProposalMessage(items, warnings);
    expect(msg).toContain('⚠️ накладається на «Стендап 15:00»');
    // РІВНО одне попередження (лише для «Обід» — «Кава» без запису у warnings)
    expect(msg.match(/⚠️/g)).toHaveLength(1);
  });

  it('без warnings (undefined, старі виклики) -> поведінка не змінена', () => {
    const msg = formatProposalMessage([{ kind: 'event', title: 'X', whenMs: SUMMER_NOW }]);
    expect(msg).not.toContain('⚠️');
  });
});

describe('proposal callback_data', () => {
  it('build+parse round-trip для a/c/d/l/s/o', () => {
    for (const action of ['a', 'c', 'd', 'l', 's', 'o']) {
      expect(parseProposalCallbackData(buildProposalCallbackData(action, 'ab12cd34'))).toEqual({
        action,
        id: 'ab12cd34',
      });
    }
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

describe('proposalMode + edit/delete-клавіатура', () => {
  const { proposalMode, cycleEventShift, formatShiftLabel, buildProposalKeyboard } = agent;

  it('одна updateEvent -> edit; одна deleteEvent -> delete; решта -> create', () => {
    expect(proposalMode([{ kind: 'updateEvent', eventId: 'x' }])).toBe('edit');
    expect(proposalMode([{ kind: 'deleteEvent', eventId: 'x' }])).toBe('delete');
    expect(proposalMode([{ kind: 'event', title: 'x' }])).toBe('create');
    expect(proposalMode([{ kind: 'reminder', title: 'x' }])).toBe('create');
    expect(proposalMode([])).toBe('create');
    // >1 пункт ніколи не edit/delete (ті стейджаться ОДНИМ пунктом за конструкцією)
    expect(
      proposalMode([
        { kind: 'updateEvent', eventId: 'x' },
        { kind: 'event', title: 'y' },
      ]),
    ).toBe('create');
  });

  it('edit-клавіатура: цикл зсуву + «✏️ Інше» + Підтвердити/Скасувати, БЕЗ циклера тривалості/lead', () => {
    const kb = buildProposalKeyboard(
      'id123456',
      [{ kind: 'updateEvent', eventId: 'ev1', shiftMin: 0 }],
      {},
    );
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b: { text: string }) => b.text.includes('як заплановано'))).toBe(true);
    expect(flat.some((b: { text: string }) => b.text.includes('Інше'))).toBe(true);
    expect(flat.some((b: { text: string }) => b.text.includes('Підтвердити'))).toBe(true);
    expect(flat.some((b: { text: string }) => b.text.includes('⏳'))).toBe(false); // без тривалості
    expect(flat.some((b: { text: string }) => b.text.includes('⏰'))).toBe(false); // без lead
  });

  it('delete-клавіатура: лише Так/Ні, нічого циклити', () => {
    const kb = buildProposalKeyboard('id123456', [{ kind: 'deleteEvent', eventId: 'ev1' }], {});
    expect(kb.inline_keyboard).toHaveLength(1);
    const [row] = kb.inline_keyboard;
    expect(row.map((b: { text: string }) => b.text)).toEqual(['✅ Так, видалити', '❌ Ні']);
  });

  it('зсув циклиться по колу, включно з «завтра, той самий час»', () => {
    expect(cycleEventShift(0)).toBe(15);
    expect(cycleEventShift(-30)).toBe(1440);
    expect(cycleEventShift(1440)).toBe(0); // замикання кола
    expect(cycleEventShift(undefined)).toBe(15);
  });

  it('підписи зсуву людські', () => {
    expect(formatShiftLabel(0)).toBe('як заплановано');
    expect(formatShiftLabel(15)).toBe('+15 хв');
    expect(formatShiftLabel(-30)).toBe('-30 хв');
    expect(formatShiftLabel(60)).toBe('+1 год');
    expect(formatShiftLabel(1440)).toBe('завтра, той самий час');
  });
});

describe('фолбеки асистента — три РІЗНІ збої, три різні тексти', () => {
  const { ASSISTANT_ROUNDS_REPLY, ASSISTANT_EMPTY_REPLY } = agent;
  // Доти всі три давали ідентичний «🤔 Не зміг розібратись до кінця»:
  // вичерпані раунди, порожній replyText і немапована відповідь хоста.
  // Через це скрін власника не казав нічого — саме тому баг і не діагностувався.
  it('тексти не збігаються між собою', () => {
    const all = [ASSISTANT_FALLBACK_REPLY, ASSISTANT_ROUNDS_REPLY, ASSISTANT_EMPTY_REPLY];
    expect(new Set(all).size).toBe(3);
  });

  it('«вичерпані раунди» підказує, як переформулювати', () => {
    expect(ASSISTANT_ROUNDS_REPLY).toContain('конкретніше');
  });

  it('хост відповів, але модель віддала дурню -> загальний фолбек', () => {
    // Саме цей випадок лишається за ASSISTANT_FALLBACK_REPLY: ok:true, але
    // extractAssistantAction не дістав валідної дії (kind:'unknown').
    expect(assistantErrorReply({ ok: true, structured: { action: 'вигадана' } })).toBe(
      ASSISTANT_FALLBACK_REPLY,
    );
    expect(assistantErrorReply(null)).toBe(ASSISTANT_FALLBACK_REPLY);
  });

  it('відомі причини НЕ падають у загальний фолбек', () => {
    const known = [
      { ok: false, status: 502, error: 'usage limit reached' },
      { ok: false, status: 429, error: 'rate-limit' },
      { ok: false, status: 0, error: 'timeout' },
      { ok: false, status: 0, error: 'offline' },
    ];
    for (const r of known) {
      expect(assistantErrorReply(r)).not.toBe(ASSISTANT_FALLBACK_REPLY);
    }
  });
});

describe('тексти станів агента', () => {
  const {
    ASSISTANT_ROUNDS_REPLY,
    ASSISTANT_EMPTY_REPLY,
    ASSISTANT_WORKING_REPLY,
    ASSISTANT_STALLED_REPLY,
  } = agent;

  /* Кожен збій мусить мати СВІЙ текст: доти три різні причини («вичерпані
     раунди», порожній replyText, немапована відповідь хоста) давали один рядок,
     і «асистент не працює» неможливо було задіагностувати ні власнику, ні по
     скріну. ASSISTANT_TIME_REPLY (18-секундний бюджет) прибрано разом із самим
     бюджетом: після переходу на хост час більше не обмежує, а обрив ловить
     сторож і каже про це своїм текстом. */
  it('усі тексти станів різні', () => {
    const all = [
      ASSISTANT_FALLBACK_REPLY,
      ASSISTANT_ROUNDS_REPLY,
      ASSISTANT_EMPTY_REPLY,
      ASSISTANT_WORKING_REPLY,
      ASSISTANT_STALLED_REPLY,
    ];
    expect(new Set(all).size).toBe(5);
  });

  it('«працюю» коротке — воно висить у чаті, поки йде ланцюжок', () => {
    expect(ASSISTANT_WORKING_REPLY.length).toBeLessThan(40);
  });

  it('текст обірваного прогону підказує ДІЮ, а не лише констатує', () => {
    expect(ASSISTANT_STALLED_REPLY).toContain('Спробуй ще раз');
  });
});

describe('assistantStepLabel — проміжний прогрес', () => {
  const { assistantStepLabel } = agent;

  it('кожна ЧИТАЛЬНА дія має свій підпис', () => {
    expect(assistantStepLabel('readMail')).toContain('пошт');
    expect(assistantStepLabel('readMailBody')).toContain('лист');
    expect(assistantStepLabel('readCalendar')).toContain('календар');
    expect(assistantStepLabel('readOwnData')).toContain('дані');
  });

  it('підписи читальних дій різні (щоб було видно, що крок змінився)', () => {
    const labels = ['readMail', 'readMailBody', 'readCalendar', 'readOwnData'].map(
      assistantStepLabel,
    );
    expect(new Set(labels).size).toBe(4);
  });

  it('термінальні/невідомі дії -> null (їхнє «⏳» прибирають, а не переписують)', () => {
    for (const a of ['reply', 'createReminder', 'proposeCalendarChanges', 'вигадана', '', null]) {
      expect(assistantStepLabel(a)).toBeNull();
    }
  });
});

describe('health-check хоста — класифікація й переходи', () => {
  const { classifyHostProbe, hostHealthTransition, HOST_DESYNC_ALERT, HOST_RECOVERED_ALERT } =
    agent;

  it('404 = розсинхрон (старий хост без /agent)', () => {
    expect(classifyHostProbe({ reached: true, status: 404 })).toBe('desync');
  });

  it('будь-який інший HTTP-код = маршрут є = ok', () => {
    for (const status of [400, 202, 429, 401, 503, 500]) {
      expect(classifyHostProbe({ reached: true, status })).toBe('ok');
    }
  });

  it('недосяжний хост (мережа/таймаут) = unknown, НЕ ok і НЕ desync', () => {
    expect(classifyHostProbe({ reached: false, status: 0 })).toBe('unknown');
    expect(classifyHostProbe(null)).toBe('unknown');
  });

  it('алерт лише на ЗМІНІ в розсинхрон (ok -> desync)', () => {
    expect(hostHealthTransition('ok', 'desync')).toEqual({ next: 'desync', alert: 'warn' });
  });

  it('повторний desync мовчить (уже алармували)', () => {
    expect(hostHealthTransition('desync', 'desync')).toEqual({ next: 'desync', alert: null });
  });

  it('відновлення (desync -> ok) шле «в нормі»', () => {
    expect(hostHealthTransition('desync', 'ok')).toEqual({ next: 'ok', alert: 'clear' });
  });

  it('норма мовчить (ok -> ok)', () => {
    expect(hostHealthTransition('ok', 'ok')).toEqual({ next: 'ok', alert: null });
  });

  it('unknown НЕ міняє стану й нічого не шле (флапаючий VPS не спамить)', () => {
    expect(hostHealthTransition('ok', 'unknown')).toEqual({ next: 'ok', alert: null });
    expect(hostHealthTransition('desync', 'unknown')).toEqual({ next: 'desync', alert: null });
  });

  it('тексти алертів різні й підказують ДІЮ (онови хост)', () => {
    expect(HOST_DESYNC_ALERT).not.toBe(HOST_RECOVERED_ALERT);
    expect(HOST_DESYNC_ALERT).toContain('404');
    expect(HOST_DESYNC_ALERT).toMatch(/systemctl|scp|host\//);
  });
});

describe('доналаштування пропозиції — циклери тривалості/lead', () => {
  const {
    cycleProposalDuration,
    cycleProposalLead,
    formatDurationLabel,
    formatLeadLabel,
    proposalHasEvent,
    buildProposalKeyboard,
  } = agent;

  it('parse/build приймають нові дії d і l', () => {
    for (const a of ['a', 'c', 'd', 'l']) {
      const data = buildProposalCallbackData(a, 'id123456');
      expect(data).toBe(`pd:${a}:id123456`);
      expect(parseProposalCallbackData(data)).toEqual({ action: a, id: 'id123456' });
    }
    expect(buildProposalCallbackData('x', 'id')).toBeNull();
    expect(parseProposalCallbackData('pd:x:id')).toBeNull();
  });

  it('тривалість циклиться по колу, null(«як є») -> 30 -> ... -> назад', () => {
    expect(cycleProposalDuration(null)).toBe(30);
    expect(cycleProposalDuration(30)).toBe(60);
    expect(cycleProposalDuration(180)).toBe(null); // замикання кола
    expect(cycleProposalDuration(undefined)).toBe(30); // невідоме -> перший крок
  });

  it('lead циклиться по колу null -> 10 -> ... -> день -> назад', () => {
    expect(cycleProposalLead(null)).toBe(10);
    expect(cycleProposalLead(60)).toBe(1440);
    expect(cycleProposalLead(1440)).toBe(null);
  });

  it('підписи тривалості людські (хв/год, півтори)', () => {
    expect(formatDurationLabel(null)).toBe('як є');
    expect(formatDurationLabel(30)).toBe('30 хв');
    expect(formatDurationLabel(60)).toBe('1 год');
    expect(formatDurationLabel(90)).toBe('1.5 год');
  });

  it('підписи lead людські («за замовч.»/«за 30 хв»/«за день»)', () => {
    expect(formatLeadLabel(null)).toBe('за замовч.');
    expect(formatLeadLabel(30)).toBe('за 30 хв');
    expect(formatLeadLabel(60)).toBe('за 1 год');
    expect(formatLeadLabel(1440)).toBe('за день');
  });

  it('клавіатура: рядок циклерів ТІЛЬКИ коли є подія; ✅/❌ завжди', () => {
    const withEvent = buildProposalKeyboard('id123456', [{ kind: 'event' }], {
      durMin: 60,
      leadMin: 30,
    });
    expect(withEvent.inline_keyboard).toHaveLength(2); // циклери + accept/cancel
    expect(withEvent.inline_keyboard[0][0].text).toContain('1 год');
    expect(withEvent.inline_keyboard[0][1].text).toContain('за 30 хв');
    expect(withEvent.inline_keyboard[0][0].callback_data).toBe('pd:d:id123456');

    const reminderOnly = buildProposalKeyboard('id123456', [{ kind: 'reminder' }], {});
    expect(reminderOnly.inline_keyboard).toHaveLength(1); // лише accept/cancel, без циклерів
    expect(reminderOnly.inline_keyboard[0][0].text).toContain('Прийняти');
  });

  it('proposalHasEvent: подія -> true, лише нагадування -> false', () => {
    expect(proposalHasEvent([{ kind: 'reminder' }, { kind: 'event' }])).toBe(true);
    expect(proposalHasEvent([{ kind: 'reminder' }])).toBe(false);
    expect(proposalHasEvent([])).toBe(false);
  });
});

describe('formatProposalResult — перепис повідомлення ПІСЛЯ accept', () => {
  const { formatProposalResult } = agent;

  it('create: ✅/⚠️ на пункт, той самий порядок', () => {
    const items = [
      { kind: 'event', title: 'Обід', whenMs: SUMMER_NOW },
      { kind: 'reminder', title: 'Квитки', whenMs: SUMMER_NOW },
    ];
    const text = formatProposalResult(items, [{ ok: true, id: 'g1' }, { ok: false }]);
    expect(text).toContain('1. ✅ 📅 Обід');
    expect(text).toContain('2. ⚠️ не вдалось: Квитки');
  });

  it('edit: успіх -> «Оновлено» з фінальними title/whenMs', () => {
    const items = [
      {
        kind: 'updateEvent',
        eventId: 'ev1',
        whenMs: SUMMER_NOW + 3_600_000,
        base: { title: 'Стендап', whenMs: SUMMER_NOW },
      },
    ];
    const text = formatProposalResult(items, [{ ok: true }]);
    expect(text).toContain('✅ Оновлено');
    expect(text).toContain('Стендап'); // title не мінявся -> з base
  });

  it('edit: провал -> чесний текст, без «Оновлено»', () => {
    const items = [{ kind: 'updateEvent', eventId: 'ev1', base: { title: 'Стендап' } }];
    expect(formatProposalResult(items, [{ ok: false }])).toContain('Не вдалось оновити');
  });

  it('delete: успіх -> «Видалено» з назвою з base', () => {
    const items = [
      { kind: 'deleteEvent', eventId: 'ev1', base: { title: 'Стендап', whenMs: SUMMER_NOW } },
    ];
    expect(formatProposalResult(items, [{ ok: true }])).toBe('🗑 Видалено: «Стендап»');
  });

  it('delete: провал -> чесний текст', () => {
    const items = [{ kind: 'deleteEvent', eventId: 'ev1' }];
    expect(formatProposalResult(items, [{ ok: false }])).toContain('Не вдалось видалити');
  });

  it('назви екрановані (XSS-регресія)', () => {
    const items = [{ kind: 'event', title: '<b>x</b>', whenMs: SUMMER_NOW }];
    const text = formatProposalResult(items, [{ ok: true }]);
    expect(text).not.toContain('<b>x</b>');
    expect(text).toContain('&lt;b&gt;');
  });
});

describe('formatEventEditQuestion — гібрид «✏️ Інше», маркер id для продовження розмови', () => {
  const { formatEventEditQuestion } = agent;

  it('historyText має [id:...] НА ПОЧАТКУ (clipTurn обрізає хвіст)', () => {
    const { historyText } = formatEventEditQuestion('ev12345', 'Стендап', SUMMER_NOW);
    expect(historyText.startsWith('[id:ev12345]')).toBe(true);
  });

  it('displayText (шлеться власнику) БЕЗ маркера id', () => {
    const { displayText } = formatEventEditQuestion('ev12345', 'Стендап', SUMMER_NOW);
    expect(displayText).not.toContain('ev12345');
    expect(displayText).not.toContain('[id:');
    expect(displayText).toContain('Стендап');
  });

  it('historyText = маркер + displayText (не дублює формулювання)', () => {
    const { historyText, displayText } = formatEventEditQuestion('ev1', 'X', SUMMER_NOW);
    expect(historyText).toBe(`[id:ev1] ${displayText}`);
  });
});
