// Аналіз ідеї по коду в Actions (етап 4 PR-1): підпис артефакту - спільний
// збирач ядра (verifyInternalRequest приймає те, що підписав скрипт),
// аргументи claude -p з front-matter code-reviewer.md (стеля ходів, модель,
// лише Read/Grep/Glob, налаштування лише користувача), розбір виводу
// (частковий звіт на стелі ходів), кап у байтах, контекст із env (failed-режим
// лінійний), повтор POST; парність воркфлоу: inputs = WORKFLOW_INPUTS, секрети
// доїжджають до кроків (той самий клас дефекту, що workflow-env-parity),
// стеля 40 хв, пін checkout той самий, що в ci.yml.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import {
  buildTaskPrompt,
  claudeArgs,
  parseClaudeOutput,
  artifactBody,
  clipToBytes,
  readContext,
  postArtifact,
  redact,
  childEnv,
  WORKFLOW_INPUTS,
  REQUIRED_ENV,
  RUN_REQUIRED_ENV,
  IDEA_REPOS,
  ALLOWED_TOOLS,
  DISALLOWED_TOOLS,
  ARTIFACT_MD_MAX_BYTES,
  IDEA_TEXT_MAX,
  ARTIFACT_PATH,
  INSTRUCTION_FILE,
  CHILD_ENV_KEYS,
} from '../scripts/idea-analysis.mjs';
import { verifyInternalRequest, signedInternalHeaders } from '../web/core/internal/auth.mjs';
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
  TARGET_DIR: '/work/target',
  INTERNAL_API_URL: 'https://svitanok.example/',
  INTERNAL_HMAC_KEY: KEY,
  BRAIN_ACCESS_CLIENT_ID: 'cid',
  BRAIN_ACCESS_CLIENT_SECRET: 'csecret',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-token',
});
const ctxOf = (env = baseEnv()) => readContext(env, 'run');
const noSleep = async () => undefined;

describe('signedInternalHeaders (auth.mjs) - те, чим підписує скрипт', () => {
  it('ядро приймає заголовки; підпис не переноситься на інший шлях', async () => {
    const rawBody = JSON.stringify({ idea_id: 'idea-1', status: 'ok', md: '# Коротко' });
    const headers = await signedInternalHeaders(KEY, {
      method: 'POST',
      path: ARTIFACT_PATH,
      runId: 'run-ia-1',
      rawBody,
      nowMs: NOW,
      nonce: 'n-1',
      access: { clientId: 'cid', clientSecret: 'csecret' },
    });
    expect(headers['CF-Access-Client-Id']).toBe('cid');
    expect(headers['X-Internal-Signature']).toMatch(/^[0-9a-f]{64}$/);
    const verify = (path: string) =>
      verifyInternalRequest({
        method: 'POST',
        path,
        headers: new Headers(headers),
        bodyText: rawBody,
        nowMs: NOW,
        env: { INTERNAL_HMAC_KEY: KEY } as never,
      });
    expect(await verify(ARTIFACT_PATH)).toEqual({ ok: true, runId: 'run-ia-1', nonce: 'n-1' });
    expect(await verify('/internal/deliver')).toMatchObject({ ok: false, error: 'bad-signature' });
    const plain = await signedInternalHeaders(KEY, {
      method: 'POST',
      path: ARTIFACT_PATH,
      runId: 'r',
      rawBody: '{}',
      nowMs: NOW,
    });
    expect(plain['CF-Access-Client-Id']).toBeUndefined();
    expect(plain['X-Internal-Nonce']).toMatch(/^[0-9a-f-]{36}$/);
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
    const env = { ...baseEnv(), PATH: '/usr/bin', HOME: '/home/r' };
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
  it('обʼєкт result → md + meta', () => {
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
  });

  it('стеля ходів із текстом - частковий звіт з позначкою, не збій (S-7-5)', () => {
    const out = parseClaudeOutput(
      JSON.stringify({
        type: 'result',
        subtype: 'error_max_turns',
        result: '## Коротко\n- частина',
      }),
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.md.startsWith('> Не вклався')).toBe(true);
    expect(out.md).toContain('## Коротко');
    expect(out.meta.partial).toBe(true);
    expect(out.meta.num_turns).toBeNull();
  });

  it('is_error / стеля без тексту / не JSON / масив / порожньо - чесна відмова з причиною', () => {
    expect(
      parseClaudeOutput(JSON.stringify({ type: 'result', is_error: true, subtype: 'error' })),
    ).toEqual({ ok: false, reason: 'claude: error' });
    expect(
      parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'error_max_turns', result: '' })),
    ).toEqual({ ok: false, reason: 'claude: error_max_turns' });
    expect(parseClaudeOutput('not json')).toMatchObject({ ok: false, reason: /JSON/ });
    expect(parseClaudeOutput('[]')).toMatchObject({ ok: false, reason: 'без result' });
    expect(
      parseClaudeOutput(JSON.stringify({ type: 'result', subtype: 'success', result: '  ' })),
    ).toMatchObject({ ok: false, reason: 'порожній звіт' });
  });
});

describe('тіло артефакту і кап у байтах', () => {
  const ctx = { ideaId: 'idea-1', repo: 'svitanok', sha: SHA };
  it('clipToBytes рахує UTF-8 і не рубає код-поїнт', () => {
    expect(clipToBytes('абв', 4)).toBe('аб');
    expect(clipToBytes('a→b', 3)).toBe('a');
    expect(clipToBytes('😀x', 3)).toBe('');
    expect(clipToBytes('коротко', 1000)).toBe('коротко');
  });

  it('ok: md у межах ARTIFACT_MD_MAX_BYTES з позначкою обрізання; failed: reason', () => {
    const body = artifactBody(ctx, { ok: true, md: '→'.repeat(40_000) }) as {
      status: string;
      md?: string;
    };
    expect(body).toMatchObject({ status: 'ok', idea_id: 'idea-1', repo: 'svitanok', sha: SHA });
    expect(Buffer.byteLength(String(body.md), 'utf8')).toBeLessThan(ARTIFACT_MD_MAX_BYTES + 200);
    expect(String(body.md)).toContain('обрізано');
    // Разом із JSON-обгорткою - під кап тіла internal API ядра (128 KiB).
    expect(Buffer.byteLength(JSON.stringify(body), 'utf8')).toBeLessThan(128 * 1024);
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
  it('run: усі обовʼязкові змінні, репо з переліку, sha 40 hex, ідея не порожня', () => {
    expect(ctxOf()).toMatchObject({
      runId: 'run-ia-1',
      repo: 'svitanok',
      sha: SHA,
      apiUrl: 'https://svitanok.example',
      access: { clientId: 'cid', clientSecret: 'csecret' },
      targetDir: '/work/target',
    });
    expect(() => readContext({ ...baseEnv(), INTERNAL_HMAC_KEY: ' ' }, 'run')).toThrow(
      /INTERNAL_HMAC_KEY/,
    );
    expect(() => readContext({ ...baseEnv(), INTERNAL_API_URL: '' }, 'run')).toThrow(
      /INTERNAL_API_URL/,
    );
    expect(() => readContext({ ...baseEnv(), IA_REPO: 'other' }, 'run')).toThrow(/поза переліком/);
    expect(() => readContext({ ...baseEnv(), IA_SHA: 'abc' }, 'run')).toThrow(/40 hex/);
    expect(() => readContext({ ...baseEnv(), IA_IDEA: '', IA_TITLE: '' }, 'run')).toThrow(
      /порожня ідея/,
    );
    expect(() =>
      readContext({ ...baseEnv(), INTERNAL_API_URL: 'https://x.workers.dev' }, 'run'),
    ).toThrow(/workers\.dev/);
    expect(IDEA_REPOS).toEqual(['svitanok', 'portfolio', 'moviehouse', 'modern-blog']);
  });

  it('failed: лише те, без чого не повідомити ядру - кривий repo/sha не заважає', () => {
    const ctx = readContext(
      { ...baseEnv(), IA_REPO: 'other', IA_SHA: 'x', IA_IDEA: '', TARGET_DIR: '' },
      'failed',
    );
    expect(ctx).toMatchObject({ runId: 'run-ia-1', repo: 'other', sha: 'x' });
    for (const k of RUN_REQUIRED_ENV) expect(REQUIRED_ENV).not.toContain(k);
    expect(() => readContext({ ...baseEnv(), IA_RUN_ID: '' }, 'failed')).toThrow(/IA_RUN_ID/);
  });
});

describe('postArtifact', () => {
  it('підписаний POST на адресу з контексту; 4xx - виняток без повтору', async () => {
    const fetchFn = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    const status = await postArtifact(
      ctxOf(),
      { idea_id: 'idea-1', status: 'ok' },
      fetchFn as unknown as typeof fetch,
      noSleep,
    );
    expect(status).toBe(200);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://svitanok.example${ARTIFACT_PATH}`);
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Internal-Run']).toBe('run-ia-1');
    expect(headers['CF-Access-Client-Secret']).toBe('csecret');
    expect(init.body).toBe(JSON.stringify({ idea_id: 'idea-1', status: 'ok' }));

    const bad = vi.fn(async () => new Response('{"error":"run-unknown"}', { status: 403 }));
    await expect(postArtifact(ctxOf(), {}, bad as never, noSleep)).rejects.toThrow(/403/);
    expect(bad).toHaveBeenCalledTimes(1);
  });

  it('мережевий збій або 5xx - один повтор зі свіжим підписом; двічі поспіль - виняток', async () => {
    const flaky = vi
      .fn()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    expect(await postArtifact(ctxOf(), {}, flaky as never, sleep)).toBe(200);
    expect(flaky).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([5000]);
    const n1 = (flaky.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    const n2 = (flaky.mock.calls[1] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(n1['X-Internal-Nonce']).not.toBe(n2['X-Internal-Nonce']);

    const down = vi.fn(async () => new Response('', { status: 502 }));
    await expect(postArtifact(ctxOf(), {}, down as never, noSleep)).rejects.toThrow(/502/);
    expect(down).toHaveBeenCalledTimes(2);
    const dead = vi.fn(async () => {
      throw new Error('ENOTFOUND');
    });
    await expect(postArtifact(ctxOf(), {}, dead as never, noSleep)).rejects.toThrow(/недосяжний/);
  });
});

describe('redact', () => {
  it('значення токена в stderr дитини - ***', () => {
    expect(redact('auth failed for oauth-token at x', 'oauth-token')).toBe(
      'auth failed for *** at x',
    );
    expect(redact('text', '')).toBe('text');
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
  const analyze = job.steps.find((s) => s.id === 'analyze');
  const failed = job.steps.find((s) => s.run === 'node scripts/idea-analysis.mjs failed');

  it('inputs воркфлоу = WORKFLOW_INPUTS скрипта; обовʼязкові - усі, крім title', () => {
    expect(Object.keys(yml.on.workflow_dispatch.inputs).sort()).toEqual(
      [...WORKFLOW_INPUTS].sort(),
    );
    for (const [name, def] of Object.entries(yml.on.workflow_dispatch.inputs)) {
      expect(Boolean(def.required)).toBe(name !== 'title');
    }
    // Кожен input доїжджає до скрипта як IA_<INPUT>.
    for (const name of WORKFLOW_INPUTS) expect(job.env[`IA_${name.toUpperCase()}`]).toBeDefined();
  });

  it('REQUIRED_ENV доїжджають до ОБОХ кроків, RUN_REQUIRED_ENV - до analyze; секрети лише на кроках', () => {
    const jobEnv = new Set(Object.keys(job.env));
    const analyzeEnv = new Set(Object.keys(analyze?.env ?? {}));
    const failedEnv = new Set(Object.keys(failed?.env ?? {}));
    for (const name of REQUIRED_ENV) {
      expect(jobEnv.has(name) || analyzeEnv.has(name)).toBe(true);
      expect(jobEnv.has(name) || failedEnv.has(name)).toBe(true);
    }
    for (const name of RUN_REQUIRED_ENV)
      expect(jobEnv.has(name) || analyzeEnv.has(name)).toBe(true);
    for (const secret of [
      'INTERNAL_HMAC_KEY',
      'BRAIN_ACCESS_CLIENT_ID',
      'BRAIN_ACCESS_CLIENT_SECRET',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]) {
      expect(jobEnv.has(secret)).toBe(false);
    }
    expect(analyze?.env?.CLAUDE_CODE_OAUTH_TOKEN).toContain('secrets.CLAUDE_CODE_OAUTH_TOKEN');
    expect(failedEnv.has('CLAUDE_CODE_OAUTH_TOKEN')).toBe(false);
    expect(job.env.INTERNAL_API_URL).toContain('vars.INTERNAL_API_URL');
    expect(analyze?.run).toBe('node scripts/idea-analysis.mjs run');
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
    expect(failed?.if).toContain('failure()');
    expect(failed?.if).toContain("steps.analyze.outcome != 'failure'");
  });
});
