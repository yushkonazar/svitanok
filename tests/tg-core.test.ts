import { describe, it, expect } from 'vitest';
// розбиває на кілька рядків, тож ts-expect-error завжди на рядку помилки).
import * as tg from '../web/tg-core.mjs';
const {
  textHash,
  verifyWebhookSecret,
  constantTimeEqual,
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
  lastExchangeMessages,
  parseClearCount,
  chunkArray,
  formatClearResult,
  COMMANDS,
  REPLY_KEYBOARD,
  mdToTelegramHtml,
} = tg;

/**
 * Звузити ParsedUpdate до message-гілки.
 *
 * `parseUpdate` віддає РОЗРІЗНЯЛЬНИЙ союз за `kind`, тож `.text`/`.location` є
 * лише в message-варіанті. Тест і так стверджує, що розбір дав саме його —
 * тепер це твердження явне, а не мовчазне припущення.
 */
function asMessage(u: ReturnType<typeof parseUpdate>) {
  if (u.kind !== 'message') throw new Error(`очікувався message, отримано ${u.kind}`);
  return u;
}

describe('tg-core — constantTimeEqual', () => {
  it('рівні рядки -> true; різниця/довжина/тип -> false (без короткого замикання)', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true);
    expect(constantTimeEqual('abc', 'abd')).toBe(false); // остання позиція
    expect(constantTimeEqual('abc', 'Xbc')).toBe(false); // перша позиція — теж false
    expect(constantTimeEqual('abc', 'abcd')).toBe(false); // різна довжина
    expect(constantTimeEqual('', '')).toBe(true); // два порожні — рівні
    expect(constantTimeEqual(undefined, 'x')).toBe(false);
    expect(constantTimeEqual('x', null)).toBe(false);
  });

  it('звірка HMAC-hex (сценарій initData): правильний хеш проходить, підмінений — ні', () => {
    const good = 'a3f'.repeat(21) + 'a'; // 64 hex-символи (SHA-256)
    expect(constantTimeEqual(good, good)).toBe(true);
    expect(constantTimeEqual(good, good.slice(0, 63) + 'b')).toBe(false);
  });
});

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

  it('message -> kind:message + messageId (G1); невідоме -> other', () => {
    expect(
      parseUpdate({
        update_id: 5,
        message: { message_id: 42, from: { id: 9 }, text: 'привіт' },
      }),
    ).toMatchObject({ kind: 'message', text: 'привіт', fromId: 9, messageId: 42 });
    // без message_id -> null (не блокує, просто не трекнемо для /clear)
    expect(
      asMessage(parseUpdate({ update_id: 5, message: { from: { id: 9 }, text: 'x' } })).messageId,
    ).toBeNull();
    expect(parseUpdate({ update_id: 6, edited_message: {} }).kind).toBe('other');
    expect(parseUpdate(null).kind).toBe('other');
  });

  it('message з location (/locate) -> location:{latitude,longitude}; без location -> null', () => {
    const withLoc = asMessage(
      parseUpdate({
        update_id: 7,
        message: {
          message_id: 1,
          from: { id: 9 },
          chat: { id: 9 },
          location: { latitude: 50.62, longitude: 26.24, horizontal_accuracy: 12 },
        },
      }),
    );
    // horizontal_accuracy свідомо НЕ читаємо — лише координати нам треба.
    expect(withLoc.location).toEqual({ latitude: 50.62, longitude: 26.24 });

    expect(
      asMessage(parseUpdate({ update_id: 8, message: { text: 'привіт' } })).location,
    ).toBeNull();
    // биті координати (не число) -> теж null, не NaN у сторі
    expect(
      asMessage(
        parseUpdate({ update_id: 9, message: { location: { latitude: 'x', longitude: 26.24 } } }),
      ).location,
    ).toBeNull();
  });

  it('message з voice (кейс 6) -> {fileId,durationS,fileSize}; без voice -> null', () => {
    const withVoice = asMessage(
      parseUpdate({
        update_id: 10,
        message: {
          message_id: 2,
          from: { id: 9 },
          chat: { id: 9 },
          voice: { file_id: 'AwACAg', duration: 6, mime_type: 'audio/ogg', file_size: 12_345 },
        },
      }),
    );
    expect(withVoice.voice).toEqual({ fileId: 'AwACAg', durationS: 6, fileSize: 12_345 });
    expect(withVoice.text).toBe(''); // голосове без тексту — text лишається ''

    expect(asMessage(parseUpdate({ update_id: 11, message: { text: 'привіт' } })).voice).toBeNull();
    // без file_id розпізнавати нічого — voice:null, а не обʼєкт-каліка
    expect(
      asMessage(parseUpdate({ update_id: 12, message: { voice: { duration: 6 } } })).voice,
    ).toBeNull();
    // відсутні duration/file_size не роблять NaN
    expect(
      asMessage(parseUpdate({ update_id: 13, message: { voice: { file_id: 'F' } } })).voice,
    ).toEqual({ fileId: 'F', durationS: 0, fileSize: null });
  });

  it('isOwner порівнює from.id з дозволеним', () => {
    const p = parseUpdate({ callback_query: { from: { id: 111 }, message: {} } });
    expect(isOwner(p, 111)).toBe(true);
    expect(isOwner(p, '111')).toBe(true);
    expect(isOwner(p, 222)).toBe(false);
    expect(isOwner({ fromId: null }, 111)).toBe(false);
  });

  it('isOwner приймає Set/масив дозволених id (кілька учасників супергрупи)', () => {
    const p = parseUpdate({ callback_query: { from: { id: 222 }, message: {} } });
    expect(isOwner(p, new Set(['111', '222']))).toBe(true);
    expect(isOwner(p, new Set(['111']))).toBe(false);
    expect(isOwner(p, [111, 222])).toBe(true);
    expect(isOwner(p, [111])).toBe(false);
    expect(isOwner(p, new Set())).toBe(false); // порожньо -> fail-closed, не fail-open
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
    expect(resolveCallback(briefing, 'ja', 1).event!.fit).toBeUndefined();
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
    expect(out!.inline_keyboard[0][0].text).toBe('✓ 💾 Зберегти');
    expect(out!.inline_keyboard[0][1].text).toBe('✅ Подав');
    // повторно — без подвійного ✓
    expect(markButtonDone(out!, 'v1:2026-07-09:js:0')!.inline_keyboard[0][0].text!).toBe(
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
    expect(parseCommand('📅 Сьогодні')).toEqual({ cmd: 'agenda', args: '' });
    expect(parseCommand('🧠 План дня')).toEqual({ cmd: 'plan', args: '' });
    expect(parseCommand('⏰ Нагадування')).toEqual({ cmd: 'reminders', args: '' });
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

  it('REPLY_KEYBOARD — дієві команди з негайною відповіддю в чаті, не дублі екранів Mini App', () => {
    const labels = REPLY_KEYBOARD.flat();
    expect(labels).toContain('📅 Сьогодні');
    expect(labels).toContain('⏰ Нагадування');
    expect(parseCommand('📅 Сьогодні')).toEqual({ cmd: 'agenda', args: '' });
    expect(parseCommand('⏰ Нагадування')).toEqual({ cmd: 'reminders', args: '' });
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
    store = recordSentMessage(store, '1', '2', 101, true);
    store = recordSentMessage(store, '1', '3', 999); // інша тема — окремий ключ
    expect(store['1:2']).toEqual([
      { id: 100, own: false },
      { id: 101, own: true },
    ]);
    expect(store['1:3']).toEqual([{ id: 999, own: false }]);
  });

  it('recordSentMessage: капається на 50 (найстаріші відкидаються)', () => {
    let store: Record<string, unknown> = {};
    for (let i = 0; i < 55; i++) store = recordSentMessage(store, '1', null, i);
    const list = store['1:'] as { id: number }[];
    expect(list).toHaveLength(50);
    expect(list[0]?.id).toBe(5); // перші 5 (0..4) зрізано
    expect(list[49]?.id).toBe(54);
  });

  // N у /clear - це ОБМІНИ: запит власника разом з усім, що асистент на нього
  // відповів. Раніше N рахувало рядки чату, тож «/clear 3» зносив два запити
  // й одну відповідь - половину розмови (скарга власника 30.08).
  it('lastExchangeMessages: N обмінів, тригер зверху і поза рахунком', () => {
    let store = {};
    // власник, чернетка, відповідь, власник, відповідь, сама команда
    for (const [id, own] of [
      [10, true],
      [11, false],
      [12, false],
      [13, true],
      [14, false],
      [15, true],
    ] as [number, boolean][]) {
      store = recordSentMessage(store, '1', '2', id, own);
    }
    expect(lastExchangeMessages(store, '1', '2', 1, 15)).toEqual([13, 14, 15]);
    expect(lastExchangeMessages(store, '1', '2', 2, 15)).toEqual([10, 11, 12, 13, 14, 15]);
    // Замовили більше, ніж є - віддаємо все, що знаємо, без винятку.
    expect(lastExchangeMessages(store, '1', '2', 9, 15)).toEqual([10, 11, 12, 13, 14, 15]);
    expect(lastExchangeMessages(store, 'ghost', null, 5, null)).toEqual([]);
    expect(lastExchangeMessages(undefined, '1', '2', 5, null)).toEqual([]);
  });

  it('lastExchangeMessages: старий формат (голі числа) - поведінка як раніше', () => {
    // Перший /clear після деплою бачить буфер без позначок автора: тоді N =
    // останні N повідомлень, як було, а не «нема що чистити».
    const legacy = { '1:2': [10, 11, 12, 13, 14] };
    expect(lastExchangeMessages(legacy, '1', '2', 3, null)).toEqual([12, 13, 14]);
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
  it('formatStatsMessage — базові поля + fit', () => {
    const msg = formatStatsMessage({
      streaks: { openDays: 3, bestOpenDays: 7, mockDays: 1 },
      funnel: { saved: 2, applied: 1, interview: 0, offer: 0 },
      goal: { weeklyApplied: 1, weeklyTarget: 5 },
      avgFitApplied: 82,
    });
    expect(msg).toContain('Стрік відкриттів: 3 дн. (рекорд 7)');
    expect(msg).toContain('<code>[██░░░░░░░░]</code> 1/5 подано'); // прогрес-бар (Фаза B4): 1/5*10=2
    expect(msg).toContain('82%');
  });

  /* ⚠️ Рядок «Слабкі теми» ПРИБРАНО свідомо, і це не втрата. Він брав
     mock.weakTopics — all-time відсоток невдалих ПО mock-темі, без жодного
     гейта на розмір вибірки. Тема, яку питали двічі й обидва рази позначили
     складною, давала 100% і очолювала список — тобто найгучніше місце
     повідомлення діставалось найменш перевіреній темі.

     Заміна — блок «Відмітив, а не дається» нижче: він бере ту саму слабкість,
     але поруч із прогресом роадмепу, і теми без питань до нього не потрапляють
     за побудовою (easePct === null). */
  it('старий рядок «Слабкі теми» більше не показується', () => {
    const msg = formatStatsMessage({
      streaks: { openDays: 3 },
      mock: { weakTopics: [{ name: 'React', value: 100 }] },
    });
    expect(msg).not.toContain('Слабкі теми');
    expect(msg).not.toContain('React');
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
  const NOW = Date.parse('2026-07-15T06:00:00Z'); // 09:00 Київ
  const base = {
    todayKey: '2026-07-15',
    nowMs: NOW,
    lastAutoDate: '2026-07-14',
    lastDispatchMs: NOW - 24 * 3_600_000, // учора
    lastSentDate: '2026-07-14',
  };
  const at = (kyivHour: number, over: Record<string, unknown> = {}) =>
    tg.shouldAutoDispatchBrief({ ...base, kyivHour, ...over });

  it('усередині вікна [8,11) -> так (спроба кожні 5 хв, поки не вийшло)', () => {
    expect(at(8)).toBe(true);
    expect(at(9)).toBe(true);
    expect(at(10)).toBe(true);
  });

  it('вікно закривається о 11:00 — на годину раніше за guard (ревʼю A)', () => {
    // Між dispatch і sendGuard стоять черга Actions + npm ci + install claude CLI.
    // Спроба об 11:xx доїхала б до guard'а вже після 12:00 -> «after window» ->
    // скіп, а мітка вже стоїть -> день БЕЗ брифінгу взагалі.
    expect(at(11)).toBe(false);
    expect(at(12)).toBe(false);
    expect(at(7)).toBe(false);
    expect(at(0)).toBe(false);
    expect(at(23)).toBe(false);
  });

  it('уже успішно диспатчили сьогодні -> ні (жодних холостих Actions-ранів)', () => {
    expect(at(9, { lastAutoDate: '2026-07-15' })).toBe(false);
  });

  it('брифінг уже надіслано сьогодні -> ні', () => {
    expect(at(9, { lastSentDate: '2026-07-15' })).toBe(false);
  });

  it('ручний /brief щойно (< 15 хв) -> ні; за 20 хв -> знову можна (ревʼю A)', () => {
    // /brief не ставить денну мітку (може бути й поза вікном), тож від дубля
    // рятує саме проміжок. Але ретрай зберігається: якщо той ран впав, авто-
    // спроба повернеться за 15 хв, а не «завтра».
    expect(at(9, { lastDispatchMs: NOW - 5 * 60_000 })).toBe(false);
    expect(at(9, { lastDispatchMs: NOW - 14 * 60_000 })).toBe(false);
    expect(at(9, { lastDispatchMs: NOW - 20 * 60_000 })).toBe(true);
  });

  it('перший запуск (міток немає) -> так', () => {
    expect(
      tg.shouldAutoDispatchBrief({
        kyivHour: 8,
        todayKey: '2026-07-15',
        nowMs: NOW,
        lastAutoDate: undefined,
        lastDispatchMs: undefined,
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

describe('formatWhereAmI — режим приватності (діагностика мовчання)', () => {
  it('приватність увімкнена -> кажемо, що все залежить від прав адміна', () => {
    // НЕ лякаємо: can_read_all_group_messages відбиває лише налаштування
    // приватності, а бот-адмін отримує все й з увімкненою. Попередження
    // «текст не доходить» брехало б адмін-ботам.
    const out = formatWhereAmI(-100123, null, { can_read_all_group_messages: false });
    expect(out).toContain('лише якщо я адмін');
    expect(out).toContain('/setprivacy');
  });

  it('приватність вимкнена -> підтвердження, що текст доходить', () => {
    const out = formatWhereAmI(-100123, 7, { can_read_all_group_messages: true });
    expect(out).toContain('вільний текст доходить');
  });

  it('getMe недоступний -> рядка про приватність просто немає (не падаємо)', () => {
    for (const me of [null, undefined, {}, { can_read_all_group_messages: 'ні' }]) {
      const out = formatWhereAmI(-100123, null, me);
      expect(out).toContain('chat_id');
      expect(out).not.toContain('Приватність');
    }
  });

  it('зворотна сумісність: без додаткових аргументів працює як раніше', () => {
    const out = formatWhereAmI(-100123, null);
    expect(out).toContain('chat_id');
    expect(out).toContain('thread_id');
    expect(out).not.toContain('Тема асистента');
  });
});

describe('formatWhereAmI — тема асистента (чому вільний текст мовчить)', () => {
  it('поточна тема = тема асистента -> кажемо, що тут працює', () => {
    const out = formatWhereAmI(-100123, 6, null, '6');
    expect(out).toContain('це вона, вільний текст тут працює');
  });

  it('інша тема -> прямо кажемо, що тут вільний текст НЕ піде', () => {
    // Саме цей випадок неможливо було відрізнити від «бот зламався».
    const out = formatWhereAmI(-100123, 6, null, '9');
    expect(out).toContain('НЕ піде до асистента');
  });

  it('TOPIC_ASSISTANT не заданий -> явна вказівка на це', () => {
    const out = formatWhereAmI(-100123, 6, null, null);
    expect(out).toContain('TOPIC_ASSISTANT не заданий');
  });

  it('чат без тем -> вільний текст працює', () => {
    const out = formatWhereAmI(-100123, null, null, '6');
    expect(out).toContain('вільний текст тут працює');
  });
});

/* Асистент пише Markdown — так навчена будь-яка LLM. А `reply` йшов у Telegram
 * БЕЗ parse_mode, тобто голим текстом: власник бачив дослівні `**жирний**` і
 * рядки `---` (скрін 12.08.2026).
 *
 * Просто ввімкнути parse_mode не можна: у відповідь потрапляє текст ІЗ ЛИСТІВ
 * (теми, відправники — сторонній контент). Один `<` чи `&` у листі зламав би
 * парсинг, а то й підсунув свої теги. Тому порядок жорсткий: СПЕРШУ екранування
 * всього, і лише ПОТІМ наші власні теги — тож у виводі не може виявитись тега,
 * якого ми туди не поставили. */
describe('mdToTelegramHtml — Markdown моделі -> HTML Telegram', () => {
  it('жирний і курсив', () => {
    expect(mdToTelegramHtml('**Завтра** — це *важливо*')).toBe('<b>Завтра</b> — це <i>важливо</i>');
    expect(mdToTelegramHtml('__теж жирний__ і _теж курсив_')).toBe(
      '<b>теж жирний</b> і <i>теж курсив</i>',
    );
  });

  it('заголовки стають жирним, горизонтальні лінії зникають', () => {
    expect(mdToTelegramHtml('## Листи\ntext')).toBe('<b>Листи</b>\ntext');
    expect(mdToTelegramHtml('а\n---\nб')).toBe('а\n\nб');
  });

  it('списки стають буллетами', () => {
    expect(mdToTelegramHtml('- перший\n- другий')).toBe('• перший\n• другий');
  });

  it('⚠️ сторонній текст екранується ДО того, як зʼявляються наші теги', () => {
    // Тема листа може містити будь-що — це чужий текст у нашому повідомленні.
    expect(mdToTelegramHtml('Тема: <b>клік</b> & <script>alert(1)</script>')).toBe(
      'Тема: &lt;b&gt;клік&lt;/b&gt; &amp; &lt;script&gt;alert(1)&lt;/script&gt;',
    );
    // ...і навіть у поєднанні з розміткою теги лишаються лише НАШІ.
    expect(mdToTelegramHtml('**<i>x</i>**')).toBe('<b>&lt;i&gt;x&lt;/i&gt;</b>');
  });

  it('вміст `code` не переінтерпретується як розмітка', () => {
    expect(mdToTelegramHtml('візьми `**не жирне**`')).toBe('візьми <code>**не жирне**</code>');
  });

  it('непарні маркери лишаються текстом — вивід завжди валідний HTML', () => {
    // Якби ми конвертували непарну зірочку, Telegram віддав би 400 і
    // повідомлення просто зникло б.
    expect(mdToTelegramHtml('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(mdToTelegramHtml('**незакритий')).toBe('**незакритий');
  });

  it('порожнє/не рядок -> порожній рядок', () => {
    expect(mdToTelegramHtml('')).toBe('');
    expect(mdToTelegramHtml(undefined)).toBe('');
  });
});

describe('mdToTelegramHtml — плейсхолдер коду не чіпає звичайного тексту', () => {
  it('числа в тексті лишаються числами (регрес плейсхолдера)', () => {
    // Пробільний маркер (` 1 `) підставив би сюди codes[15] -> undefined.
    expect(mdToTelegramHtml('зустріч о 15 годині')).toBe('зустріч о 15 годині');
    expect(mdToTelegramHtml('`код` і о 0 годині')).toBe('<code>код</code> і о 0 годині');
  });

  it('літеральний «<C0>» у тексті моделі не стає кодом', () => {
    // Після escapeHtml це вже &lt;C0&gt;, тож підміна його не бачить.
    expect(mdToTelegramHtml('<C0>')).toBe('&lt;C0&gt;');
  });
});

/* /stats у чаті — редизайн після дизайн-проходу по дашборду.
 *
 * ⚠️ ПРИВІД. Дашборд за прохід навчився відповідати на «що потребує уваги»
 * (вакансії без руху, розрив «відмітив ↔ дається», швидкість кроків), а бот
 * лишився знімком лічильників — стрік, ціль, воронка. Тобто найдієвіше з
 * нового було доступне ЛИШЕ якщо відкрити Mini App.
 *
 * Різниця ролей при цьому реальна: дашборд ГОРТАЮТЬ, повідомлення в чаті
 * ПРОБІГАЮТЬ очима. Тому сюди йде не все, а лише те, з чого можна щось
 * зробити просто зараз, і кожен блок зʼявляється, лише коли має вміст. */
describe('tg-core — formatStatsMessage після проходу по статистиці', () => {
  const base = {
    streaks: { openDays: 3, bestOpenDays: 7, mockDays: 1 },
    funnel: { saved: 2, applied: 1, interview: 0, offer: 0 },
    goal: { weeklyApplied: 1, weeklyTarget: 5 },
  };

  it('вакансії без руху — окремим блоком зі стадією й днями', () => {
    const msg = formatStatsMessage({
      ...base,
      funnelSpeed: {
        steps: [],
        staleAfterDays: 21,
        stale: [
          { url: 'https://x/1', stage: 'applied', title: 'Frontend — Aurora', days: 34 },
          { url: 'https://x/2', stage: 'saved', title: 'React — Northwind', days: 27 },
        ],
      },
    });
    expect(msg).toContain('Frontend — Aurora');
    expect(msg).toContain('34 дн.');
    expect(msg).toContain('подано');
  });

  it('список без руху обрізається — у чаті це зведення, а не архів', () => {
    const stale = Array.from({ length: 9 }, (_, i) => ({
      url: `https://x/${i}`,
      stage: 'saved',
      title: `Вакансія ${i}`,
      days: 30 + i,
    }));
    const msg = formatStatsMessage({
      ...base,
      funnelSpeed: { steps: [], stale, staleAfterDays: 21 },
    });
    expect(msg).toContain('Вакансія 0');
    expect(msg).not.toContain('Вакансія 8');
    expect(msg).toMatch(/ще \d+/);
  });

  it('нічого не лежить -> блоку немає взагалі, а не «0 вакансій»', () => {
    const msg = formatStatsMessage({
      ...base,
      funnelSpeed: { steps: [], stale: [], staleAfterDays: 21 },
    });
    expect(msg).not.toContain('без руху');
  });

  it('крок із медіаною показується, крок без неї — мовчить', () => {
    const msg = formatStatsMessage({
      ...base,
      funnelSpeed: {
        stale: [],
        staleAfterDays: 21,
        steps: [
          { from: 'saved', to: 'applied', n: 9, medianDays: 3 },
          { from: 'applied', to: 'interview', n: 1, medianDays: null },
        ],
      },
    });
    expect(msg).toContain('3 дн.');
    // Крок без медіани у чат не йде: «замало переходів» — це шум у зведенні.
    expect(msg).not.toContain('співбесіда:');
  });

  it('розрив «відмітив ↔ дається» — лише помітний, з обома числами', () => {
    const msg = formatStatsMessage({
      ...base,
      mastery: {
        topics: [
          { id: 'a', title: '📡 HTTP', done: 4, total: 5, seen: 11, weak: 8, easePct: 27 },
          { id: 'b', title: '🌐 Frontend', done: 7, total: 7, seen: 22, weak: 3, easePct: 86 },
        ],
      },
    });
    expect(msg).toContain('📡 HTTP');
    expect(msg).toContain('80%');
    expect(msg).toContain('27%');
    // Рівна тема (100 проти 86) — не розрив, у чат не йде.
    expect(msg).not.toContain('Frontend');
  });

  it('тема без питань НЕ потрапляє в розрив (нуль тут не оцінка)', () => {
    const msg = formatStatsMessage({
      ...base,
      mastery: {
        topics: [
          { id: 'a', title: '🧪 Тестування', done: 5, total: 5, seen: 0, weak: 0, easePct: null },
        ],
      },
    });
    expect(msg).not.toContain('Тестування');
  });

  it('відмінок співбесід живий: 2 — «співбесіди», 5 — «співбесід»', () => {
    const two = formatStatsMessage({ ...base, funnel: { ...base.funnel, interview: 2 } });
    const five = formatStatsMessage({ ...base, funnel: { ...base.funnel, interview: 5 } });
    expect(two).toContain('2 співбесіди');
    expect(five).toContain('5 співбесід');
  });

  it('усе порожнє -> повідомлення все одно валідне', () => {
    expect(() => formatStatsMessage({})).not.toThrow();
    expect(formatStatsMessage({})).toContain('Статистика');
  });

  it('назви вакансій і тем екрануються', () => {
    const msg = formatStatsMessage({
      ...base,
      funnelSpeed: {
        steps: [],
        staleAfterDays: 21,
        stale: [{ url: 'https://x/1', stage: 'saved', title: '<script>x</script>', days: 30 }],
      },
    });
    expect(msg).toContain('&lt;script&gt;');
    expect(msg).not.toContain('<script>');
  });
});
