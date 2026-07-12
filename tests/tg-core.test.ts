import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт: prettier не
// розбиває на кілька рядків, тож ts-expect-error завжди на рядку помилки).
import * as tg from '../web/tg-core.mjs';
const {
  textHash,
  verifyWebhookSecret,
  parseUpdate,
  isOwner,
  isDuplicate,
  buildCallbackData,
  parseCallbackData,
  resolveCallback,
  markButtonDone,
  parseCommand,
  formatStatsMessage,
  formatJobsMessage,
  formatSavedMessage,
  formatWhereAmI,
  buildMiniAppButton,
  COMMANDS,
  REPLY_KEYBOARD,
} = tg;

describe('tg-core — verifyWebhookSecret', () => {
  it('точний збіг -> true; будь-яка відмінність/довжина/тип -> false', () => {
    expect(verifyWebhookSecret('s3cr3t', 's3cr3t')).toBe(true);
    expect(verifyWebhookSecret('s3cr3t', 's3cr3T')).toBe(false);
    expect(verifyWebhookSecret('short', 'longer-secret')).toBe(false);
    expect(verifyWebhookSecret('', '')).toBe(false); // порожній секрет — не автентифікуємо
    expect(verifyWebhookSecret(undefined, 'x')).toBe(false);
  });
});

describe('tg-core — parseUpdate / isOwner / isDuplicate', () => {
  it('callback_query -> kind:callback з ключовими полями', () => {
    const p = parseUpdate({
      update_id: 42,
      callback_query: {
        id: 'cb1',
        from: { id: 111 },
        data: 'v1:2026-07-09:ja:0',
        message: { message_id: 7, chat: { id: 111 }, message_thread_id: 3, reply_markup: { x: 1 } },
      },
    });
    expect(p).toMatchObject({
      kind: 'callback',
      updateId: 42,
      callbackId: 'cb1',
      fromId: 111,
      messageId: 7,
      threadId: 3,
      data: 'v1:2026-07-09:ja:0',
    });
  });

  it('message -> kind:message; невідоме -> other', () => {
    expect(
      parseUpdate({ update_id: 5, message: { from: { id: 9 }, text: 'привіт' } }),
    ).toMatchObject({ kind: 'message', text: 'привіт', fromId: 9 });
    expect(parseUpdate({ update_id: 6, edited_message: {} }).kind).toBe('other');
    expect(parseUpdate(null).kind).toBe('other');
  });

  it('isOwner порівнює from.id з дозволеним', () => {
    const p = parseUpdate({ callback_query: { from: { id: 111 }, message: {} } });
    expect(isOwner(p, 111)).toBe(true);
    expect(isOwner(p, '111')).toBe(true);
    expect(isOwner(p, 222)).toBe(false);
    expect(isOwner({ fromId: null }, 111)).toBe(false);
  });

  it('isDuplicate: <= lastUpdateId; без id не дедупить', () => {
    expect(isDuplicate(10, 10)).toBe(true);
    expect(isDuplicate(10, 9)).toBe(true);
    expect(isDuplicate(10, 11)).toBe(false);
    expect(isDuplicate(undefined, 5)).toBe(false);
    expect(isDuplicate(10, null)).toBe(false);
  });
});

describe('tg-core — callback_data кодування', () => {
  it('build+parse round-trip з idx і без', () => {
    expect(parseCallbackData(buildCallbackData('2026-07-09', 'ja:0'))).toEqual({
      v: 'v1',
      dateKey: '2026-07-09',
      code: 'ja',
      idx: 0,
    });
    expect(parseCallbackData(buildCallbackData('2026-07-09', 'sf'))).toEqual({
      v: 'v1',
      dateKey: '2026-07-09',
      code: 'sf',
      idx: null,
    });
  });

  it('малформат/чужа версія/крива дата -> null', () => {
    expect(parseCallbackData('нема')).toBeNull();
    expect(parseCallbackData('v2:2026-07-09:ja:0')).toBeNull();
    expect(parseCallbackData('v1:09-07-2026:ja:0')).toBeNull();
    expect(parseCallbackData('v1:2026-07-09:ja:xx')).toBeNull();
  });

  it('build дотримує 64-байтовий ліміт (кирилиця=2 байти)', () => {
    expect(buildCallbackData('2026-07-09', 'ja:0')).toBe('v1:2026-07-09:ja:0');
    expect(buildCallbackData('2026-07-09', 'я'.repeat(40))).toBeNull(); // > 64 байт
  });
});

const briefing = {
  blocks: [
    {
      id: 'jobs',
      data: {
        items: [
          { url: 'https://x/job1', title: 'Junior FS', score: 88 },
          { url: 'https://x/job2', title: 'Trainee', score: -1 },
        ],
      },
    },
    { id: 'fact', data: { fact: 'Медузи безсмертні.' } },
    { id: 'stoic', data: { text: 'Дій', author: 'Марк Аврелій' } },
  ],
};

describe('tg-core — resolveCallback', () => {
  it('js -> job_stage saved; ja -> applied + fit (score>=0)', () => {
    expect(resolveCallback(briefing, 'js', 0).event).toEqual({
      type: 'job_stage',
      url: 'https://x/job1',
      title: 'Junior FS',
      stage: 'saved',
    });
    expect(resolveCallback(briefing, 'ja', 0).event).toEqual({
      type: 'job_stage',
      url: 'https://x/job1',
      title: 'Junior FS',
      stage: 'applied',
      fit: 88,
    });
    // score -1 (без скорингу) -> без fit
    expect(resolveCallback(briefing, 'ja', 1).event.fit).toBeUndefined();
  });

  it('sf/sq -> save_item з id=textHash(того самого рядка, що й дашборд)', () => {
    const f = resolveCallback(briefing, 'sf').event;
    expect(f).toEqual({
      type: 'save_item',
      kind: 'fact',
      id: textHash('Медузи безсмертні.'),
      title: 'Медузи безсмертні.',
    });
    const q = resolveCallback(briefing, 'sq').event;
    const quoteTitle = '«Дій» — Марк Аврелій';
    expect(q).toEqual({
      type: 'save_item',
      kind: 'quote',
      id: textHash(quoteTitle),
      title: quoteTitle,
    });
  });

  it('застарілий індекс/відсутній блок -> error:stale; невідомий код -> error:unknown', () => {
    expect(resolveCallback(briefing, 'js', 9).error).toBe('stale');
    expect(resolveCallback({ blocks: [] }, 'sf').error).toBe('stale');
    expect(resolveCallback(briefing, 'zz').error).toBe('unknown');
  });
});

describe('tg-core — markButtonDone', () => {
  it('додає ✓ лише натиснутій кнопці; ідемпотентно', () => {
    const rm = {
      inline_keyboard: [
        [
          { text: '💾 Зберегти', callback_data: 'v1:2026-07-09:js:0' },
          { text: '✅ Подав', callback_data: 'v1:2026-07-09:ja:0' },
        ],
      ],
    };
    const out = markButtonDone(rm, 'v1:2026-07-09:js:0');
    expect(out.inline_keyboard[0][0].text).toBe('✓ 💾 Зберегти');
    expect(out.inline_keyboard[0][1].text).toBe('✅ Подав');
    // повторно — без подвійного ✓
    expect(markButtonDone(out, 'v1:2026-07-09:js:0').inline_keyboard[0][0].text).toBe(
      '✓ 💾 Зберегти',
    );
  });
});

describe('tg-core — parseCommand (Блок P4)', () => {
  it('slash-команда, з опційним "@botname" та аргументами', () => {
    expect(parseCommand('/stats')).toEqual({ cmd: 'stats', args: '' });
    expect(parseCommand('/stats@svitanok_bot')).toEqual({ cmd: 'stats', args: '' });
    expect(parseCommand('/plan  завтра о 10')).toEqual({ cmd: 'plan', args: 'завтра о 10' });
    expect(parseCommand('/STATS')).toEqual({ cmd: 'stats', args: '' }); // регістр-нечутливо
  });

  it('лейбл reply-keyboard мапиться на ту саму команду, що й "/xxx"', () => {
    expect(parseCommand('📋 Статистика')).toEqual({ cmd: 'stats', args: '' });
    expect(parseCommand('💼 Вакансії')).toEqual({ cmd: 'jobs', args: '' });
    expect(parseCommand('🔖 Збережене')).toEqual({ cmd: 'save', args: '' });
    expect(parseCommand('🔄 Брифінг')).toEqual({ cmd: 'brief', args: '' });
  });

  it('звичайний текст/порожнє/не-рядок -> null (майбутній асистент, P2)', () => {
    expect(parseCommand('привіт, як справи?')).toBeNull();
    expect(parseCommand('')).toBeNull();
    expect(parseCommand('   ')).toBeNull();
    expect(parseCommand('/')).toBeNull();
    expect(parseCommand(undefined)).toBeNull();
  });

  it('COMMANDS/REPLY_KEYBOARD — узгоджені реєстри (немає дублів, валідні імена)', () => {
    const names = COMMANDS.map((c: { command: string }) => c.command);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z0-9_]{1,32}$/);
    expect(REPLY_KEYBOARD.flat().length).toBeGreaterThan(0);
  });

  it('кожен лейбл REPLY_KEYBOARD резолвиться в команду з COMMANDS (без дрейфу двох реєстрів)', () => {
    const known = new Set(COMMANDS.map((c: { command: string }) => c.command));
    for (const label of REPLY_KEYBOARD.flat() as string[]) {
      const parsed = parseCommand(label);
      expect(parsed, `лейбл "${label}" не мапиться на команду`).not.toBeNull();
      expect(known.has(parsed!.cmd), `"${label}" -> "${parsed!.cmd}" немає в COMMANDS`).toBe(true);
    }
  });
});

describe('tg-core — formatStatsMessage/formatJobsMessage/formatSavedMessage (Блок P4)', () => {
  it('formatStatsMessage — базові поля + слабкі теми (лише value>0) + fit', () => {
    const msg = formatStatsMessage({
      streaks: { openDays: 3, bestOpenDays: 7, mockDays: 1 },
      funnel: { saved: 2, applied: 1, interview: 0, offer: 0 },
      goal: { weeklyApplied: 1, weeklyTarget: 5 },
      avgFitApplied: 82,
      mock: {
        weakTopics: [
          { name: 'React', value: 40 },
          { name: 'Дате', value: 0 },
        ],
      },
    });
    expect(msg).toContain('Стрік відкриттів: 3 дн. (рекорд 7)');
    expect(msg).toContain('1/5 подано');
    expect(msg).toContain('82%');
    expect(msg).toContain('React');
    expect(msg).not.toContain('Дате'); // value:0 відфільтровано
  });

  it('formatStatsMessage — порожній стор не падає (дефолти)', () => {
    expect(() => formatStatsMessage({})).not.toThrow();
    expect(formatStatsMessage({})).toContain('Статистика');
  });

  it('formatJobsMessage — групує за стадією; порожньо -> заглушка', () => {
    const msg = formatJobsMessage([
      { url: 'https://x/1', stage: 'applied', title: 'Junior FS' },
      { url: 'https://x/2', stage: 'saved', title: '<script>x</script>' },
    ]);
    expect(msg.indexOf('💾 Збережено')).toBeLessThan(msg.indexOf('✅ Подано'));
    expect(msg).toContain('&lt;script&gt;'); // екранування динамічного title
    expect(formatJobsMessage([])).toContain('порожньо');
  });

  it('formatSavedMessage — іконка за kind; порожньо -> заглушка', () => {
    const msg = formatSavedMessage([
      { kind: 'fact', title: 'Медузи безсмертні' },
      { kind: 'quote', title: 'Дій' },
    ]);
    expect(msg).toContain('🧠 Медузи безсмертні');
    expect(msg).toContain('🏛 Дій');
    expect(formatSavedMessage([])).toContain('Поки нічого');
  });
});

describe('tg-core — formatWhereAmI (Блок «Теми»)', () => {
  it('показує chat_id і thread_id, коли задані', () => {
    const msg = formatWhereAmI(-1001234567890, 42);
    expect(msg).toContain('-1001234567890');
    expect(msg).toContain('42');
  });

  it('DM (без теми форуму) -> thread_id "немає"', () => {
    const msg = formatWhereAmI(123456, null);
    expect(msg).toContain('123456');
    expect(msg).toContain('немає');
  });

  it('екранує потенційно небезпечний вміст (захисно, хоч chat/thread id завжди числа)', () => {
    const msg = formatWhereAmI('<script>x</script>', null);
    expect(msg).toContain('&lt;script&gt;');
  });
});

describe('tg-core — buildMiniAppButton (дзеркало src/core/telegram.ts, §H1 хотфікс)', () => {
  it("групова chatId (від'ємна) -> url, не web_app (BUTTON_TYPE_INVALID у групах)", () => {
    expect(buildMiniAppButton('📊 Відкрити Mini App', 'https://x/app', -1001234567890)).toEqual({
      text: '📊 Відкрити Mini App',
      url: 'https://x/app',
    });
  });

  it('приватний чат (додатний chatId) -> web_app', () => {
    expect(buildMiniAppButton('📊 Відкрити Mini App', 'https://x/app', 123456)).toEqual({
      text: '📊 Відкрити Mini App',
      web_app: { url: 'https://x/app' },
    });
  });

  it('chatId не передано -> web_app (за замовчуванням, приватний)', () => {
    expect(buildMiniAppButton('📊 Відкрити Mini App', 'https://x/app')).toEqual({
      text: '📊 Відкрити Mini App',
      web_app: { url: 'https://x/app' },
    });
  });
});
