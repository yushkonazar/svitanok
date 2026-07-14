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
  progressBar,
  sentMessagesKey,
  recordSentMessage,
  lastSentMessages,
  parseClearCount,
  chunkArray,
  formatClearResult,
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

  it('REPLY_KEYBOARD містить Налаштування+Роадмеп (Фаза B2, компенсація видаленої теми «Команди»)', () => {
    const labels = REPLY_KEYBOARD.flat();
    expect(labels).toContain('⚙️ Налаштування');
    expect(labels).toContain('🗺 Роадмеп');
    expect(parseCommand('⚙️ Налаштування')).toEqual({ cmd: 'settings', args: '' });
    expect(parseCommand('🗺 Роадмеп')).toEqual({ cmd: 'roadmap', args: '' });
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

describe('tg-core — progressBar (Фаза B4, обгортка [..]+<code> — фікс «хатчованої плями»)', () => {
  it('пропорція заповнення, фіксована ширина 10, у <code>[...]</code>', () => {
    expect(progressBar(0, 10)).toBe('<code>[░░░░░░░░░░]</code>');
    expect(progressBar(5, 10)).toBe('<code>[█████░░░░░]</code>');
    expect(progressBar(10, 10)).toBe('<code>[██████████]</code>');
  });

  it('округлення до найближчого символу', () => {
    expect(progressBar(1, 3)).toBe('<code>[███░░░░░░░]</code>'); // 1/3*10=3.33 -> round 3
    expect(progressBar(2, 3)).toBe('<code>[███████░░░]</code>'); // 2/3*10=6.67 -> round 7
  });

  it('done>total не переповнює бар (clamp)', () => {
    expect(progressBar(15, 10)).toBe('<code>[██████████]</code>');
  });

  it('total<=0 -> порожній рядок (немає сенсу малювати без знаменника)', () => {
    expect(progressBar(0, 0)).toBe('');
    expect(progressBar(5, -1)).toBe('');
  });

  it('нестандартна ширина', () => {
    expect(progressBar(2, 4, 4)).toBe('<code>[██░░]</code>');
  });
});

describe('tg-core — sentMessages ring buffer (§C5: /clear)', () => {
  it('sentMessagesKey: чат+тема окремо; null/undefined thread -> той самий ключ', () => {
    expect(sentMessagesKey('1', '2')).toBe('1:2');
    expect(sentMessagesKey('1', null)).toBe('1:');
    expect(sentMessagesKey('1', undefined)).toBe('1:');
    expect(sentMessagesKey('1', '2')).not.toBe(sentMessagesKey('1', '3'));
  });

  it('recordSentMessage: додає в правильний ключ, не чіпає інші чат/теми', () => {
    let store = recordSentMessage({}, '1', '2', 100);
    store = recordSentMessage(store, '1', '2', 101);
    store = recordSentMessage(store, '1', '3', 999); // інша тема — окремий ключ
    expect(store['1:2']).toEqual([100, 101]);
    expect(store['1:3']).toEqual([999]);
  });

  it('recordSentMessage: капається на 50 (найстаріші відкидаються)', () => {
    let store: Record<string, number[]> = {};
    for (let i = 0; i < 55; i++) store = recordSentMessage(store, '1', null, i);
    expect(store['1:']).toHaveLength(50);
    expect(store['1:']?.[0]).toBe(5); // перші 5 (0..4) зрізано
    expect(store['1:']?.[49]).toBe(54);
  });

  it('lastSentMessages: останні N (найновіші останні); відсутній ключ -> []', () => {
    const store = { '1:2': [10, 11, 12, 13, 14] };
    expect(lastSentMessages(store, '1', '2', 3)).toEqual([12, 13, 14]);
    expect(lastSentMessages(store, '1', '2', 100)).toEqual([10, 11, 12, 13, 14]);
    expect(lastSentMessages(store, 'ghost', null, 5)).toEqual([]);
    expect(lastSentMessages(undefined, '1', '2', 5)).toEqual([]);
  });

  it('parseClearCount: валідне число клампується [1,maxN]; невалідне -> default', () => {
    expect(parseClearCount('5')).toBe(5);
    expect(parseClearCount('999')).toBe(40); // clamp до maxN=40 (запас перед лімітом subrequests)
    expect(parseClearCount('0')).toBe(20); // <=0 -> default
    expect(parseClearCount('-3')).toBe(20);
    expect(parseClearCount('')).toBe(20);
    expect(parseClearCount('щось')).toBe(20);
    expect(parseClearCount(undefined)).toBe(20);
    expect(parseClearCount('7', 10, 15)).toBe(7); // нестандартні default/max
    expect(parseClearCount('20', 10, 15)).toBe(15); // clamp до кастомного maxN
  });

  it('formatClearResult: 0 спроб -> "нема що очищати"; частковий успіх -> X із Y', () => {
    expect(formatClearResult(0, 0)).toContain('Нема що очищати');
    expect(formatClearResult(5, 5)).toContain('Видалено 5 із 5');
    expect(formatClearResult(3, 10)).toContain('Видалено 3 із 10'); // старіші за 48г не видалились
  });

  it('chunkArray: розбиває на шматки заданого розміру, останній коротший', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([1, 2, 3, 4], 2)).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('chunkArray: size >= length -> один шматок; порожній масив -> []', () => {
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
    expect(chunkArray([], 10)).toEqual([]);
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
    expect(msg).toContain('<code>[██░░░░░░░░]</code> 1/5 подано'); // прогрес-бар (Фаза B4): 1/5*10=2
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

  it('formatSavedMessage — news з url -> клікабельне посилання (Фаза C2); без url -> плейн', () => {
    const msg = formatSavedMessage([
      { kind: 'news', title: 'Стартап підняв $2М', url: 'https://x.example/a?q=1&b=2' },
      { kind: 'fact', title: 'Без URL' },
    ]);
    expect(msg).toContain('🗞 <a href="https://x.example/a?q=1&amp;b=2">Стартап підняв $2М</a>');
    expect(msg).toContain('🧠 Без URL');
  });

  it('formatSavedMessage — url і title екрануються ОКРЕМО (лапка в url не ламає href)', () => {
    const msg = formatSavedMessage([
      { kind: 'news', title: '<script>x</script>', url: 'https://x/"onmouseover="evil()' },
    ]);
    expect(msg).toContain('&quot;onmouseover=&quot;evil()');
    expect(msg).toContain('&lt;script&gt;x&lt;/script&gt;');
    expect(msg).not.toContain('<script>');
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

  it('botUsername заданий -> Direct Link Mini App, навіть з групи (initData зберігається)', () => {
    expect(
      buildMiniAppButton('📊 Відкрити Mini App', 'https://x/app', -1001234567890, 'svitanok_bot'),
    ).toEqual({ text: '📊 Відкрити Mini App', url: 'https://t.me/svitanok_bot?startapp' });
  });

  it('botUsername з "@" -> обрізається', () => {
    expect(
      buildMiniAppButton('📊 Відкрити Mini App', 'https://x/app', null, '@svitanok_bot'),
    ).toEqual({ text: '📊 Відкрити Mini App', url: 'https://t.me/svitanok_bot?startapp' });
  });
});

describe('briefCooldownRemainingMs (SL2)', () => {
  const HOUR = 60 * 60_000;
  it('перший запуск (немає/некоректний lastMs) -> 0 (дозволено)', () => {
    expect(tg.briefCooldownRemainingMs(undefined, 1_000_000, HOUR)).toBe(0);
    expect(tg.briefCooldownRemainingMs(0, 1_000_000, HOUR)).toBe(0);
    expect(tg.briefCooldownRemainingMs(-5, 1_000_000, HOUR)).toBe(0);
    expect(tg.briefCooldownRemainingMs('nope', 1_000_000, HOUR)).toBe(0);
  });
  it('у межах кулдауну -> лишок мс; після -> 0', () => {
    const last = 1_000_000;
    expect(tg.briefCooldownRemainingMs(last, last + 10 * 60_000, HOUR)).toBe(50 * 60_000); // 10хв минуло
    expect(tg.briefCooldownRemainingMs(last, last + HOUR, HOUR)).toBe(0); // рівно година
    expect(tg.briefCooldownRemainingMs(last, last + 2 * HOUR, HOUR)).toBe(0); // давно
  });
});

describe('shouldAutoDispatchBrief (A2)', () => {
  const base = {
    todayKey: '2026-07-15',
    lastAutoDispatchDate: '2026-07-14',
    lastSentDate: '2026-07-14',
  };
  const at = (kyivHour: number, over: Record<string, unknown> = {}) =>
    tg.shouldAutoDispatchBrief({ ...base, kyivHour, ...over });

  it('усередині вікна [8,12) -> так (кожні 5 хв, поки не вийшло)', () => {
    expect(at(8)).toBe(true);
    expect(at(9)).toBe(true);
    expect(at(11)).toBe(true);
  });

  it('поза вікном -> ні (оркестратор однаково скіпнув би — sendGuard)', () => {
    expect(at(7)).toBe(false);
    expect(at(12)).toBe(false); // верхня межа НЕвключна
    expect(at(0)).toBe(false);
    expect(at(23)).toBe(false);
  });

  it('уже диспатчили сьогодні -> ні (жодних холостих Actions-ранів)', () => {
    expect(at(9, { lastAutoDispatchDate: '2026-07-15' })).toBe(false);
  });

  it('брифінг уже надіслано сьогодні (напр. ручний /brief) -> ні', () => {
    expect(at(9, { lastSentDate: '2026-07-15' })).toBe(false);
  });

  it('перший запуск (міток немає) -> так', () => {
    expect(
      tg.shouldAutoDispatchBrief({
        kyivHour: 8,
        todayKey: '2026-07-15',
        lastAutoDispatchDate: undefined,
        lastSentDate: undefined,
      }),
    ).toBe(true);
  });

  it('невалідні вхідні -> ні (fail-closed, не спамимо dispatch)', () => {
    expect(at(NaN)).toBe(false);
    expect(tg.shouldAutoDispatchBrief({ kyivHour: 9, todayKey: null })).toBe(false);
    expect(tg.shouldAutoDispatchBrief({})).toBe(false);
  });
});
