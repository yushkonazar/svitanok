// Працівники (етап 2 PR-8, етап 4 PR-3): профіль quick іде шляхом працівника;
// delegate запускає решту девʼятьох з інструкцією з D1 (через ядро, з хешем).
// Перевіряється саме те, чим цей шлях відрізняється від звичайного прогону:
// свіжа сесія, модель і стеля ходів із front-matter, відсутність походу в
// ядро на внутрішньому інструменті і слід у телеметрії з іменем працівника.

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import {
  EngineStopError,
  makeRunner,
  type EngineOutcome,
  type EngineRunOptions,
  type ToolExecution,
} from '../brain/src/agent.js';
import {
  DELEGATE_WORKERS,
  QUICK_WORKER,
  WORKERS,
  WORKER_MODEL_IDS,
  runWorker,
} from '../brain/src/workers.js';
import { TOOL_BY_MCP_NAME } from '../brain/src/tools/schemas.js';
import { PROFILES } from '../brain/src/profiles.js';
import { instructionHash } from '../brain/src/instructions.js';
import type { InstructionOutcome, ToolCallOutcome } from '../brain/src/core-client.js';
import type { RunRequest } from '../brain/src/server.js';
import { parseInstruction } from '../web/core/instructions.mjs';

const BODY = 'Ти - Світанок. Відповідай коротко.';

interface ClientMock {
  callTool: Mock<(runId: string, coreName: string, args: unknown) => Promise<ToolCallOutcome>>;
  deliver: Mock<(runId: string, text: string) => Promise<void>>;
  status: Mock<(runId: string, messageId: number, text: string) => Promise<void>>;
  reportRuns: Mock<(runId: string, steps: object[]) => Promise<void>>;
  session: Mock<(runId: string, body: Record<string, unknown>) => Promise<boolean>>;
  instruction: Mock<(runId: string, name: string) => Promise<InstructionOutcome>>;
  taint: Mock<(runId: string, source: string) => Promise<boolean>>;
}

function makeClient(): ClientMock {
  return {
    callTool: vi.fn(async () => ({ ok: true as const, tool: 't', tainted: false, result: 'дані' })),
    deliver: vi.fn(async () => undefined),
    status: vi.fn(async () => undefined),
    reportRuns: vi.fn(async () => undefined),
    session: vi.fn(async () => true),
    instruction: vi.fn(async () => ({
      ok: false as const,
      status: 404,
      error: 'instruction-missing',
    })),
    taint: vi.fn(async () => true),
  };
}

function req(over: Partial<RunRequest> = {}): RunRequest {
  const profile = over.profile ?? 'chat';
  return {
    run_id: 'run-w',
    profile: 'chat',
    thread_id: 'dm',
    input: { text: 'скільки 2+2' },
    instruction: {
      name: profile === 'chat' ? 'persona' : 'quick',
      version_hash: instructionHash(BODY),
      body_md: BODY,
    },
    ...over,
  };
}

function scriptedEngine(script: (opts: EngineRunOptions) => Promise<Partial<EngineOutcome>>) {
  const seen: EngineRunOptions[] = [];
  const inputs: string[] = [];
  return {
    seen,
    inputs,
    engine: {
      run: async (opts: EngineRunOptions, inputText: string): Promise<EngineOutcome> => {
        seen.push(opts);
        inputs.push(inputText);
        const out = await script(opts);
        return { finalText: out.finalText ?? null, sessionId: out.sessionId ?? null };
      },
      readTranscript: vi.fn(async () => null),
    },
  };
}

/** Кроки, які мозок віддав у /internal/runs останнім викликом. */
function steps(client: ClientMock): Record<string, unknown>[] {
  return (client.reportRuns.mock.calls.at(-1)?.[1] ?? []) as Record<string, unknown>[];
}

describe('runWorker', () => {
  it('свіжа сесія, модель і стеля ходів - із опису працівника', async () => {
    const { engine, seen, inputs } = scriptedEngine(async () => ({ finalText: 'готово' }));
    const out = await runWorker(
      engine,
      {
        name: 'researcher',
        prompt: 'ПРОМПТ ПРАЦІВНИКА',
        model: 'sonnet',
        maxSteps: 6,
        toolNames: ['data_read'],
        builtinTools: [],
        taintedOutput: true,
      },
      'знайди правила вʼїзду',
      {
        abortSignal: new AbortController().signal,
        onToolCall: async () => ({ text: '', isError: false }),
        onPartialText: () => {},
        streamPartials: false,
      },
    );

    expect(out.finalText).toBe('готово');
    expect(inputs[0]).toBe('знайди правила вʼїзду');
    expect(seen[0]).toMatchObject({
      systemPrompt: 'ПРОМПТ ПРАЦІВНИКА',
      model: WORKER_MODEL_IDS.sonnet,
      maxTurns: 6,
      toolNames: ['data_read'],
      // Працівник не продовжує розмову власника - resume для нього немає.
      resumeSessionId: null,
      streamPartials: false,
    });
  });

  it('рівень зусиль передається рушію; без нього поле не зʼявляється', async () => {
    const base = {
      name: 'w',
      prompt: 'П',
      model: 'haiku' as const,
      maxSteps: 1,
      toolNames: [],
      builtinTools: [],
      taintedOutput: false,
    };
    const ctx = {
      abortSignal: new AbortController().signal,
      onToolCall: async () => ({ text: '', isError: false }),
      onPartialText: () => {},
      streamPartials: false,
    };
    const low = scriptedEngine(async () => ({ finalText: 'x' }));
    await runWorker(low.engine, { ...base, effort: 'low' }, 'задача', ctx);
    expect(low.seen[0]!.effort).toBe('low');

    // Не задано - лишаємо дефолт SDK, а не вигадуємо свій.
    const none = scriptedEngine(async () => ({ finalText: 'x' }));
    await runWorker(none.engine, base, 'задача', ctx);
    expect('effort' in none.seen[0]!).toBe(false);
  });
});

describe('профіль quick як працівник', () => {
  it('модель, стеля ходів і відсутність інструментів - з опису quick', async () => {
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async () => ({ finalText: '4' }));
    await makeRunner({ client, engine })(req({ profile: 'quick' }));

    expect(seen[0]!.model).toBe(WORKER_MODEL_IDS[QUICK_WORKER.model]);
    expect(seen[0]!.effort).toBe(QUICK_WORKER.effort);
    expect(seen[0]!.maxTurns).toBe(QUICK_WORKER.maxSteps);
    expect(seen[0]!.toolNames).toEqual([]);
    expect(client.deliver).toHaveBeenCalledWith('run-w', '4');
  });

  it('сесію треду НЕ продовжує, навіть коли ядро її прислало', async () => {
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async () => ({ finalText: '4' }));
    await makeRunner({ client, engine })(
      req({
        profile: 'quick',
        session: { sdk_session_id: 'sess-1', summary_md: null },
      }),
    );

    expect(seen[0]!.resumeSessionId).toBeNull();
  });
});

describe('delegate (етап 4): працівник з інструкцією з D1', () => {
  const WORKER_BODY = '# Редактор\nВиправ і скороти.';
  const instructionOk = (name: string, body = WORKER_BODY): InstructionOutcome => ({
    ok: true,
    name,
    version_hash: instructionHash(body),
    body_md: body,
  });
  /** Рушій: перший виклик - chat (кличе delegate), другий - працівник. */
  function twoStageEngine(
    chat: (opts: EngineRunOptions) => Promise<Partial<EngineOutcome>>,
    worker: (opts: EngineRunOptions, input: string) => Promise<Partial<EngineOutcome>>,
  ) {
    const seen: EngineRunOptions[] = [];
    const inputs: string[] = [];
    return {
      seen,
      inputs,
      engine: {
        run: async (opts: EngineRunOptions, inputText: string): Promise<EngineOutcome> => {
          seen.push(opts);
          inputs.push(inputText);
          const out = seen.length === 1 ? await chat(opts) : await worker(opts, inputText);
          return { finalText: out.finalText ?? null, sessionId: out.sessionId ?? null };
        },
        readTranscript: vi.fn(async () => null),
      },
    };
  }

  it('щасливий шлях: інструкція з ядра з хешем, свіжий прогін працівника з датою, вхід = задача + формат, результат моделі й у deliver', async () => {
    const client = makeClient();
    client.instruction.mockResolvedValue(instructionOk('editor'));
    let out: ToolExecution | null = null;
    const { engine, seen, inputs } = twoStageEngine(
      async (opts) => {
        out = await opts.onToolCall('delegate', {
          worker: 'editor',
          task: 'переклади англійською: привіт',
          format: 'chat',
        });
        return { finalText: 'Ось переклад: hello' };
      },
      async () => ({ finalText: 'hello' }),
    );
    await makeRunner({ client, engine })(req());

    expect(client.instruction).toHaveBeenCalledWith('run-w', 'editor');
    expect(seen[1]).toMatchObject({
      model: WORKER_MODEL_IDS.haiku,
      maxTurns: WORKERS.editor!.maxSteps,
      toolNames: [],
      resumeSessionId: null,
    });
    expect(seen[1]!.systemPrompt.startsWith(WORKER_BODY)).toBe(true);
    expect(seen[1]!.systemPrompt).toContain('Зараз у Києві');
    expect(inputs[1]).toBe('Задача:\nпереклади англійською: привіт\n\nФормат: chat');
    expect(out!.isError).toBe(false);
    expect(out!.text).toBe('Результат працівника «editor»:\nhello');
    expect(client.taint).not.toHaveBeenCalled();
    // Результат працівника - у deliver, ядро дасть кнопки (S-7-1).
    expect(client.deliver).toHaveBeenCalledWith('run-w', 'Ось переклад: hello', [], {
      name: 'editor',
      text: 'hello',
    });
    expect(steps(client).find((s) => s.kind === 'subagent')).toMatchObject({
      name: 'editor',
      ok: true,
      note: '5 симв., 0 інстр.',
    });
  });

  it('Дослідник: вбудовані WebSearch/WebFetch у рушій, вихід tainted → /internal/taint і <external>', async () => {
    const client = makeClient();
    client.instruction.mockResolvedValue(instructionOk('researcher'));
    let out: ToolExecution | null = null;
    const { engine, seen } = twoStageEngine(
      async (opts) => {
        out = await opts.onToolCall('delegate', {
          worker: 'researcher',
          task: 'ціни',
          format: 'chat',
        });
        return { finalText: 'Знайшов' };
      },
      async () => ({ finalText: 'Ціна 10 EUR (джерело, 2026-09-06)' }),
    );
    await makeRunner({ client, engine })(req());
    expect(seen[1]!.builtinTools).toEqual(['WebSearch', 'WebFetch']);
    expect(seen[1]!.toolNames).toEqual([]);
    expect(client.taint).toHaveBeenCalledWith('run-w', 'worker:researcher');
    expect(out!.text).toContain('<external source="worker:researcher">');
    expect(out!.text).toContain('Ціна 10 EUR');
  });

  it('taint не персистовано - результат НЕ видається (fail-closed, S-7-2)', async () => {
    const client = makeClient();
    client.instruction.mockResolvedValue(instructionOk('researcher'));
    client.taint.mockResolvedValue(false);
    let out: ToolExecution | null = null;
    const { engine } = twoStageEngine(
      async (opts) => {
        out = await opts.onToolCall('delegate', {
          worker: 'researcher',
          task: 'ціни',
          format: 'chat',
        });
        return { finalText: 'x' };
      },
      async () => ({ finalText: 'секретний вміст' }),
    );
    await makeRunner({ client, engine })(req());
    expect(out!.isError).toBe(true);
    expect(out!.text).not.toContain('секретний вміст');
    expect(steps(client).find((s) => s.kind === 'subagent')).toMatchObject({
      ok: false,
      note: 'taint-not-persisted',
    });
    expect(client.deliver).toHaveBeenCalledWith('run-w', 'x');
  });

  it('інструменти працівника: лише його власні з описаних, своя стеля, кроки з іменем працівника', async () => {
    const client = makeClient();
    client.instruction.mockResolvedValue(instructionOk('tutor'));
    const seenTools: ToolExecution[] = [];
    const { engine, seen } = twoStageEngine(
      async (opts) => {
        await opts.onToolCall('delegate', { worker: 'tutor', task: 'мок', format: 'chat' });
        return { finalText: 'ok' };
      },
      async (opts) => {
        seenTools.push(await opts.onToolCall('data_read', { scope: 'progress' }));
        seenTools.push(await opts.onToolCall('mail_search', { q: 'x' }));
        seenTools.push(
          await opts.onToolCall('delegate', { worker: 'editor', task: 'x', format: 'c' }),
        );
        return { finalText: 'питання' };
      },
    );
    await makeRunner({ client, engine })(req());
    expect(seen[1]!.toolNames).toEqual(['data_read']);
    expect(seenTools[0]).toEqual({ text: 'дані', isError: false });
    expect(seenTools[1]!.isError).toBe(true);
    expect(seenTools[2]!.isError).toBe(true);
    expect(client.callTool).toHaveBeenCalledTimes(1);
    expect(client.callTool).toHaveBeenCalledWith('run-w', 'data.read', { scope: 'progress' });
    const names = steps(client).map((s) => s.name);
    expect(names).toContain('tutor/data.read');
    expect(names).toContain('tutor/mail_search');
    expect(steps(client).find((s) => s.name === 'tutor/mail_search')).toMatchObject({
      note: 'not-in-worker',
    });
  });

  it('стеля інструментів працівника (max_steps) - окремо від стелі профілю', async () => {
    const client = makeClient();
    client.instruction.mockResolvedValue(instructionOk('editor'));
    const spec = { ...WORKERS.tutor!, maxSteps: 2 };
    void spec;
    client.instruction.mockResolvedValue(instructionOk('tutor'));
    const results: boolean[] = [];
    const { engine } = twoStageEngine(
      async (opts) => {
        await opts.onToolCall('delegate', { worker: 'tutor', task: 'мок', format: 'chat' });
        return { finalText: 'ok' };
      },
      async (opts) => {
        for (let i = 0; i < WORKERS.tutor!.maxSteps + 1; i += 1) {
          results.push((await opts.onToolCall('data_read', { scope: 'progress' })).isError);
        }
        return { finalText: 'x' };
      },
    );
    await makeRunner({ client, engine })(req());
    expect(results.filter((e) => !e)).toHaveLength(WORKERS.tutor!.maxSteps);
    expect(results.at(-1)).toBe(true);
    expect(steps(client).some((s) => s.note === 'worker-cap')).toBe(true);
  });

  it('невідомий працівник / quick / порожня задача - відмова з переліком, без походу в ядро', async () => {
    const client = makeClient();
    const outs: ToolExecution[] = [];
    const { engine } = twoStageEngine(
      async (opts) => {
        outs.push(await opts.onToolCall('delegate', { worker: 'ghost', task: 'x', format: 'c' }));
        outs.push(await opts.onToolCall('delegate', { worker: 'quick', task: 'x', format: 'c' }));
        outs.push(await opts.onToolCall('delegate', { worker: 'editor', task: '  ', format: 'c' }));
        return { finalText: 'ok' };
      },
      async () => ({ finalText: 'never' }),
    );
    await makeRunner({ client, engine })(req());
    expect(outs[0]!.isError).toBe(true);
    expect(outs[0]!.text).toContain('Доступні: ' + DELEGATE_WORKERS.join(', '));
    expect(outs[1]!.isError).toBe(true);
    expect(outs[2]!.isError).toBe(true);
    expect(client.instruction).not.toHaveBeenCalled();
    expect(steps(client)[0]).toMatchObject({ kind: 'subagent', note: 'worker-unknown:ghost' });
  });

  it('S-7-3: інструкції немає в D1 - «не налаштований»; хеш розійшовся - теж', async () => {
    const client = makeClient();
    const outs: ToolExecution[] = [];
    client.instruction
      .mockResolvedValueOnce({
        ok: false,
        status: 404,
        error: 'instruction-missing: «editor» немає в D1',
      })
      .mockResolvedValueOnce({
        ok: true,
        name: 'editor',
        version_hash: 'f'.repeat(64),
        body_md: WORKER_BODY,
      });
    const { engine, seen } = twoStageEngine(
      async (opts) => {
        outs.push(await opts.onToolCall('delegate', { worker: 'editor', task: 'x', format: 'c' }));
        outs.push(await opts.onToolCall('delegate', { worker: 'editor', task: 'x', format: 'c' }));
        return { finalText: 'сам' };
      },
      async () => ({ finalText: 'never' }),
    );
    await makeRunner({ client, engine })(req());
    expect(seen).toHaveLength(1);
    expect(outs[0]!.text).toContain('Працівник «editor» не налаштований');
    expect(outs[1]!.text).toContain('не налаштований');
    expect(steps(client)[1]).toMatchObject({ note: 'worker-instruction:hash' });
  });

  it('S-7-5: стеля ходів із текстом - частковий результат, без тексту або інший збій - відмова', async () => {
    const client = makeClient();
    client.instruction.mockResolvedValue(instructionOk('editor'));
    const outs: ToolExecution[] = [];
    let call = 0;
    const { engine } = twoStageEngine(
      async (opts) => {
        outs.push(await opts.onToolCall('delegate', { worker: 'editor', task: 'a', format: 'c' }));
        outs.push(await opts.onToolCall('delegate', { worker: 'editor', task: 'b', format: 'c' }));
        outs.push(await opts.onToolCall('delegate', { worker: 'editor', task: 'c', format: 'c' }));
        return { finalText: 'ok' };
      },
      async () => {
        call += 1;
        if (call === 1) throw new EngineStopError('error_max_turns', 'половина тексту');
        if (call === 2) throw new EngineStopError('error_max_turns', '');
        throw new Error('SDK: error_during_execution');
      },
    );
    await makeRunner({ client, engine })(req());
    expect(outs[0]!.isError).toBe(false);
    expect(outs[0]!.text).toContain('не вклався у стелю ходів');
    expect(outs[0]!.text).toContain('половина тексту');
    expect(outs[1]!.isError).toBe(true);
    expect(outs[2]!.isError).toBe(true);
    expect(outs[2]!.text).toContain('впав');
    const sub = steps(client).filter((s) => s.kind === 'subagent');
    expect(sub[0]).toMatchObject({ ok: true, note: expect.stringMatching(/^partial /) });
    expect(sub[1]).toMatchObject({ ok: false });
    // deliver несе ОСТАННІЙ успішний результат працівника (частковий).
    expect(client.deliver).toHaveBeenCalledWith('run-w', 'ok', [], {
      name: 'editor',
      text: 'половина тексту',
    });
  });

  it('у профілі quick недоступний - гейт профілю спрацьовує раніше', async () => {
    const client = makeClient();
    let out: ToolExecution | null = null;
    const { engine } = scriptedEngine(async (opts) => {
      out = await opts.onToolCall('delegate', { worker: 'editor', task: 'x', format: 'чат' });
      return { finalText: 'ESCALATE: потрібен працівник' };
    });
    await makeRunner({ client, engine })(req({ profile: 'quick' }));

    expect(out!.isError).toBe(true);
    expect(steps(client)[0]).toMatchObject({ name: 'delegate', note: 'not-in-profile' });
  });

  it('аргументи не за контрактом - відмова без вигаданого імені працівника', async () => {
    const client = makeClient();
    let out: ToolExecution | null = null;
    const { engine } = scriptedEngine(async (opts) => {
      out = await opts.onToolCall('delegate', { worker: 'editor' });
      return { finalText: 'ок' };
    });
    await makeRunner({ client, engine })(req());

    expect(out!.isError).toBe(true);
    expect(out!.text).not.toContain('editor');
    expect(steps(client)[0]).toMatchObject({ name: 'delegate', note: 'bad-args' });
  });
});

describe('реєстр WORKERS - дзеркало docs/assistant/agents/*.md', () => {
  const dir = join(__dirname, '..', 'docs', 'assistant', 'agents');
  const files = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'code-reviewer.md');

  it('10 файлів (без code-reviewer - він в Actions) = 10 записів реєстру', () => {
    expect(files.map((f) => f.replace(/\.md$/, '')).sort()).toEqual(Object.keys(WORKERS).sort());
    expect(DELEGATE_WORKERS).toEqual(Object.keys(WORKERS).filter((n) => n !== 'quick'));
  });

  for (const file of files) {
    it(`${file}: модель, інструменти, стеля, tainted_output, effort - як у front-matter`, () => {
      const parsed = parseInstruction(readFileSync(join(dir, file), 'utf8'));
      if (!parsed.ok) throw new Error(`${file}: ${parsed.error}`);
      const front = parsed.front;
      const spec = WORKERS[String(front.name)]!;
      expect(spec).toBeTruthy();
      expect(spec.model).toBe(front.model);
      expect(spec.maxSteps).toBe(front.max_steps);
      expect(spec.taintedOutput).toBe(front.tainted_output);
      expect(spec.effort).toBe(front.effort);
      const tools = front.tools as string[];
      const builtin = tools.filter((t) => ['WebSearch', 'WebFetch'].includes(t));
      const ours = tools.filter((t) => !builtin.includes(t)).map((t) => t.replaceAll('.', '_'));
      expect(spec.builtinTools).toEqual(builtin);
      expect(spec.toolNames).toEqual(ours);
    });
  }

  it('опис інструмента delegate називає рівно DELEGATE_WORKERS', () => {
    const desc = TOOL_BY_MCP_NAME.get('delegate')!.description;
    for (const n of DELEGATE_WORKERS) expect(desc).toContain(n);
    expect(desc).not.toMatch(/\bquick\b/);
  });
});

describe('парність QUICK_WORKER з docs/assistant/agents/quick.md', () => {
  const raw = readFileSync(
    join(__dirname, '..', 'docs', 'assistant', 'agents', 'quick.md'),
    'utf8',
  );
  const parsed = parseInstruction(raw);
  if (!parsed.ok) throw new Error(`quick.md: ${parsed.error}`);
  const front = parsed.front;

  it('імʼя, модель, інструменти, стеля ходів і tainted_output - як у файлі', () => {
    expect(QUICK_WORKER.name).toBe(front.name);
    expect(QUICK_WORKER.model).toBe(front.model);
    expect(QUICK_WORKER.toolNames).toEqual(front.tools);
    expect(QUICK_WORKER.maxSteps).toBe(front.max_steps);
    expect(QUICK_WORKER.taintedOutput).toBe(front.tainted_output);
    expect(QUICK_WORKER.effort).toBe(front.effort);
  });

  it('профіль quick побудований з того самого опису', () => {
    expect(PROFILES.quick.model).toBe(WORKER_MODEL_IDS[QUICK_WORKER.model]);
    expect(PROFILES.quick.maxTurns).toBe(QUICK_WORKER.maxSteps);
    expect(PROFILES.quick.toolNames).toEqual(QUICK_WORKER.toolNames);
  });
});
