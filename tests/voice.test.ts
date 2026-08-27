// Голос (етап 2 PR-4, ADR-040): transcribeVoice - getFile → завантаження →
// Deepgram nova-3 → квота deepgram_min; збій Deepgram → Whisper-резерв з
// позначкою; misconfig ≠ збій (без ключа - чесна відмова, не тихий резерв).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  transcribeVoice,
  VOICE_MAX_FILE_BYTES,
  VOICE_TRANSCRIPT_MAX_CHARS,
} from '../web/core/voice.mjs';
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
  const d1 = d1FromSqlite(['0003_telemetry.sql']);
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
