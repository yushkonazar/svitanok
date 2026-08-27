// Цикл прогону мозку (мок рушія і клієнта): маршрут інструмента mcp→core,
// стеля профілю, taint-блок write-інструментів (перша половина подвійного
// барʼєра 01 §4.2), ескалація quick без deliver, троттлінг статусу, чесний
// deliver збою, телеметрія steps наприкінці за будь-якого результату.

import { describe, expect, it, vi, type Mock } from 'vitest';
import { makeRunner, type EngineOutcome, type EngineRunOptions } from '../brain/src/agent.js';
import type { ToolCallOutcome } from '../brain/src/core-client.js';
import type { RunRequest } from '../brain/src/server.js';
import { PROFILES } from '../brain/src/profiles.js';
import { BRAIN_TOOLS } from '../brain/src/tools/schemas.js';

interface ClientMock {
  callTool: Mock<(runId: string, coreName: string, args: unknown) => Promise<ToolCallOutcome>>;
  deliver: Mock<(runId: string, text: string) => Promise<void>>;
  status: Mock<(runId: string, messageId: number, text: string) => Promise<void>>;
  reportRuns: Mock<(runId: string, steps: object[]) => Promise<void>>;
  session: Mock<(runId: string, body: Record<string, unknown>) => Promise<boolean>>;
}

function makeClient(over: Partial<ClientMock> = {}): ClientMock {
  return {
    callTool: vi.fn(async () => ({
      ok: true as const,
      tool: 't',
      tainted: false,
      result: 'дані',
    })),
    deliver: vi.fn(async () => undefined),
    status: vi.fn(async () => undefined),
    reportRuns: vi.fn(async () => undefined),
    session: vi.fn(async () => true),
    ...over,
  };
}

function req(over: Partial<RunRequest> = {}): RunRequest {
  return {
    run_id: 'run-1',
    profile: 'chat',
    thread_id: 'dm',
    input: { text: 'привіт' },
    ...over,
  };
}

/** Рушій, що виконує задані виклики інструментів і віддає фінальний текст.
 *  script може повертати EngineOutcome без sessionId - дозаповнюється null. */
function scriptedEngine(
  script: (opts: EngineRunOptions, inputText: string) => Promise<Partial<EngineOutcome>>,
  transcript: string | null = 'Власник: привіт\nСвітанок: Вітаю.',
) {
  const seen: EngineRunOptions[] = [];
  const inputs: string[] = [];
  const readTranscript = vi.fn(async () => transcript);
  return {
    seen,
    inputs,
    readTranscript,
    engine: {
      run: async (opts: EngineRunOptions, inputText: string): Promise<EngineOutcome> => {
        seen.push(opts);
        inputs.push(inputText);
        const out = await script(opts, inputText);
        return { finalText: out.finalText ?? null, sessionId: out.sessionId ?? null };
      },
      readTranscript,
    },
  };
}

describe('makeRunner: щасливий шлях', () => {
  it('chat: системний промпт з Києвом, усі інструменти, deliver фіналу, steps у reportRuns', async () => {
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async (opts) => {
      const out = await opts.onToolCall('data_read', { scope: 'briefing' });
      expect(out.isError).toBe(false);
      expect(out.text).toBe('дані');
      return { finalText: 'Готово' };
    });
    await makeRunner({ client, engine })(req());

    expect(seen[0]!.model).toBe(PROFILES.chat.model);
    expect(seen[0]!.systemPrompt).toContain('Зараз у Києві');
    expect(seen[0]!.toolNames).toEqual(BRAIN_TOOLS.map((t) => t.mcpName));
    expect(client.callTool).toHaveBeenCalledWith('run-1', 'data.read', { scope: 'briefing' });
    expect(client.deliver).toHaveBeenCalledWith('run-1', 'Готово');
    const steps = client.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(steps.map((s) => s.kind)).toEqual(['tool', 'reply']);
    expect(steps[0]).toMatchObject({ n: 1, name: 'data.read', ok: true });
  });

  it('порожній фінал доставляється явно, а не тишею', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async () => ({ finalText: null }));
    await makeRunner({ client, engine })(req());
    expect(client.deliver).toHaveBeenCalledWith('run-1', '(порожня відповідь моделі)');
  });

  it('довгий фінал обрізається під ОБИДВІ стелі: кирилиця - по байтах, ASCII - по символах', async () => {
    // Кирилиця 2 байти/символ: 70 000 символів = 140 000 байт → ріже байтова
    // стеля 100 000 (50 000 символів + «…»).
    const client = makeClient();
    const { engine } = scriptedEngine(async () => ({ finalText: 'а'.repeat(70_000) }));
    await makeRunner({ client, engine })(req());
    const cyr = client.deliver.mock.calls[0]![1] as string;
    expect(cyr.length).toBe(50_001);
    expect(cyr.endsWith('…')).toBe(true);

    // ASCII 1 байт/символ: байти не тиснуть, ріже символьна стеля 65 000.
    const client2 = makeClient();
    const s2 = scriptedEngine(async () => ({ finalText: 'a'.repeat(70_000) }));
    await makeRunner({ client: client2, engine: s2.engine })(req());
    const ascii = client2.deliver.mock.calls[0]![1] as string;
    expect(ascii.length).toBe(65_001);
    expect(ascii.endsWith('…')).toBe(true);
  });

  it('зріз не полишає самотніх сурогатів (емодзі на межі)', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async () => ({
      finalText: 'а'.repeat(64_999) + '😀'.repeat(10),
    }));
    await makeRunner({ client, engine })(req());
    const text = client.deliver.mock.calls[0]![1] as string;
    // Самотній сурогат не пережив би UTF-8 round-trip (став би U+FFFD).
    expect(Buffer.from(text, 'utf8').toString('utf8')).toBe(text);
    expect(text.endsWith('…')).toBe(true);
  });
});

describe('makeRunner: барʼєри', () => {
  it('стеля інструментів профілю: виклик №13 - відмова tool-cap, ядро не кличеться', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async (opts) => {
      for (let i = 0; i < PROFILES.chat.maxToolCalls; i += 1) {
        const out = await opts.onToolCall('geo_last', {});
        expect(out.isError).toBe(false);
      }
      const over = await opts.onToolCall('geo_last', {});
      expect(over.isError).toBe(true);
      expect(over.text).toContain('Стеля інструментів');
      return { finalText: 'ок' };
    });
    await makeRunner({ client, engine })(req());
    expect(client.callTool).toHaveBeenCalledTimes(PROFILES.chat.maxToolCalls);
  });

  it('tainted-сесія блокує write-інструмент ДО ядра; читання проходить', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async (opts) => {
      const read = await opts.onToolCall('facts_get', {});
      expect(read.isError).toBe(false);
      const write = await opts.onToolCall('facts_set', { kind: 'setting', key: 'k', value: 1 });
      expect(write.isError).toBe(true);
      expect(write.text).toContain('зовнішній вміст');
      return { finalText: 'ок' };
    });
    await makeRunner({ client, engine })(req({ tainted: true }));
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledWith('run-1', 'facts.get', {});
  });

  it('mode=proposed: модель бачить «НЕ виконано» з деталями пропозиції, не "null"', async () => {
    const client = makeClient({
      callTool: vi.fn(async () => ({
        ok: true as const,
        tool: 'facts.set',
        tainted: false,
        mode: 'proposed' as const,
        proposal: { id: 'p1' },
      })),
    });
    const { engine } = scriptedEngine(async (opts) => {
      const out = await opts.onToolCall('facts_set', { kind: 'setting', key: 'k', value: 1 });
      expect(out.isError).toBe(false);
      expect(out.text).toContain('НЕ виконано');
      expect(out.text).toContain('підтвердження');
      expect(out.text).toContain('p1');
      expect(out.text).not.toBe('null');
      return { finalText: 'Чекаю підтвердження' };
    });
    await makeRunner({ client, engine })(req());
    const steps = client.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ kind: 'tool', ok: true, note: 'proposed' });
  });

  it('taint приходить із відповіді ядра: після tainting-читання write блокується', async () => {
    const client = makeClient({
      callTool: vi.fn(async () => ({ ok: true, tool: 'mail.search', tainted: true, result: 'x' })),
    });
    const { engine } = scriptedEngine(async (opts) => {
      await opts.onToolCall('mail_search', { q: 'нова пошта' });
      const write = await opts.onToolCall('facts_set', { kind: 'setting', key: 'k', value: 1 });
      expect(write.isError).toBe(true);
      return { finalText: 'ок' };
    });
    await makeRunner({ client, engine })(req());
    expect(client.callTool).toHaveBeenCalledTimes(1);
  });

  it('невідомий і не-профільний інструмент - відмова без виклику ядра', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async (opts) => {
      expect((await opts.onToolCall('bash', {})).isError).toBe(true);
      return { finalText: 'ок' };
    });
    await makeRunner({ client, engine })(req());
    expect(client.callTool).not.toHaveBeenCalled();
  });

  it('відмова ядра стає текстом помилки для моделі, прогін живе далі', async () => {
    const client = makeClient({
      callTool: vi.fn(async () => ({
        ok: false as const,
        status: 502,
        error: 'tool-failed: календар',
      })),
    });
    const { engine } = scriptedEngine(async (opts) => {
      const out = await opts.onToolCall('calendar_read', { days: 1 });
      expect(out.isError).toBe(true);
      expect(out.text).toContain('tool-failed: календар');
      return { finalText: 'Календар недоступний' };
    });
    await makeRunner({ client, engine })(req());
    expect(client.deliver).toHaveBeenCalledWith('run-1', 'Календар недоступний');
  });
});

describe('makeRunner: quick і збої', () => {
  it('quick: без інструментів, модель haiku; ESCALATE не доставляється власнику', async () => {
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async () => ({ finalText: 'ESCALATE: треба память' }));
    await makeRunner({ client, engine })(req({ profile: 'quick' }));
    expect(seen[0]!.model).toBe(PROFILES.quick.model);
    expect(seen[0]!.toolNames).toEqual([]);
    expect(client.deliver).not.toHaveBeenCalled();
    const steps = client.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ kind: 'reply', name: 'escalate' });
  });

  it('збій рушія: власник бачить «Прогін не вдався», steps звітуються з error', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async () => {
      throw new Error('SDK упав');
    });
    await makeRunner({ client, engine })(req());
    expect(String(client.deliver.mock.calls[0]![1])).toMatch(/^Прогін не вдався: SDK упав/);
    const steps = client.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ kind: 'error', ok: false });
  });

  it('збій рушія + збій deliver - без неперехопленого, телеметрія все одно йде', async () => {
    const client = makeClient({
      deliver: vi.fn(async () => {
        throw new Error('outbox мертвий');
      }),
    });
    const { engine } = scriptedEngine(async () => {
      throw new Error('SDK упав');
    });
    await expect(makeRunner({ client, engine })(req())).resolves.toBeUndefined();
    expect(client.reportRuns).toHaveBeenCalledTimes(1);
  });
});

describe('makeRunner: сесії (chat)', () => {
  it('resume і згортка з req.session; після deliver сесія звітується з turns_inc=1', async () => {
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async () => ({
      finalText: 'Готово',
      sessionId: 'sess-нова',
    }));
    await makeRunner({ client, engine })(
      req({ session: { sdk_session_id: 'sess-стара', summary_md: 'Вчора: обрали Креденс' } }),
    );
    expect(seen[0]!.resumeSessionId).toBe('sess-стара');
    expect(seen[0]!.systemPrompt).toContain('Згортка попередніх розмов');
    expect(seen[0]!.systemPrompt).toContain('обрали Креденс');
    expect(client.deliver).toHaveBeenCalledWith('run-1', 'Готово');
    expect(client.session).toHaveBeenCalledWith('run-1', {
      thread_id: 'dm',
      sdk_session_id: 'sess-нова',
      turns_inc: 1,
    });
  });

  it('без session - свіжа сесія, без згортки; без sessionId від рушія - session не кличеться', async () => {
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async () => ({ finalText: 'Готово' }));
    await makeRunner({ client, engine })(req());
    expect(seen[0]!.resumeSessionId).toBeNull();
    expect(seen[0]!.systemPrompt).not.toContain('Згортка попередніх');
    expect(client.session).not.toHaveBeenCalled();
  });

  it('quick НЕ звітує сесію навіть із sessionId (сесії - лише chat)', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async () => ({ finalText: '42', sessionId: 's' }));
    await makeRunner({ client, engine })(req({ profile: 'quick' }));
    expect(client.session).not.toHaveBeenCalled();
  });
});

describe('makeRunner: summarize', () => {
  const summarizeReq = (over: Partial<RunRequest> = {}) =>
    req({
      profile: 'summarize',
      input: { text: 'згорни розмову' },
      session: { sdk_session_id: 'sess-1', summary_md: null },
      ...over,
    });

  it('щасливий шлях: транскрипт → рушій → summary у client.session; deliver НЕ кличеться', async () => {
    const client = makeClient();
    const { engine, seen, inputs, readTranscript } = scriptedEngine(
      async () => ({ finalText: 'Згортка: обрали Креденс.' }),
      'Власник: привіт\nСвітанок: Вітаю.',
    );
    await makeRunner({ client, engine })(summarizeReq());
    expect(readTranscript).toHaveBeenCalledWith('sess-1');
    expect(seen[0]!.systemPrompt).toContain('згортаєш розмову');
    expect(seen[0]!.resumeSessionId).toBeNull();
    expect(inputs[0]).toBe('Власник: привіт\nСвітанок: Вітаю.');
    expect(client.deliver).not.toHaveBeenCalled();
    expect(client.session).toHaveBeenCalledWith('run-1', {
      thread_id: 'dm',
      summary_md: 'Згортка: обрали Креденс.',
    });
    const steps = client.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>;
    expect(steps[0]).toMatchObject({ kind: 'reply', name: 'summary', ok: true });
  });

  it('довгий транскрипт ріжеться ХВОСТОМ до 24 000', async () => {
    const client = makeClient();
    const long = 'а'.repeat(30_000) + 'КІНЕЦЬ';
    const { engine, inputs } = scriptedEngine(async () => ({ finalText: 'зг' }), long);
    await makeRunner({ client, engine })(summarizeReq());
    expect(inputs[0]!.length).toBeLessThanOrEqual(24_001);
    expect(inputs[0]!.endsWith('КІНЕЦЬ')).toBe(true);
    expect(inputs[0]!.startsWith('…')).toBe(true);
  });

  it('без sdk_session_id або без транскрипта - error-крок, рушій/deliver не чіпаються', async () => {
    const noSid = makeClient();
    const s1 = scriptedEngine(async () => ({ finalText: 'x' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await makeRunner({ client: noSid, engine: s1.engine })(summarizeReq({ session: undefined }));
    expect(s1.seen).toHaveLength(0);
    expect(noSid.session).not.toHaveBeenCalled();
    expect((noSid.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>)[0]).toMatchObject(
      { kind: 'error', note: 'no-session' },
    );

    const noTr = makeClient();
    const s2 = scriptedEngine(async () => ({ finalText: 'x' }), null);
    await makeRunner({ client: noTr, engine: s2.engine })(summarizeReq());
    expect(s2.seen).toHaveLength(0);
    expect((noTr.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: 'error',
      note: 'transcript-unavailable',
    });
  });

  it('порожня згортка - error-крок; відмова /internal/session - ok:false у кроці', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const empty = makeClient();
    const s1 = scriptedEngine(async () => ({ finalText: '' }));
    await makeRunner({ client: empty, engine: s1.engine })(summarizeReq());
    expect(empty.session).not.toHaveBeenCalled();
    expect((empty.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>)[0]).toMatchObject(
      { kind: 'error', note: 'empty-summary' },
    );

    const failing = makeClient({ session: vi.fn(async () => false) });
    const s2 = scriptedEngine(async () => ({ finalText: 'зг' }));
    await makeRunner({ client: failing, engine: s2.engine })(summarizeReq());
    expect(
      (failing.reportRuns.mock.calls[0]![1] as Array<Record<string, unknown>>)[0],
    ).toMatchObject({ kind: 'reply', name: 'summary', ok: false, note: 'session-endpoint-failed' });
  });
});

describe('makeRunner: стрімінг статусу', () => {
  it('оновлення ≤ 1 на інтервал і лише за наявності status_message_id; streamPartials відповідно', async () => {
    let t = 0;
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async (opts) => {
      for (let i = 0; i < 10; i += 1) {
        opts.onPartialText(`частина ${i}`);
        t += 300;
      }
      return { finalText: 'Готово' };
    });
    await makeRunner({ client, engine, now: () => t })(req({ status_message_id: 42 }));
    // 10 подій по 300 мс = 3 с; з інтервалом 1000 мс проходить ≤ 4.
    expect(seen[0]!.streamPartials).toBe(true);
    expect(client.status.mock.calls.length).toBeGreaterThan(0);
    expect(client.status.mock.calls.length).toBeLessThanOrEqual(4);
    expect(client.status.mock.calls[0]![0]).toBe('run-1');
    expect(client.status.mock.calls[0]![1]).toBe(42);

    const silent = makeClient();
    const scripted = scriptedEngine(async (opts) => {
      opts.onPartialText('х');
      return { finalText: 'Готово' };
    });
    await makeRunner({ client: silent, engine: scripted.engine })(req());
    expect(scripted.seen[0]!.streamPartials).toBe(false);
    expect(silent.status).not.toHaveBeenCalled();
  });

  it('статус показує ХВІСТ довгого партіала, а не замерзлу голову', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async (opts) => {
      opts.onPartialText('а'.repeat(5000) + 'КІНЕЦЬ');
      return { finalText: 'Готово' };
    });
    await makeRunner({ client, engine })(req({ status_message_id: 42 }));
    const text = client.status.mock.calls[0]![2] as string;
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('КІНЕЦЬ')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(3901);
  });
});
