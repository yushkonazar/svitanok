// Аналіз ідеї по коду в Actions (етап 4 PR-1): підпис артефакту в парності з
// ядром (verifyInternalRequest приймає те, що підписав скрипт), аргументи
// claude -p з front-matter code-reviewer.md (стеля ходів, модель, лише
// Read/Grep/Glob), розбір виводу, тіло артефакту з капом, контекст із env; і
// парність воркфлоу: inputs = WORKFLOW_INPUTS, секрети доїжджають до кроку
// (той самий клас дефекту, що workflow-env-parity), стеля 40 хв, пін checkout
// той самий, що в ci.yml.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  signInternal,
  signedHeaders,
  buildTaskPrompt,
  claudeArgs,
  parseClaudeOutput,
  artifactBody,
  readContext,
  postArtifact,
  WORKFLOW_INPUTS,
  REQUIRED_ENV,
  IDEA_REPOS,
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  ARTIFACT_MD_MAX,
  IDEA_TEXT_MAX,
  ARTIFACT_PATH,
  INSTRUCTION_FILE,
  CHILD_ENV_KEYS,
  childEnv,
} from '../scripts/idea-analysis.mjs';
import { verifyInternalRequest, signInternal as coreSign } from '../web/core/internal/auth.mjs';
import { parseInstruction } from '../web/core/instructions.mjs';

const ROOT = join(__dirname, '..');
const KEY = 'hmac-test-key';
const NOW = Date.parse('2026-09-06T12:00:00.000Z');
const SHA = 'a'.repeat(40);
const INSTRUCTION_RAW = readFileSync(join(ROOT, INSTRUCTION_FILE), 'utf8');

const baseEnv = () => ({
  IA_RUN_ID: 'run-ia-1',
  IA_IDEA_ID: 'idea-1',
  IA_REPO: 'svitanok',
  IA_SHA: SHA,
  IA_TITLE: 'Експорт у Sheets',
  IA_IDEA: 'кнопка експорту колекції',
  INTERNAL_HMAC_KEY: KEY,
  BRAIN_ACCESS_CLIENT_ID: 'cid',
  BRAIN_ACCESS_CLIENT_SECRET: 'csecret',
});

describe('підпис артефакту - парність із ядром (ADR-037)', () => {
  it('те саме повідомлення → той самий hex, і ядро приймає заголовки скрипта', async () => {
    const rawBody = JSON.stringify({ idea_id: 'idea-1', status: 'ok', md: '# Коротко' });
    const input = {
      method: 'POST',
      path: ARTIFACT_PATH,
      timestampMs: NOW,
      runId: 'run-ia-1',
      nonce: 'n-1',
      rawBody,
    };
    expect(signInternal(KEY, input)).toBe(await coreSign(KEY, input));

    const headers = signedHeaders(
      { hmacKey: KEY, accessClientId: 'cid', accessClientSecret: 'csecret' },
      { path: ARTIFACT_PATH, runId: 'run-ia-1', rawBody, nowMs: NOW, nonce: 'n-1' },
    );
    expect(headers['CF-Access-Client-Id']).toBe('cid');
    const verdict = await verifyInternalRequest({
      method: 'POST',
      path: ARTIFACT_PATH,
      headers: new Headers(headers),
      bodyText: rawBody,
      nowMs: NOW,
      env: { INTERNAL_HMAC_KEY: KEY } as never,
    });
    expect(verdict).toEqual({ ok: true, runId: 'run-ia-1', nonce: 'n-1' });
    // Підпис не переноситься на інший шлях (метод і шлях у повідомленні).
    const moved = await verifyInternalRequest({
      method: 'POST',
      path: '/internal/deliver',
      headers: new Headers(headers),
      bodyText: rawBody,
      nowMs: NOW,
      env: { INTERNAL_HMAC_KEY: KEY } as never,
    });
    expect(moved).toMatchObject({ ok: false, error: 'bad-signature' });
  });

  it('без Access-пари заголовків CF-Access-* немає', () => {
    const h = signedHeaders(
      { hmacKey: KEY },
      { path: ARTIFACT_PATH, runId: 'r', rawBody: '{}', nowMs: NOW },
    );
    expect(h['CF-Access-Client-Id']).toBeUndefined();
    expect(h['X-Internal-Signature']).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('claude -p: аргументи з code-reviewer.md', () => {
  const args = claudeArgs({ instructionRaw: INSTRUCTION_RAW, prompt: 'task' });
  const parsed = parseInstruction(INSTRUCTION_RAW);
  if (!parsed.ok) throw new Error(parsed.error);
  const at = (flag: string) => args[args.indexOf(flag) + 1];
  const listAfter = (flag: string) => {
    const from = args.indexOf(flag) + 1;
    const out: string[] = [];
    for (let i = from; i < args.length && !String(args[i]).startsWith('--'); i += 1) {
      out.push(String(args[i]));
    }
    return out;
  };

  it('системний промпт = тіло інструкції, стеля ходів і модель - з front-matter', () => {
    expect(at('--system-prompt')).toBe(parsed.body);
    expect(at('--max-turns')).toBe(String(parsed.front.max_steps));
    expect(parsed.front.model).toBe('sonnet');
    expect(at('--model')).toBe('claude-sonnet-5');
    expect(at('--output-format')).toBe('json');
    expect(at('-p')).toBe('task');
  });

  it('дозволені лише Read/Grep/Glob (= tools у front-matter), решта в денайлисті', () => {
    expect(listAfter('--allowedTools')).toEqual([...ALLOWED_TOOLS]);
    expect([...ALLOWED_TOOLS].sort()).toEqual([...(parsed.front.tools as string[])].sort());
    const denied = listAfter('--disallowedTools');
    expect(denied).toEqual([...DISALLOWED_TOOLS]);
    for (const t of ['Bash', 'Write', 'Edit', 'WebSearch', 'WebFetch', 'Task']) {
      expect(denied).toContain(t);
    }
    expect(denied.some((t) => ALLOWED_TOOLS.includes(t))).toBe(false);
  });

  it('налаштування лише користувача раннера і strict MCP (хуки/сервери чужого репо не вантажаться)', () => {
    expect(at('--setting-sources')).toBe('user');
    expect(args).toContain('--strict-mcp-config');
  });

  it('дочірній claude дістає лише PATH/HOME/CLAUDE_CODE_OAUTH_TOKEN - секрети ядра ні', () => {
    const env = { ...baseEnv(), PATH: '/usr/bin', HOME: '/home/r', CLAUDE_CODE_OAUTH_TOKEN: 't' };
    const child = childEnv(env);
    expect(Object.keys(child).sort()).toEqual([...CHILD_ENV_KEYS].sort());
    expect(child).not.toHaveProperty('INTERNAL_HMAC_KEY');
    expect(child).not.toHaveProperty('BRAIN_ACCESS_CLIENT_SECRET');
    expect(childEnv({ PATH: '/x' })).toEqual({ PATH: '/x' });
  });

  it('зламаний front-matter - гучна помилка, не дефолти', () => {
    expect(() => claudeArgs({ instructionRaw: 'без front-matter', prompt: 'x' })).toThrow(
      /front-matter/,
    );
    const noSteps = INSTRUCTION_RAW.replace(/^max_steps:.*$/m, 'max_steps: abc');
    expect(() => claudeArgs({ instructionRaw: noSteps, prompt: 'x' })).toThrow(/max_steps/);
  });
});

describe('задача Код-оглядачу', () => {
  it('task = {idea, repo, sha}, format md; назва попереду тексту', () => {
    const p = buildTaskPrompt({
      idea: 'кнопка експорту',
      title: 'Sheets',
      repo: 'svitanok',
      sha: SHA,
    });
    expect(p).toContain('"repo": "svitanok"');
    expect(p).toContain(`"sha": "${SHA}"`);
    expect(p).toContain('Sheets\\n\\nкнопка експорту');
    expect(p).toContain('format: md');
  });

  it('текст ідеї ріжеться під кап inputs', () => {
    const p = buildTaskPrompt({
      idea: 'а'.repeat(IDEA_TEXT_MAX + 100),
      repo: 'svitanok',
      sha: SHA,
    });
    expect(JSON.parse(p.split('\n').slice(1, -2).join('\n')).idea.length).toBe(IDEA_TEXT_MAX);
  });
});

describe('вивід claude -p --output-format json', () => {
  it('обʼєкт result → md + meta; масив → останній result', () => {
    const ok = parseClaudeOutput(
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        result: '## Коротко\n- є',
        num_turns: 12,
        duration_ms: 90,
      }),
    );
    expect(ok).toEqual({
      ok: true,
      md: '## Коротко\n- є',
      meta: { num_turns: 12, duration_ms: 90 },
    });
    const arr = parseClaudeOutput(
      JSON.stringify([{ type: 'system' }, { type: 'result', subtype: 'success', result: 'звіт' }]),
    );
    expect(arr).toMatchObject({ ok: true, md: 'звіт' });
  });

  it('is_error / error_max_turns / не JSON / порожньо - чесна відмова з причиною', () => {
    expect(
      parseClaudeOutput(JSON.stringify({ type: 'result', is_error: true, subtype: 'error' })),
    ).toEqual({
      ok: false,
      reason: 'claude: error',
    });
    expect(
      parseClaudeOutput(
        JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: 'x' }),
      ),
    ).toEqual({
      ok: false,
      reason: 'claude: error_max_turns',
    });
    expect(parseClaudeOutput('not json')).toMatchObject({ ok: false, reason: /JSON/ });
    expect(
      parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'success', result: '  ' })),
    ).toMatchObject({
      ok: false,
      reason: 'порожній звіт',
    });
  });
});

describe('тіло артефакту', () => {
  const ctx = { ideaId: 'idea-1', repo: 'svitanok', sha: SHA };
  it('ok: md з капом і позначкою обрізання; failed: reason', () => {
    const body = artifactBody(ctx, { ok: true, md: 'б'.repeat(ARTIFACT_MD_MAX + 10) }) as {
      status: string;
      md?: string;
    };
    expect(body).toMatchObject({ status: 'ok', idea_id: 'idea-1', repo: 'svitanok', sha: SHA });
    expect(String(body.md).length).toBeLessThan(ARTIFACT_MD_MAX + 100);
    expect(String(body.md)).toContain('обрізано');
    expect(artifactBody(ctx, { ok: true, md: 'коротко' })).toMatchObject({ md: 'коротко' });
    expect(artifactBody(ctx, { ok: false, reason: 'таймаут' })).toEqual({
      idea_id: 'idea-1',
      repo: 'svitanok',
      sha: SHA,
      status: 'failed',
      reason: 'таймаут',
    });
  });
});

describe('контекст із env', () => {
  it('усі обовʼязкові змінні, репо з переліку, sha 40 hex', () => {
    expect(readContext(baseEnv())).toMatchObject({ runId: 'run-ia-1', repo: 'svitanok', sha: SHA });
    expect(() => readContext({ ...baseEnv(), INTERNAL_HMAC_KEY: ' ' })).toThrow(
      /INTERNAL_HMAC_KEY/,
    );
    expect(() => readContext({ ...baseEnv(), IA_REPO: 'other' })).toThrow(/поза переліком/);
    expect(() => readContext({ ...baseEnv(), IA_SHA: 'abc' })).toThrow(/40 hex/);
    expect(IDEA_REPOS).toEqual(['svitanok', 'portfolio', 'moviehouse', 'modern-blog']);
  });
});

describe('postArtifact', () => {
  it('підписаний POST на кастомний домен; не-2xx - виняток; workers.dev - відмова', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const status = await postArtifact(
      { ...baseEnv(), INTERNAL_API_URL: 'https://svitanok.example/' },
      { idea_id: 'idea-1', status: 'ok' },
      fetchFn as unknown as typeof fetch,
    );
    expect(status).toBe(200);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://svitanok.example${ARTIFACT_PATH}`);
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Internal-Run']).toBe('run-ia-1');
    expect(headers['CF-Access-Client-Secret']).toBe('csecret');
    expect(init.body).toBe(JSON.stringify({ idea_id: 'idea-1', status: 'ok' }));

    const bad = vi.fn(async () => new Response('{"error":"run-unknown"}', { status: 403 }));
    await expect(
      postArtifact(
        { ...baseEnv(), INTERNAL_API_URL: 'https://svitanok.example' },
        {},
        bad as never,
      ),
    ).rejects.toThrow(/403/);
    await expect(
      postArtifact(
        { ...baseEnv(), INTERNAL_API_URL: 'https://x.workers.dev' },
        {},
        fetchFn as never,
      ),
    ).rejects.toThrow(/workers\.dev/);
  });
});

describe('idea-analysis.yml - парність зі скриптом і ci.yml', () => {
  const raw = readFileSync(join(ROOT, '.github', 'workflows', 'idea-analysis.yml'), 'utf8');
  const yml = load(raw) as {
    on: { workflow_dispatch: { inputs: Record<string, { required?: boolean }> } };
    permissions: unknown;
    jobs: {
      analyze: {
        'timeout-minutes': number;
        env: Record<string, string>;
        steps: {
          uses?: string;
          id?: string;
          if?: string;
          env?: Record<string, string>;
          run?: string;
        }[];
      };
    };
  };
  const job = yml.jobs.analyze;

  it('inputs воркфлоу = WORKFLOW_INPUTS скрипта; обовʼязкові - усі, крім title', () => {
    expect(Object.keys(yml.on.workflow_dispatch.inputs).sort()).toEqual(
      [...WORKFLOW_INPUTS].sort(),
    );
    for (const [name, def] of Object.entries(yml.on.workflow_dispatch.inputs)) {
      expect(Boolean(def.required)).toBe(name !== 'title');
    }
  });

  it('усі REQUIRED_ENV скрипта і CLAUDE_CODE_OAUTH_TOKEN доїжджають до кроків', () => {
    const jobEnv = new Set(Object.keys(job.env));
    const analyzeEnv = new Set(Object.keys(job.steps.find((s) => s.id === 'analyze')?.env ?? {}));
    const failedEnv = new Set(
      Object.keys(
        job.steps.find((s) => s.run === 'node scripts/idea-analysis.mjs failed')?.env ?? {},
      ),
    );
    for (const name of REQUIRED_ENV) {
      expect(jobEnv.has(name) || analyzeEnv.has(name)).toBe(true);
      expect(jobEnv.has(name) || failedEnv.has(name)).toBe(true);
    }
    // Секрети ядра - лише на кроках, що постять артефакт, не в env усього job
    // (security-ревʼю PR-1).
    for (const secret of [
      'INTERNAL_HMAC_KEY',
      'BRAIN_ACCESS_CLIENT_ID',
      'BRAIN_ACCESS_CLIENT_SECRET',
    ]) {
      expect(jobEnv.has(secret)).toBe(false);
    }
    const strip = job.steps.find((s) => s.run?.startsWith('rm -rf target/.claude'));
    expect(strip?.run).toContain('target/.mcp.json');
    expect(job.steps.indexOf(strip!)).toBeLessThan(job.steps.findIndex((s) => s.id === 'analyze'));
    const analyze = job.steps.find((s) => s.id === 'analyze');
    expect(analyze?.env?.CLAUDE_CODE_OAUTH_TOKEN).toContain('secrets.CLAUDE_CODE_OAUTH_TOKEN');
    expect(analyze?.run).toBe('node scripts/idea-analysis.mjs run');
    // Секрет для аналізу - лише в кроці аналізу, не в env усього job.
    expect(jobEnv.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
  });

  it('стеля 40 хв, permissions: {}, checkout пінено тим самим sha, що в ci.yml, failed-крок є', () => {
    expect(job['timeout-minutes']).toBe(40);
    expect(yml.permissions).toEqual({});
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    const pin = /actions\/checkout@([0-9a-f]{40})/.exec(ci)?.[1];
    expect(pin).toBeTruthy();
    const checkouts = job.steps.filter((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkouts).toHaveLength(2);
    for (const s of checkouts) expect(s.uses).toBe(`actions/checkout@${pin}`);
    const failed = job.steps.find((s) => s.run === 'node scripts/idea-analysis.mjs failed');
    expect(failed?.if).toContain('failure()');
    expect(failed?.if).toContain("steps.analyze.outcome != 'failure'");
  });
});
