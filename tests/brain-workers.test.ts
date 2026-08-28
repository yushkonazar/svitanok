// Працівники (етап 2 PR-8): профіль quick іде шляхом працівника, а delegate
// описаний і чесно відмовляє, поки файлів працівників немає (етап 4).
// Перевіряється саме те, чим цей шлях відрізняється від звичайного прогону:
// свіжа сесія, модель і стеля ходів із front-matter, відсутність походу в
// ядро на внутрішньому інструменті і слід у телеметрії з іменем працівника.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi, type Mock } from 'vitest';
import { makeRunner, type EngineOutcome, type EngineRunOptions } from '../brain/src/agent.js';
import { QUICK_WORKER, WORKER_MODEL_IDS, runWorker } from '../brain/src/workers.js';
import { PROFILES } from '../brain/src/profiles.js';
import { instructionHash } from '../brain/src/instructions.js';
import type { ToolCallOutcome } from '../brain/src/core-client.js';
import type { RunRequest } from '../brain/src/server.js';
import { parseInstruction } from '../web/core/instructions.mjs';

const BODY = 'Ти - Світанок. Відповідай коротко.';

interface ClientMock {
  callTool: Mock<(runId: string, coreName: string, args: unknown) => Promise<ToolCallOutcome>>;
  deliver: Mock<(runId: string, text: string) => Promise<void>>;
  status: Mock<(runId: string, messageId: number, text: string) => Promise<void>>;
  reportRuns: Mock<(runId: string, steps: object[]) => Promise<void>>;
  session: Mock<(runId: string, body: Record<string, unknown>) => Promise<boolean>>;
}

function makeClient(): ClientMock {
  return {
    callTool: vi.fn(async () => ({ ok: true as const, tool: 't', tainted: false, result: 'дані' })),
    deliver: vi.fn(async () => undefined),
    status: vi.fn(async () => undefined),
    reportRuns: vi.fn(async () => undefined),
    session: vi.fn(async () => true),
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
});

describe('профіль quick як працівник', () => {
  it('модель, стеля ходів і відсутність інструментів - з опису quick', async () => {
    const client = makeClient();
    const { engine, seen } = scriptedEngine(async () => ({ finalText: '4' }));
    await makeRunner({ client, engine })(req({ profile: 'quick' }));

    expect(seen[0]!.model).toBe(WORKER_MODEL_IDS[QUICK_WORKER.model]);
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

describe('delegate', () => {
  it('чесно відмовляє, у ядро не йде, а імʼя працівника лишає в телеметрії', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async (opts) => {
      const out = await opts.onToolCall('delegate', {
        worker: 'researcher',
        task: 'правила вʼїзду в Польщу',
        format: 'чат',
      });
      expect(out.isError).toBe(true);
      expect(out.text).toContain('researcher');
      expect(out.text).toContain('сам');
      return { finalText: 'Зробив сам.' };
    });
    await makeRunner({ client, engine })(req());

    // Внутрішній інструмент не має виконавця в ядрі - походу туди бути не може.
    expect(client.callTool).not.toHaveBeenCalled();
    expect(steps(client)[0]).toMatchObject({
      kind: 'tool',
      name: 'delegate',
      ok: false,
      note: 'worker-unavailable:researcher',
    });
  });

  it('у профілі quick недоступний - гейт профілю спрацьовує раніше', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async (opts) => {
      const out = await opts.onToolCall('delegate', { worker: 'editor', task: 'x', format: 'чат' });
      expect(out.isError).toBe(true);
      return { finalText: 'ESCALATE: потрібен працівник' };
    });
    await makeRunner({ client, engine })(req({ profile: 'quick' }));

    expect(steps(client)[0]).toMatchObject({ name: 'delegate', note: 'not-in-profile' });
  });

  it('аргументи не за контрактом - відмова без вигаданого імені працівника', async () => {
    const client = makeClient();
    const { engine } = scriptedEngine(async (opts) => {
      const out = await opts.onToolCall('delegate', { worker: 'editor' });
      expect(out.isError).toBe(true);
      return { finalText: 'ок' };
    });
    await makeRunner({ client, engine })(req());

    expect(steps(client)[0]).toMatchObject({ name: 'delegate', note: 'bad-args' });
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
  });

  it('профіль quick побудований з того самого опису', () => {
    expect(PROFILES.quick.model).toBe(WORKER_MODEL_IDS[QUICK_WORKER.model]);
    expect(PROFILES.quick.maxTurns).toBe(QUICK_WORKER.maxSteps);
    expect(PROFILES.quick.toolNames).toEqual(QUICK_WORKER.toolNames);
  });
});
