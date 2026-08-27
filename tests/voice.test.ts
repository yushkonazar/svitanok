// Голос (етап 2 PR-4, ADR-040): transcribeVoice - getFile → завантаження →
// Deepgram nova-3 → квота deepgram_min; збій Deepgram → Whisper-резерв з
// позначкою; misconfig ≠ збій (без ключа - чесна відмова, не тихий резерв).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  transcribeVoice,
  savePendingVoice,
  takePendingVoice,
  VOICE_MAX_FILE_BYTES,
  VOICE_TRANSCRIPT_MAX_CHARS,
  VOICE_PENDING_TTL_MS,
} from '../web/core/voice.mjs';
import { prerouteMessage, handleBrainCallback } from '../web/core/prerouter.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const AUDIO = new Uint8Array([1, 2, 3, 4, 5]).buffer;

type FetchLog = { url: string; init?: RequestInit };

/** Стаб fetch: getFile + файл + Deepgram. Кожен крок можна зламати окремо. */
function makeFetchStub(opts: {
  getFileStatus?: number;
  fileStatus?: number;
  fileBytes?: ArrayBuffer;
  deepgramStatus?: number;
  deepgramTranscript?: string | null;
}) {
  const calls: FetchLog[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes('api.telegram.org') && u.endsWith('/getFile')) {
        return new Response(
          JSON.stringify({ ok: true, result: { file_path: 'voice/file_7.oga' } }),
          { status: opts.getFileStatus ?? 200 },
        );
      }
      if (u.includes('api.telegram.org/file/')) {
        return new Response(opts.fileBytes ?? AUDIO, { status: opts.fileStatus ?? 200 });
      }
      if (u.includes('api.deepgram.com')) {
        const transcript = opts.deepgramTranscript;
        const body =
          transcript === null
            ? {}
            : { results: { channels: [{ alternatives: [{ transcript: transcript ?? '' }] }] } };
        return new Response(JSON.stringify(body), { status: opts.deepgramStatus ?? 200 });
      }
      throw new Error(`несподіваний fetch: ${u}`);
    }),
  );
  return calls;
}

function makeAiStub(text: string | undefined = 'резервний текст') {
  return { run: vi.fn(async () => ({ text })) };
}

function makeEnv(over: Record<string, unknown> = {}) {
  const d1 = d1FromSqlite(['0003_telemetry.sql', '0009_voice.sql']);
  const env = workerEnv({
    DEEPGRAM_API_KEY: 'dg-key',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    DB: d1.stub,
    ...over,
  });
  return { env, db: d1.db };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('transcribeVoice: щасливий шлях', () => {
  it('Deepgram віддає текст → ok, fallback:false, квота deepgram_min за тривалістю', async () => {
    const calls = makeFetchStub({ deepgramTranscript: 'запиши чек-ін: сон сім годин' });
    const { env, db } = makeEnv();

    const res = await transcribeVoice(env, { fileId: 'F1', durationS: 90 }, NOW);
    expect(res).toEqual({ ok: true, text: 'запиши чек-ін: сон сім годин', fallback: false });

    // Deepgram: сирі байти тілом, ключ у Token-заголовку, model/language в URL.
    const dg = calls.find((c) => c.url.includes('api.deepgram.com'))!;
    expect(dg.url).toContain('model=nova-3');
    expect(dg.url).toContain('language=uk');
    expect((dg.init?.headers as Record<string, string>).Authorization).toBe('Token dg-key');

    const row = db
      .prepare(`SELECT value, limit_value FROM quota_counters WHERE key = 'deepgram_min'`)
      .get() as { value: number; limit_value: number };
    expect(row.value).toBeCloseTo(1.5); // 90 с = 1.5 хв
    expect(row.limit_value).toBe(46_500);
  });

  it('порожній транскрипт → ok з text:"" (S-6-2), але хвилини пораховані', async () => {
    makeFetchStub({ deepgramTranscript: '' });
    const { env, db } = makeEnv();

    const res = await transcribeVoice(env, { fileId: 'F1', durationS: 20 }, NOW);
    expect(res).toEqual({ ok: true, text: '', fallback: false });
    const row = db.prepare(`SELECT value FROM quota_counters WHERE key = 'deepgram_min'`).get() as {
      value: number;
    };
    expect(row.value).toBeCloseTo(20 / 60);
  });

  it('транскрипт понад стелю ріжеться по код-поїнтах з «…»', async () => {
    makeFetchStub({ deepgramTranscript: '🙂'.repeat(VOICE_TRANSCRIPT_MAX_CHARS) });
    const { env } = makeEnv();
    const res = await transcribeVoice(env, { fileId: 'F1', durationS: 60 }, NOW);
    if (!res.ok) throw new Error('очікувався ok');
    expect([...res.text].length).toBe(VOICE_TRANSCRIPT_MAX_CHARS);
    expect(res.text.endsWith('…')).toBe(true);
    expect(res.text.includes('�')).toBe(false);
  });
});

describe('transcribeVoice: резерв і відмови', () => {
  it('Deepgram 5xx → Whisper-резерв (fallback:true, base64-аудіо), без deepgram_min', async () => {
    makeFetchStub({ deepgramStatus: 503 });
    const ai = makeAiStub('нагадай про зустріч');
    const { env, db } = makeEnv({ AI: ai });

    const res = await transcribeVoice(env, { fileId: 'F1', durationS: 30 }, NOW);
    expect(res).toEqual({ ok: true, text: 'нагадай про зустріч', fallback: true });
    expect(ai.run).toHaveBeenCalledWith(expect.stringContaining('whisper'), {
      audio: btoa(String.fromCharCode(...new Uint8Array(AUDIO))),
    });
    const row = db.prepare(`SELECT value FROM quota_counters WHERE key = 'deepgram_min'`).get();
    expect(row).toBeUndefined();
  });

  it('Deepgram без transcript у тілі → теж резерв', async () => {
    makeFetchStub({ deepgramTranscript: null });
    const ai = makeAiStub();
    const { env } = makeEnv({ AI: ai });
    const res = await transcribeVoice(env, { fileId: 'F1', durationS: 10 }, NOW);
    expect(res).toEqual({ ok: true, text: 'резервний текст', fallback: true });
  });

  it('Deepgram упав і AI-привʼязки немає → failed (чесна відмова)', async () => {
    makeFetchStub({ deepgramStatus: 500 });
    const { env } = makeEnv();
    expect(await transcribeVoice(env, { fileId: 'F1', durationS: 10 }, NOW)).toEqual({
      ok: false,
      error: 'failed',
    });
  });

  it('без DEEPGRAM_API_KEY → misconfigured, жодного fetch (не тихий резерв)', async () => {
    const calls = makeFetchStub({});
    const { env } = makeEnv({ DEEPGRAM_API_KEY: undefined, AI: makeAiStub() });
    expect(await transcribeVoice(env, { fileId: 'F1', durationS: 10 }, NOW)).toEqual({
      ok: false,
      error: 'misconfigured',
    });
    expect(calls).toHaveLength(0);
  });

  it('getFile упав → failed; заявлений розмір понад 20 МБ → too-big без завантаження', async () => {
    const calls = makeFetchStub({ getFileStatus: 500 });
    const { env } = makeEnv();
    expect(await transcribeVoice(env, { fileId: 'F1', durationS: 10 }, NOW)).toEqual({
      ok: false,
      error: 'failed',
    });

    expect(
      await transcribeVoice(
        env,
        { fileId: 'F1', durationS: 10, fileSize: VOICE_MAX_FILE_BYTES + 1 },
        NOW,
      ),
    ).toEqual({ ok: false, error: 'too-big' });
    // too-big відрізали ДО мережі: був лише getFile-виклик першого кейсу.
    expect(calls.filter((c) => c.url.includes('/file/'))).toHaveLength(0);
  });

  it('фактичний файл понад стелю → too-big (заявлений розмір міг збрехати)', async () => {
    makeFetchStub({ fileBytes: new Uint8Array(VOICE_MAX_FILE_BYTES + 1).buffer });
    const { env } = makeEnv();
    expect(await transcribeVoice(env, { fileId: 'F1', durationS: 10 }, NOW)).toEqual({
      ok: false,
      error: 'too-big',
    });
  });
});

// ── voice_pending: claim і TTL ───────────────────────────────────────────────

describe('savePendingVoice / takePendingVoice', () => {
  it('take - це claim: перший тап забирає ряд, другий отримує null', async () => {
    const { env } = makeEnv();
    const id = await savePendingVoice(
      env,
      { kind: 'transcript', text: 'привіт', durationS: 5, chatId: 555, threadId: null },
      NOW,
    );
    const first = await takePendingVoice(env, id, NOW);
    expect(first).toMatchObject({ kind: 'transcript', text: 'привіт', chatId: '555' });
    expect(await takePendingVoice(env, id, NOW)).toBeNull();
  });

  it('протухле (> 30 хв) → null; вставка принагідно чистить старі ряди', async () => {
    const { env, db } = makeEnv();
    const id = await savePendingVoice(
      env,
      { kind: 'file', fileId: 'F9', durationS: 400, chatId: 555, threadId: '99' },
      NOW,
    );
    expect(await takePendingVoice(env, id, NOW + VOICE_PENDING_TTL_MS + 1)).toBeNull();

    db.prepare(
      `INSERT INTO voice_pending (id, kind, text, duration_s, created_at)
       VALUES ('old1', 'transcript', 'старе', 5, ?)`,
    ).run(new Date(NOW - VOICE_PENDING_TTL_MS - 1).toISOString());
    await savePendingVoice(
      env,
      { kind: 'transcript', text: 'нове', durationS: 5, chatId: null, threadId: null },
      NOW,
    );
    expect(db.prepare(`SELECT id FROM voice_pending WHERE id = 'old1'`).get()).toBeUndefined();
  });
});

// ── Дротування prerouter: «Я почув», довге голосове, v:-callback-и ───────────

type ThreadState = {
  activeRunId: string | null;
  statusMessageId: number | null;
  queue: Record<string, unknown>[];
};

/** Мінімальний реєстр-стаб (DO-логіка окремо в thread-queue.test). */
function makeRegistryStub() {
  const begins: Record<string, unknown>[] = [];
  const threads = new Map<string, ThreadState>();
  const stub = {
    begin: async (run: Record<string, unknown>) => void begins.push(run),
    finish: async () => null,
    threadClaim: async (threadId: string, entry: Record<string, unknown>) => {
      const t = threads.get(threadId) ?? { activeRunId: null, statusMessageId: null, queue: [] };
      if (t.activeRunId != null || t.queue.length > 0) {
        t.queue.push(entry);
        threads.set(threadId, t);
        return { queued: t.queue.length };
      }
      t.activeRunId = 'pending';
      threads.set(threadId, t);
      return { start: true };
    },
    threadSetRun: async (threadId: string, runId: string, statusMessageId: number | null) => {
      const t = threads.get(threadId);
      if (!t) return { claimed: false };
      t.activeRunId = runId;
      t.statusMessageId = statusMessageId;
      return { claimed: true };
    },
    threadClear: async () => ({ activeRunId: null, statusMessageId: null, cleared: 0 }),
  };
  return { begins, threads, ns: { getByName: () => stub } };
}

/** Стаб fetch усіх трьох світів: Telegram + Deepgram + мозок. */
function makeFlowFetchStub(opts: { deepgramStatus?: number; deepgramTranscript?: string } = {}) {
  const tg: { method: string; body: Record<string, unknown> }[] = [];
  const brain: { path: string; body: Record<string, unknown> }[] = [];
  let msgSeq = 100;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('api.telegram.org') && u.endsWith('/getFile')) {
        return new Response(
          JSON.stringify({ ok: true, result: { file_path: 'voice/file_7.oga' } }),
          { status: 200 },
        );
      }
      if (u.includes('api.telegram.org/file/')) return new Response(AUDIO, { status: 200 });
      if (u.includes('api.telegram.org')) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        tg.push({ method: u.split('/').pop() ?? '', body });
        msgSeq += 1;
        return new Response(JSON.stringify({ ok: true, result: { message_id: msgSeq } }), {
          status: 200,
        });
      }
      if (u.includes('api.deepgram.com')) {
        return new Response(
          JSON.stringify({
            results: {
              channels: [
                {
                  alternatives: [{ transcript: opts.deepgramTranscript ?? 'нагадай про зустріч' }],
                },
              ],
            },
          }),
          { status: opts.deepgramStatus ?? 200 },
        );
      }
      if (u.includes('brain.example')) {
        const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        brain.push({ path: new URL(u).pathname, body });
        return new Response(JSON.stringify({ ok: true }), { status: 202 });
      }
      throw new Error(`несподіваний fetch: ${u}`);
    }),
  );
  return { tg, brain };
}

function makeFlowEnv(mode = 'on', over: Record<string, unknown> = {}) {
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0003_telemetry.sql',
    '0009_voice.sql',
  ]);
  const reg = makeRegistryStub();
  const env = workerEnv({
    ASSISTANT_V2: mode,
    DEEPGRAM_API_KEY: 'dg-key',
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
    INTERNAL_HMAC_KEY: 'voice-test-key',
    BRAIN_URL: 'https://brain.example',
    RUN_REGISTRY: reg.ns,
    DB: d1.stub,
    ...over,
  });
  return { env, db: d1.db, reg };
}

const voiceMsg = (over: Record<string, unknown> = {}) => ({
  kind: 'message',
  chatId: 555,
  threadId: null,
  messageId: 1,
  fromId: 777,
  text: '',
  voice: { fileId: 'F1', durationS: 6, fileSize: 1000 },
  ...over,
});

describe('prerouteMessage: голосове', () => {
  it('on: «Я почув: «…»» з кнопками v:…:ok/edit, pending kind=transcript', async () => {
    const { tg } = makeFlowFetchStub();
    const { env, db } = makeFlowEnv();

    expect(await prerouteMessage(env, voiceMsg(), NOW)).toBe(true);

    const sent = tg.find((c) => c.method === 'sendMessage')!;
    expect(sent.body.text).toBe('Я почув: «нагадай про зустріч»');
    const kb = (sent.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0]!;
    expect(kb.map((b) => b.callback_data.split(':')[2])).toEqual(['ok', 'edit']);

    const row = db.prepare(`SELECT kind, text FROM voice_pending`).get() as {
      kind: string;
      text: string;
    };
    expect(row).toEqual({ kind: 'transcript', text: 'нагадай про зустріч' });
  });

  it('shadow: голос іде повним шляхом БЕЗ префікса v2: (ADR-040)', async () => {
    const { tg } = makeFlowFetchStub();
    const { env } = makeFlowEnv('shadow');
    expect(await prerouteMessage(env, voiceMsg(), NOW)).toBe(true);
    expect(tg.find((c) => c.method === 'sendMessage')!.body.text).toContain('Я почув');
  });

  it('off: false і жодного мережевого виклику', async () => {
    const { tg } = makeFlowFetchStub();
    const { env } = makeFlowEnv('off');
    expect(await prerouteMessage(env, voiceMsg(), NOW)).toBe(false);
    expect(tg).toHaveLength(0);
  });

  it('чужа тема → false (периметр той самий, що в тексту)', async () => {
    makeFlowFetchStub();
    const { env } = makeFlowEnv();
    expect(await prerouteMessage(env, voiceMsg({ threadId: 42 }), NOW)).toBe(false);
  });

  it('голос співвласника → false, жодного розпізнавання (S1/B1)', async () => {
    makeFlowFetchStub();
    const { env } = makeFlowEnv();
    expect(await prerouteMessage(env, voiceMsg({ fromId: 888 }), NOW)).toBe(false);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
  });

  it('резервний розпізнавач позначається в «Я почув»', async () => {
    const { tg } = makeFlowFetchStub({ deepgramStatus: 503 });
    const { env } = makeFlowEnv('on', { AI: makeAiStub('текст із резерву') });
    await prerouteMessage(env, voiceMsg(), NOW);
    expect(tg.find((c) => c.method === 'sendMessage')!.body.text).toBe(
      'Я почув: «текст із резерву»\n(резервний розпізнавач)',
    );
  });

  it('тиша → «Не розчув - повтори або напиши.», без pending і кнопок', async () => {
    const { tg } = makeFlowFetchStub({ deepgramTranscript: '' });
    const { env, db } = makeFlowEnv();
    await prerouteMessage(env, voiceMsg(), NOW);
    const sent = tg.find((c) => c.method === 'sendMessage')!;
    expect(sent.body.text).toBe('Не розчув - повтори або напиши.');
    expect(sent.body.reply_markup).toBeUndefined();
    expect(db.prepare(`SELECT count(*) AS n FROM voice_pending`).get()).toEqual({ n: 0 });
  });

  it('довге (> 5 хв) → «Розпізнати?» без виклику Deepgram, pending kind=file (S-6-4)', async () => {
    const fetchSpy = makeFlowFetchStub();
    const { env, db } = makeFlowEnv();
    await prerouteMessage(env, voiceMsg({ voice: { fileId: 'F9', durationS: 400 } }), NOW);

    const sent = fetchSpy.tg.find((c) => c.method === 'sendMessage')!;
    expect(sent.body.text).toContain('Довге голосове');
    const kb = (sent.body.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard[0]!;
    expect(kb[0]!.callback_data.endsWith(':go')).toBe(true);
    expect(db.prepare(`SELECT kind, file_id FROM voice_pending`).get()).toEqual({
      kind: 'file',
      file_id: 'F9',
    });
    // Deepgram не кликали: розпізнавання - лише після тапу «Розпізнати».
    expect(
      (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0])),
    ).not.toContainEqual(expect.stringContaining('deepgram'));
  });
});

describe('handleBrainCallback: v:-тапи', () => {
  async function present(env: unknown, db: unknown) {
    await prerouteMessage(env as never, voiceMsg(), NOW);
    return (db as { prepare: (s: string) => { get: () => { id: string } } })
      .prepare(`SELECT id FROM voice_pending`)
      .get()!.id;
  }

  it('✅ → транскрипт іде в тред як текст (статусник + /run мозку), подвійний тап - «Застаріло»', async () => {
    const { tg, brain } = makeFlowFetchStub();
    const { env, db } = makeFlowEnv();
    const id = await present(env, db);

    const toast = await handleBrainCallback(
      env,
      { data: `v:${id}:ok`, chatId: 555, messageId: 101 },
      NOW,
    );
    expect(toast).toBe('Прийняв ✅');
    expect(brain).toHaveLength(1);
    expect(brain[0]!.path).toBe('/run');
    expect(brain[0]!.body).toMatchObject({
      profile: 'chat',
      input: { text: 'нагадай про зустріч' },
    });
    // Клавіатуру прибрано, статусник «▸ Думаю…» надіслано.
    expect(tg.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    expect(tg.some((c) => c.method === 'sendMessage' && c.body.text === '▸ Думаю…')).toBe(true);

    expect(await handleBrainCallback(env, { data: `v:${id}:ok`, chatId: 555 }, NOW)).toBe(
      'Застаріло - надішли голосове ще раз.',
    );
  });

  it('✏️ → «напиши текстом», прогін не стартує, pending знищено', async () => {
    const { brain } = makeFlowFetchStub();
    const { env, db } = makeFlowEnv();
    const id = await present(env, db);

    expect(await handleBrainCallback(env, { data: `v:${id}:edit`, chatId: 555 }, NOW)).toBe(
      'Ок - напиши текстом.',
    );
    expect(brain).toHaveLength(0);
    expect(db.prepare(`SELECT count(*) AS n FROM voice_pending`).get()).toEqual({ n: 0 });
  });

  it('✅ на транскрипті «стоп» → шлях abort, а не прогін (спільний routeThreadText)', async () => {
    const { tg, brain } = makeFlowFetchStub({ deepgramTranscript: 'стоп' });
    const { env, db } = makeFlowEnv();
    const id = await present(env, db);

    expect(await handleBrainCallback(env, { data: `v:${id}:ok`, chatId: 555 }, NOW)).toBe(
      'Прийняв ✅',
    );
    expect(brain).toHaveLength(0); // «стоп» ніколи не їде в мозок текстом
    expect(
      tg.some((c) => c.method === 'sendMessage' && c.body.text === 'Нема чого зупиняти.'),
    ).toBe(true);
  });

  it('«Розпізнати» довгого → транскрипція і нове «Я почув» із ✅/✏️', async () => {
    const { tg } = makeFlowFetchStub();
    const { env, db } = makeFlowEnv();
    await prerouteMessage(env, voiceMsg({ voice: { fileId: 'F9', durationS: 400 } }), NOW);
    const id = (db.prepare(`SELECT id FROM voice_pending`).get() as { id: string }).id;

    expect(await handleBrainCallback(env, { data: `v:${id}:go`, chatId: 555 }, NOW)).toBe(
      'Розпізнаю…',
    );
    const heard = tg.filter(
      (c) => c.method === 'sendMessage' && String(c.body.text).startsWith('Я почув'),
    );
    expect(heard).toHaveLength(1);
    const fresh = db.prepare(`SELECT kind FROM voice_pending`).get() as { kind: string };
    expect(fresh.kind).toBe('transcript');
  });

  it('невідомий/битий id → «Застаріло», чужі формати не чіпаються (null)', async () => {
    makeFlowFetchStub();
    const { env } = makeFlowEnv();
    expect(await handleBrainCallback(env, { data: 'v:000000000000:ok', chatId: 555 }, NOW)).toBe(
      'Застаріло - надішли голосове ще раз.',
    );
    expect(await handleBrainCallback(env, { data: 'v1:2026-07-09:ja:0', chatId: 555 }, NOW)).toBe(
      null,
    );
  });
});
