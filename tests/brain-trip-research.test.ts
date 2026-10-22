import { describe, expect, it, vi } from 'vitest';
import { makeRunner, type EngineOutcome, type EngineRunOptions } from '../brain/src/agent.js';
import { PROFILES, buildSystemPrompt, INSTRUCTION_NAME_BY_PROFILE } from '../brain/src/profiles.js';
import { RUN_REQUEST_SCHEMA } from '../brain/src/server.js';
import { instructionHash } from '../brain/src/instructions.js';
import type { RunOutcome } from '../brain/src/core-client.js';

const BODY = '# Дослідник\nПоверни перевірені варіанти з джерелами.';
function setup(
  finalText: string | null = '{"options":[],"summary":"Немає перевірених пропозицій"}',
) {
  const client = {
    callTool: vi.fn(async () => ({ ok: true as const, tool: 't', tainted: false, result: {} })),
    deliver: vi.fn(async () => undefined),
    status: vi.fn(async () => undefined),
    session: vi.fn(async () => true),
    instruction: vi.fn(async () => ({ ok: false as const, status: 404, error: 'missing' })),
    taint: vi.fn(async () => true),
    reportRuns: vi.fn(async (_id: string, _steps: object[], _outcome?: RunOutcome) => undefined),
  };
  const engineRun = vi.fn(
    async (_options: EngineRunOptions, _text: string): Promise<EngineOutcome> => ({
      finalText,
      sessionId: null,
    }),
  );
  const runner = makeRunner({
    client,
    engine: { run: engineRun, readTranscript: async () => null },
  });
  const request = {
    run_id: 'trip-run',
    profile: 'trip-research' as const,
    thread_id: 'trip-scope',
    tainted: true,
    input: {
      text: JSON.stringify({
        request_id: 'trip-run',
        kind: 'transport',
        owner_answers: { to: 'Прага' },
      }),
    },
    instruction: { name: 'researcher', version_hash: instructionHash(BODY), body_md: BODY },
  };
  return { client, engineRun, runner, request };
}
describe('Mini App trip research worker', () => {
  it('uses web search without write tools, thread memory or chat formatting', () => {
    const profile = PROFILES['trip-research'];
    expect(profile.toolNames).toEqual([]);
    expect(profile.builtinTools).toEqual(['WebSearch', 'WebFetch']);
    expect(profile.timeoutMs).toBe(8 * 60_000);
    expect(INSTRUCTION_NAME_BY_PROFILE['trip-research']).toBe('researcher');
    expect(RUN_REQUEST_SCHEMA.shape.profile.options).toContain('trip-research');
    expect(
      buildSystemPrompt(profile, Date.now(), { instruction: BODY, summary: 'private old chat' }),
    ).not.toContain('private old chat');
  });
  it('returns structured results to the matching request and does not send Telegram messages', async () => {
    const f = setup();
    await f.runner(f.request);
    expect(f.engineRun.mock.calls[0]?.[0]).toMatchObject({
      builtinTools: ['WebSearch', 'WebFetch'],
      toolNames: [],
      resumeSessionId: null,
    });
    expect(f.client.reportRuns.mock.calls.at(-1)?.[2]).toEqual({
      trip_research: {
        request_id: 'trip-run',
        output: { options: [], summary: 'Немає перевірених пропозицій' },
      },
    });
    expect(f.client.deliver).not.toHaveBeenCalled();
    expect(f.client.callTool).not.toHaveBeenCalled();
    expect(f.client.session).not.toHaveBeenCalled();
  });
  it.each(['', 'not JSON', null])(
    'reports malformed results through completion, without chat delivery: %s',
    async (text) => {
      const f = setup(text);
      await f.runner(f.request);
      expect(f.client.reportRuns.mock.calls.at(-1)?.[1]).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'error' })]),
      );
      expect(f.client.reportRuns.mock.calls.at(-1)?.[2]).toBeUndefined();
      expect(f.client.deliver).not.toHaveBeenCalled();
    },
  );
  it('refuses a mismatched request id and an unverified instruction without any chat output', async () => {
    const f = setup();
    await f.runner({ ...f.request, input: { text: '{"request_id":"other-run"}' } });
    expect(f.client.reportRuns.mock.calls.at(-1)?.[2]).toBeUndefined();
    expect(f.client.deliver).not.toHaveBeenCalled();
    const invalid = setup();
    await invalid.runner({
      ...invalid.request,
      instruction: { ...invalid.request.instruction, version_hash: 'bad' },
    });
    expect(invalid.engineRun).not.toHaveBeenCalled();
    expect(invalid.client.deliver).not.toHaveBeenCalled();
    expect(invalid.client.reportRuns.mock.calls.at(-1)?.[1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'error', name: 'instruction' })]),
    );
  });
});
