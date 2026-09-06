// Профіль day-planner у мозку (етап 3 PR-8): Sonnet, 6 інструментів = tools
// з front-matter agents/day-planner.md ∩ описані (routes.eta описаний з
// етапу 5 PR-1 - тепер у профілі); контракт /run; прогін: JSON-задача на вході →
// вихід (JSON або текст) іде НЕ в deliver, а подією `worker` у ланцюг через
// outcome.chain; крива задача чи порожній вихід - error-крок без події.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  PROFILES,
  INSTRUCTION_NAME_BY_PROFILE,
  buildSystemPrompt,
  DAY_PLANNER_TOOL_NAMES,
} from '../brain/src/profiles.js';
import { RUN_REQUEST_SCHEMA } from '../brain/src/server.js';
import {
  makeRunner,
  parseTaskInput,
  parseJsonOutput,
  type EngineRunOptions,
  type EngineOutcome,
} from '../brain/src/agent.js';
import { instructionHash } from '../brain/src/instructions.js';
import { TOOL_BY_CORE_NAME } from '../brain/src/tools/schemas.js';
import type { RunOutcome } from '../brain/src/core-client.js';
import { parseInstruction } from '../web/core/instructions.mjs';

const FILE = readFileSync(
  join(__dirname, '..', 'docs', 'assistant', 'agents', 'day-planner.md'),
  'utf8',
);
const NOW = Date.parse('2026-09-06T17:30:00.000Z');
const BODY = '# Денний\nРозбери намір на пункти.';

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

const task = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    chain_id: 'ch-1',
    mode: 'intent',
    date: '2026-09-07',
    task: { text: 'банк' },
    format: 'json',
    ...over,
  });

describe('профіль day-planner', () => {
  it('Sonnet, 6 інструментів, 3 хв; інструменти = front-matter ∩ описані (з routes.eta, етап 5)', () => {
    const p = PROFILES['day-planner'];
    expect(p).toMatchObject({ model: 'claude-sonnet-5', maxToolCalls: 6, timeoutMs: 3 * 60_000 });
    const parsed = parseInstruction(FILE);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.front.name).toBe('day-planner');
    const fromFile = (parsed.front.tools as string[]).map((t) => t.replaceAll('.', '_'));
    expect([...DAY_PLANNER_TOOL_NAMES]).toEqual(fromFile);
    const described = fromFile.filter((n) => TOOL_BY_CORE_NAME.has(n.replaceAll('_', '.')));
    expect(p.toolNames).toEqual(described);
    expect(p.toolNames).toEqual(['calendar_read', 'data_read', 'facts_get', 'routes_eta']);
  });

  it('контракт /run приймає day-planner; інструкція day-planner; промпт із датою, без згортки', () => {
    expect(RUN_REQUEST_SCHEMA.shape.profile.options).toContain('day-planner');
    expect(INSTRUCTION_NAME_BY_PROFILE['day-planner']).toBe('day-planner');
    const prompt = buildSystemPrompt(PROFILES['day-planner'], NOW, {
      instruction: '# Денний',
      summary: 'згортка, якої тут не має бути',
    });
    expect(prompt).toContain('# Денний');
    expect(prompt).toContain('Зараз у Києві');
    expect(prompt).not.toContain('згортка');
  });

  it('прогін intent: JSON у ```json``` → outcome.chain {id, worker, {mode, output}}; deliver не кличеться; сесія не пишеться', async () => {
    const { c, engineRun, run } = runner(
      '```json\n{"items":[{"title":"Банк","kind":"errand"}]}\n```',
    );
    await run({
      run_id: 'run-d',
      profile: 'day-planner',
      thread_id: '99',
      input: { text: task() },
      instruction: { name: 'day-planner', version_hash: instructionHash(BODY), body_md: BODY },
    });
    expect(engineRun).toHaveBeenCalledTimes(1);
    expect(engineRun.mock.calls[0]?.[0].resumeSessionId).toBeNull();
    expect(engineRun.mock.calls[0]?.[1]).toBe(task());
    expect(c.deliver).not.toHaveBeenCalled();
    expect(c.session).not.toHaveBeenCalled();
    const [runId, steps, outcome] = c.reportRuns.mock.calls.at(-1) ?? [];
    expect(runId).toBe('run-d');
    expect(outcome).toEqual({
      chain: {
        id: 'ch-1',
        event: 'worker',
        payload: { mode: 'intent', output: { items: [{ title: 'Банк', kind: 'errand' }] } },
      },
    });
    expect((steps ?? []).map((s) => (s as { kind: string; name: string }).name)).toContain('chain');
  });

  it('прогін explain (format=chat): текст як є; крива задача або порожній вихід - error-крок, без події', async () => {
    const explain = runner('11:00-12:30 Презентація · глибокий блок');
    await explain.run({
      run_id: 'run-e',
      profile: 'day-planner',
      thread_id: '99',
      input: { text: task({ mode: 'explain', format: 'chat' }) },
      instruction: { name: 'day-planner', version_hash: instructionHash(BODY), body_md: BODY },
    });
    expect(explain.c.reportRuns.mock.calls.at(-1)?.[2]).toEqual({
      chain: {
        id: 'ch-1',
        event: 'worker',
        payload: { mode: 'explain', output: '11:00-12:30 Презентація · глибокий блок' },
      },
    });

    const bad = runner('{"items":[]}');
    await bad.run({
      run_id: 'run-b',
      profile: 'day-planner',
      thread_id: '99',
      input: { text: 'просто текст, не задача' },
      instruction: { name: 'day-planner', version_hash: instructionHash(BODY), body_md: BODY },
    });
    const [, badSteps, badOutcome] = bad.c.reportRuns.mock.calls.at(-1) ?? [];
    expect(badOutcome).toBeUndefined();
    expect(badSteps?.some((s) => (s as { note?: string }).note === 'bad-task')).toBe(true);

    const empty = runner('не JSON');
    await empty.run({
      run_id: 'run-n',
      profile: 'day-planner',
      thread_id: '99',
      input: { text: task() },
      instruction: { name: 'day-planner', version_hash: instructionHash(BODY), body_md: BODY },
    });
    const [, emptySteps, emptyOutcome] = empty.c.reportRuns.mock.calls.at(-1) ?? [];
    expect(emptyOutcome).toBeUndefined();
    expect(emptySteps?.some((s) => (s as { note?: string }).note === 'empty-output')).toBe(true);
  });

  it('чужа інструкція (persona) для day-planner - відмова без запуску рушія', async () => {
    const { engineRun, run, c } = runner('{}');
    await run({
      run_id: 'run-x',
      profile: 'day-planner',
      thread_id: '99',
      input: { text: task() },
      instruction: { name: 'persona', version_hash: instructionHash(BODY), body_md: BODY },
    });
    expect(engineRun).not.toHaveBeenCalled();
    expect(c.reportRuns.mock.calls.at(-1)?.[2]).toBeUndefined();
  });

  it('parseTaskInput / parseJsonOutput', () => {
    expect(parseTaskInput(task())).toEqual({ chain_id: 'ch-1', mode: 'intent', format: 'json' });
    expect(parseTaskInput(task({ format: 'chat' }))?.format).toBe('chat');
    expect(parseTaskInput(task({ chain_id: 'з пробілом і кирилицею' }))).toBeNull();
    expect(parseTaskInput(task({ mode: '' }))).toBeNull();
    expect(parseTaskInput('не json')).toBeNull();
    expect(parseJsonOutput('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonOutput('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonOutput('[1]')).toBeNull();
    expect(parseJsonOutput('текст')).toBeNull();
  });
});
