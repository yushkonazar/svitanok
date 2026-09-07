// Профіль price-check у мозку (етап 5 PR-3, 07 §5): Дослідник (sonnet,
// WebSearch/WebFetch як вбудовані, без MCP-інструментів, стеля ходів із
// front-matter), інструкція researcher; контракт /run приймає профіль; прогін:
// JSON-задача на вході → звіт текстом → подія `worker` у ланцюг через
// outcome.chain, без deliver; порожній вихід - error-крок без події.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROFILES, INSTRUCTION_NAME_BY_PROFILE, buildSystemPrompt } from '../brain/src/profiles.js';
import { RUN_REQUEST_SCHEMA } from '../brain/src/server.js';
import { makeRunner, type EngineOutcome, type EngineRunOptions } from '../brain/src/agent.js';
import type { RunOutcome } from '../brain/src/core-client.js';
import { instructionHash } from '../brain/src/instructions.js';
import { parseInstruction } from '../web/core/instructions.mjs';

const FILE = readFileSync(
  join(__dirname, '..', 'docs', 'assistant', 'agents', 'researcher.md'),
  'utf8',
);
const NOW = Date.parse('2026-09-07T07:00:00.000Z');
const BODY = '# Дослідник\nЗнайди ціни.';

function client() {
  return {
    callTool: vi.fn(async () => ({ ok: true as const, tool: 't', tainted: false, result: '{}' })),
    deliver: vi.fn(async () => undefined),
    status: vi.fn(async () => undefined),
    reportRuns: vi.fn(async (_runId: string, _steps: object[], _outcome?: RunOutcome) => undefined),
    session: vi.fn(async () => true),
    instruction: vi.fn(async () => ({
      ok: false as const,
      status: 404,
      error: 'instruction-missing',
    })),
    taint: vi.fn(async () => true),
  };
}

function runner(finalText: string | null) {
  const c = client();
  const engineRun = vi.fn(
    async (_opts: EngineRunOptions, _input: string): Promise<EngineOutcome> => ({
      finalText,
      sessionId: null,
    }),
  );
  const run = makeRunner({
    client: c,
    engine: { run: engineRun, readTranscript: async () => null },
  });
  return { c, engineRun, run };
}

const task = JSON.stringify({
  chain_id: 'ch-p',
  mode: 'price',
  task: 'Ціна HD9200',
  format: 'chat',
});

describe('профіль price-check', () => {
  it('= front-matter agents/researcher.md: sonnet, WebSearch/WebFetch вбудовані, без MCP, max_steps + 2 ходи, 4 хв', () => {
    const p = PROFILES['price-check'];
    const parsed = parseInstruction(FILE);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.front.name).toBe('researcher');
    expect(p.model).toBe('claude-sonnet-5');
    expect(p.builtinTools).toEqual(['WebSearch', 'WebFetch']);
    expect(p.toolNames).toEqual([]);
    expect(p.maxToolCalls).toBe(0);
    expect(p.maxTurns).toBe(Number(parsed.front.max_steps) + 2);
    expect(p.timeoutMs).toBe(8 * 60_000);
    expect(INSTRUCTION_NAME_BY_PROFILE['price-check']).toBe('researcher');
    expect(RUN_REQUEST_SCHEMA.shape.profile.options).toContain('price-check');
    const prompt = buildSystemPrompt(p, NOW, { instruction: BODY });
    expect(prompt.startsWith(BODY)).toBe(true);
    expect(prompt).toContain('Зараз у Києві');
  });

  it('прогін: звіт текстом → outcome.chain {id, worker, {mode: price, output: текст}}; builtinTools у рушії; deliver не кличеться', async () => {
    const { c, engineRun, run } = runner(
      '## Коротко\n- ок\n\n## Ціни\n- Comfy - 3 299 грн - є - 07.09.2026 - https://comfy.ua/x',
    );
    await run({
      run_id: 'run-p',
      profile: 'price-check',
      thread_id: '99',
      input: { text: task },
      instruction: { name: 'researcher', version_hash: instructionHash(BODY), body_md: BODY },
    });
    expect(engineRun).toHaveBeenCalledTimes(1);
    const opts = engineRun.mock.calls[0]![0];
    expect(opts.builtinTools).toEqual(['WebSearch', 'WebFetch']);
    expect(opts.toolNames).toEqual([]);
    expect(opts.resumeSessionId).toBeNull();
    expect(c.deliver).not.toHaveBeenCalled();
    const [, steps, outcome] = c.reportRuns.mock.calls.at(-1) ?? [];
    expect(outcome).toEqual({
      chain: {
        id: 'ch-p',
        event: 'worker',
        payload: {
          mode: 'price',
          output:
            '## Коротко\n- ок\n\n## Ціни\n- Comfy - 3 299 грн - є - 07.09.2026 - https://comfy.ua/x',
        },
      },
    });
    expect((steps ?? []).map((s) => (s as { name: string }).name)).toContain('chain');
  });

  it('порожній вихід - error-крок price-check без події; крива інструкція - прогін не стартує', async () => {
    const empty = runner('');
    await empty.run({
      run_id: 'run-e',
      profile: 'price-check',
      thread_id: '99',
      input: { text: task },
      instruction: { name: 'researcher', version_hash: instructionHash(BODY), body_md: BODY },
    });
    expect(empty.c.reportRuns.mock.calls.at(-1)?.[2]).toBeUndefined();
    const steps = empty.c.reportRuns.mock.calls.at(-1)?.[1] as {
      kind: string;
      name: string;
      note?: string;
    }[];
    expect(steps.find((s) => s.kind === 'error')).toMatchObject({
      name: 'price-check',
      note: 'empty-output',
    });

    const bad = runner('x');
    await bad.run({
      run_id: 'run-b',
      profile: 'price-check',
      thread_id: '99',
      input: { text: task },
      instruction: { name: 'day-planner', version_hash: instructionHash(BODY), body_md: BODY },
    });
    expect(bad.engineRun).not.toHaveBeenCalled();
  });
});
