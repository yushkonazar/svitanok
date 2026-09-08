// Аналіз ідеї по коду в ядрі (етап 4 PR-2, S-3-3…S-3-5, S-3-8): репо і кеш
// sha (startIdeaAnalysis на справжніх міграціях), машина станів IdeaAnalysis
// на фейкових step/io (ok → Drive → зберегти + документ; failed/таймаут →
// статус назад + алерт; «↩» → результат відкинуто; збій dispatch), маршрут
// POST /internal/artifact (підпис → ланцюг за run_id → подія; прогін закриває
// лише Workflow), кнопка m:ia: у prerouter з «↩», адреса DM, парність із
// wrangler/worker.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IDEA_REPOS,
  DISPATCH_INPUTS,
  ANALYSIS_MD_MAX,
  ANALYSIS_RUN_STALE_MS,
  WAIT_ARTIFACT_MS,
  CHAIN_KIND,
  resolveRepo,
  shortOf,
  clipAnalysis,
  ddmm,
  targetOf,
  fetchHeadSha,
  dispatchIdeaAnalysis,
  startIdeaAnalysis,
  runIdeaAnalysisChain,
  findAnalysisByRun,
  findRunningAnalysis,
  cancelAnalysis,
  rerunButton,
  analysisFilename,
} from '../web/core/ideas/analysis.mjs';
import { runIdeasCreate, findIdea, IDEA_TEXT_MAX } from '../web/core/tools/ideas.mjs';
import { applyPolicy, resolveUndo } from '../web/core/policy/proposals.mjs';
import { handleInternal } from '../web/core/internal/router.mjs';
import { signInternal, signedInternalHeaders } from '../web/core/internal/auth.mjs';
import { ARTIFACT_SCHEMA, validateAgainst } from '../web/core/internal/schemas.mjs';
import { handleBrainCallback, rerunText } from '../web/core/prerouter.mjs';
import { RUN_STALE_MS } from '../web/core/run-registry/client.mjs';
import { WORKFLOW_INPUTS, ARTIFACT_MD_MAX_BYTES } from '../scripts/idea-analysis.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const ROOT = join(__dirname, '..');
const NOW = Date.parse('2026-09-06T10:00:00.000Z');
const SHA = 'b'.repeat(40);
const SHA2 = 'c'.repeat(40);
const KEY = 'artifact-test-key';
const MIGRATIONS = [
  '0001_base.sql',
  '0002_assistant.sql',
  '0003_telemetry.sql',
  '0004_ideas_travel.sql',
  '0008_fts.sql',
  '0011_ideas_number.sql',
];

type Params = Parameters<typeof runIdeaAnalysisChain>[1];
type Step = Parameters<typeof runIdeaAnalysisChain>[2];
type Io = Parameters<typeof runIdeaAnalysisChain>[3];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function fakeWorkflow() {
  const created: { id: string; params: Params }[] = [];
  const events: { id: string; ev: unknown }[] = [];
  let reject = false;
  let createFails = false;
  return {
    created,
    events,
    setReject: (v: boolean) => void (reject = v),
    setCreateFails: (v: boolean) => void (createFails = v),
    binding: {
      create: async (o: { id: string; params: Params }) => {
        if (createFails) throw new Error('workflows down');
        created.push(o);
      },
      get: async (id: string) => ({
        sendEvent: async (ev: unknown) => {
          if (reject) throw new Error('instance not waiting');
          events.push({ id, ev });
        },
      }),
    } as unknown as Env['IDEA_ANALYSIS'],
  };
}

function fakeRegistry() {
  const begins: Record<string, unknown>[] = [];
  const finishes: { id: string; patch: Record<string, unknown> }[] = [];
  const active = new Set<string>();
  const stub = {
    begin: async (run: Record<string, unknown>) => {
      begins.push(run);
      active.add(String(run.id));
    },
    finish: async (id: string, patch: Record<string, unknown>) => {
      finishes.push({ id, patch });
      active.delete(id);
      return null;
    },
    has: async (id: string) => active.has(id),
    consumeNonce: async () => true,
    runInfo: async () => null,
  };
  return { begins, finishes, active, ns: { getByName: () => stub } };
}

/** GitHub API: HEAD → sha, dispatch → 204; Telegram → ok. */
function stubFetch(opts: { sha?: string; dispatchStatus?: number; headStatus?: number } = {}) {
  const gh: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const tg: { method: string; form: FormData | Record<string, unknown> }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('api.github.com')) {
        gh.push({
          url: u,
          body: init?.body ? JSON.parse(String(init.body)) : null,
          headers: (init?.headers ?? {}) as Record<string, string>,
        });
        if (u.includes('/commits/HEAD')) {
          return new Response(opts.sha ?? SHA, { status: opts.headStatus ?? 200 });
        }
        const st = opts.dispatchStatus ?? 204;
        return new Response(st === 204 ? null : '', { status: st });
      }
      if (u.includes('api.telegram.org')) {
        const method = u.split('/').pop() ?? '';
        const form =
          init?.body instanceof FormData
            ? init.body
            : (JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
        tg.push({ method, form });
        return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), {
          status: 200,
        });
      }
      throw new Error(`несподіваний fetch: ${u}`);
    }),
  );
  return { gh, tg };
}

function setup(over: Partial<Env> = {}) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const wf = fakeWorkflow();
  const reg = fakeRegistry();
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    DB: d1.stub,
    TELEGRAM_BOT_TOKEN: 'bot',
    TELEGRAM_CHAT_ID: '555',
    TELEGRAM_OWNER_USER_ID: '777',
    TOPIC_ASSISTANT: '99',
    TOPIC_SYSTEM: '77',
    REPO_READ_PAT: 'pat',
    GH_DISPATCH_TOKEN: 'dispatch',
    GH_REPO: 'owner/svitanok',
    INTERNAL_HMAC_KEY: KEY,
    IDEA_ANALYSIS: wf.binding,
    RUN_REGISTRY: reg.ns,
    ...over,
  });
  return { d1, db: d1.db, env, wf, reg };
}

async function createIdea(env: Env, over: Record<string, unknown> = {}) {
  const { result } = await runIdeasCreate(
    env,
    { title: 'Експорт у Sheets', body_md: 'кнопка експорту', domain: 'svitanok', ...over },
    NOW,
  );
  return (await findIdea(env, result.id))!;
}

const ctx = { chatId: 555, threadId: 99 };
const IDEA_STATUS = () => 'SELECT status FROM ideas';

/**
 * Дзеркало isValidStepConfig рушія Workflows (workers-sdk/workflows-shared):
 * retries.limit ≥ 0, retries.delay ОБОВʼЯЗКОВИЙ (число мс або рядок тривалості),
 * timeout не 0. У проді неправильний конфіг = WorkflowFatalError на кроці.
 */
function assertStepConfig(name: string, cfg: unknown) {
  const c = cfg as { retries?: Record<string, unknown>; timeout?: unknown };
  if (c.retries) {
    const { limit, delay } = c.retries;
    if (typeof limit !== 'number' || limit < 0) throw new Error(`step ${name}: retries.limit`);
    if (!(typeof delay === 'number' || typeof delay === 'string'))
      throw new Error(`step ${name}: retries.delay обовʼязковий`);
  }
  if (c.timeout === 0) throw new Error(`step ${name}: timeout 0`);
}

/** Кроки Workflow: do виконує одразу (з конфігом або без); artifact - з черги (Error = таймаут). */
function fakeStep(events: ({ payload: unknown } | Error)[]) {
  const log: string[] = [];
  const cfgs: Record<string, unknown> = {};
  const step: Step = {
    do: async (name, cfgOrFn, fn) => {
      log.push(`do:${name}`);
      if (typeof cfgOrFn === 'function') return cfgOrFn();
      assertStepConfig(name, cfgOrFn);
      cfgs[name] = cfgOrFn;
      return fn!();
    },
    waitForEvent: async (name, { type, timeout }) => {
      log.push(`wait:${name}:${type}:${timeout}`);
      const next = events.shift();
      if (!next) throw new Error('timeout');
      if (next instanceof Error) throw next;
      return next as { payload: unknown };
    },
  };
  return { step, log, cfgs };
}

function fakeIo(over: Partial<Io> & { dispatchFails?: boolean; driveId?: string | null } = {}) {
  const sent: string[] = [];
  const docs: { filename: string; content: string; caption: string }[] = [];
  const alerts: string[] = [];
  const dispatched: Record<string, string>[] = [];
  const finished: { runId: string; error: string | null }[] = [];
  const io: Io = {
    now: () => NOW + 60_000,
    send: async (text) => void sent.push(text),
    sendDocument: async (filename, content, caption) =>
      void docs.push({ filename, content, caption }),
    alert: async (text) => void alerts.push(text),
    dispatch: async (inputs) => {
      if (over.dispatchFails) throw new Error('dispatch 403: forbidden');
      dispatched.push(inputs);
    },
    uploadDrive: async () => (over.driveId === undefined ? 'drive-1' : over.driveId),
    finishRun: async (runId, error) => void finished.push({ runId, error }),
    ...over,
  };
  return { io, sent, docs, alerts, dispatched, finished };
}

const REPORT = `## Коротко
- Колекції в D1, Sheets-API немає.
- L - нова залежність + скоуп.
- Ризик: consent.

## Аналіз
- факт - \`web/x.mjs:1\`
`;

describe('чисті помічники', () => {
  it('resolveRepo: аргумент → колонка → domain-репо; чуже - S-3-8; нічого - питання', () => {
    expect(resolveRepo({ repo: null, domain: 'svitanok' }, undefined)).toBe('svitanok');
    expect(resolveRepo({ repo: 'portfolio', domain: 'інше' }, '')).toBe('portfolio');
    expect(resolveRepo({ repo: 'portfolio', domain: 'інше' }, 'moviehouse')).toBe('moviehouse');
    expect(() => resolveRepo({ repo: null, domain: 'інше' }, undefined)).toThrow(/вкажи repo/);
    expect(() => resolveRepo({ repo: null, domain: 'svitanok' }, 'secret-repo')).toThrow(
      'Доступ є лише до svitanok, portfolio, moviehouse, modern-blog - не до «secret-repo»',
    );
  });

  it('shortOf, clipAnalysis, ddmm, filename, кнопка, тексти', () => {
    expect(shortOf(REPORT)).toBe(
      '- Колекції в D1, Sheets-API немає.\n- L - нова залежність + скоуп.\n- Ризик: consent.',
    );
    expect(shortOf('просто текст')).toBe('просто текст');
    expect(shortOf(`## Коротко\n${'а'.repeat(700)}\n\n## Аналіз\n- x`).length).toBe(600);
    const clipped = clipAnalysis('д'.repeat(ANALYSIS_MD_MAX + 5));
    expect(clipped.length).toBe(ANALYSIS_MD_MAX);
    expect(clipped.endsWith('повний - у документі й Drive)')).toBe(true);
    expect(clipAnalysis('коротко')).toBe('коротко');
    expect(ANALYSIS_MD_MAX).toBe(IDEA_TEXT_MAX);
    expect(ddmm('2026-09-05T12:00:00Z')).toBe('05.09');
    expect(ddmm(null)).toBe('?');
    expect(analysisFilename(12)).toBe('idea-12-analysis.md');
    expect(rerunButton('idea-1')).toEqual([
      [{ text: '🔁 Все одно запустити', callback_data: 'm:ia:idea-1' }],
    ]);
    expect(
      rerunText({ started: true, number: 3, repo: 'svitanok', sha: 'abc1234', eta: 'до 40 хв' }),
    ).toContain('Запустив аналіз ідеї #3 по коду svitanok@abc1234 заново');
    expect(rerunText({ running: true, number: 3 })).toContain('уже йде');
  });

  it('targetOf: тема з контексту; dm → приватний чат власника; без контексту - тема «Асистент»; без чату - помилка', () => {
    const { env } = setup();
    expect(targetOf(env, { chatId: 555, threadId: 99 })).toEqual({ chatId: 555, threadId: '99' });
    expect(targetOf(env, { chatId: 777, threadId: 'dm' })).toEqual({ chatId: 777, threadId: null });
    expect(targetOf(env, { chatId: null, threadId: 'dm' })).toEqual({
      chatId: 777,
      threadId: null,
    });
    // Після ✅ пропозиції ядро знає лише тред (chatId null) - тема лишається темою.
    expect(targetOf(env, { chatId: null, threadId: '123' })).toEqual({
      chatId: 555,
      threadId: '123',
    });
    expect(targetOf(env, {})).toEqual({ chatId: 555, threadId: '99' });
    expect(() => targetOf({ ...env, TELEGRAM_CHAT_ID: undefined } as Env, {})).toThrow(
      /немає чату/,
    );
  });
});

describe('GitHub: HEAD-sha і dispatch', () => {
  it('fetchHeadSha: PAT у заголовку, accept sha, власник із GH_REPO; без PAT/чужий repo/не sha - помилка', async () => {
    const { env } = setup();
    const { gh } = stubFetch();
    expect(await fetchHeadSha(env, 'portfolio')).toBe(SHA);
    expect(gh[0]!.url).toBe('https://api.github.com/repos/owner/portfolio/commits/HEAD');
    expect(gh[0]!.headers.authorization).toBe('Bearer pat');
    expect(gh[0]!.headers.accept).toBe('application/vnd.github.sha');
    await expect(fetchHeadSha(env, 'other')).rejects.toThrow(/поза переліком/);
    await expect(fetchHeadSha({ ...env, REPO_READ_PAT: ' ' } as Env, 'svitanok')).rejects.toThrow(
      /REPO_READ_PAT/,
    );
    stubFetch({ sha: 'not-a-sha' });
    await expect(fetchHeadSha(env, 'svitanok')).rejects.toThrow(/не sha/);
    stubFetch({ headStatus: 404 });
    await expect(fetchHeadSha(env, 'svitanok')).rejects.toThrow(/GitHub 404/);
  });

  it('dispatch: workflow_dispatch на idea-analysis.yml, ref main, inputs лише DISPATCH_INPUTS рядками', async () => {
    const { env } = setup();
    const { gh } = stubFetch();
    await dispatchIdeaAnalysis(env, {
      run_id: 'r1',
      idea_id: 'i1',
      repo: 'svitanok',
      sha: SHA,
      title: 'T',
      idea: 'I',
      extra: 'no',
    });
    expect(gh[0]!.url).toBe(
      'https://api.github.com/repos/owner/svitanok/actions/workflows/idea-analysis.yml/dispatches',
    );
    expect(gh[0]!.body).toEqual({
      ref: 'main',
      inputs: { run_id: 'r1', idea_id: 'i1', repo: 'svitanok', sha: SHA, title: 'T', idea: 'I' },
    });
    expect(gh[0]!.headers.authorization).toBe('Bearer dispatch');
    stubFetch({ dispatchStatus: 403 });
    await expect(dispatchIdeaAnalysis(env, { run_id: 'r1' })).rejects.toThrow(/dispatch 403/);
    await expect(
      dispatchIdeaAnalysis({ ...env, GH_DISPATCH_TOKEN: '' } as Env, {}),
    ).rejects.toThrow(/GH_DISPATCH_TOKEN/);
  });
});

describe('startIdeaAnalysis (виконавець ideas.analyze mode=code)', () => {
  it('старт: ланцюг idea/waiting, прогін actions зі staleMs понад очікування, статус «в аналізі», подія, інстанс з повними params', async () => {
    const { env, db, wf, reg } = setup();
    stubFetch();
    const idea = await createIdea(env);
    const out = await startIdeaAnalysis(env, idea, {}, NOW, ctx);
    expect(out.result).toMatchObject({
      started: true,
      number: 1,
      repo: 'svitanok',
      sha: 'bbbbbbb',
    });
    expect(out.prev).toEqual({
      id: idea.id,
      status: 'нова',
      repo: null,
      chain_id: out.result.chain_id,
    });
    const chain = db.prepare('SELECT id, kind, status, state_json FROM chains').get() as {
      id: string;
      kind: string;
      status: string;
      state_json: string;
    };
    expect(chain).toMatchObject({ id: out.result.chain_id, kind: CHAIN_KIND, status: 'waiting' });
    const state = JSON.parse(chain.state_json);
    expect(Object.keys(state).sort()).toEqual(['idea_id', 'repo', 'run_id', 'sha']);
    expect(reg.begins[0]).toMatchObject({
      id: state.run_id,
      trigger: 'actions',
      profile: 'idea-analysis',
      threadId: '99',
      chatId: 555,
      staleMs: ANALYSIS_RUN_STALE_MS,
    });
    expect(ANALYSIS_RUN_STALE_MS).toBeGreaterThan(RUN_STALE_MS);
    expect(ANALYSIS_RUN_STALE_MS).toBeGreaterThan(WAIT_ARTIFACT_MS);
    expect(wf.created[0]).toEqual({
      id: chain.id,
      params: {
        chainId: chain.id,
        ideaId: idea.id,
        runId: state.run_id,
        repo: 'svitanok',
        sha: SHA,
        prevStatus: 'нова',
        chatId: 555,
        threadId: '99',
      },
    });
    expect(db.prepare('SELECT status, repo FROM ideas').get()).toEqual({
      status: 'в аналізі',
      repo: 'svitanok',
    });
    expect(
      (db.prepare(`SELECT note FROM idea_events WHERE kind = 'analysis'`).get() as { note: string })
        .note,
    ).toBe('code: dispatch svitanok@bbbbbbb');
    expect(await findAnalysisByRun(env, state.run_id)).toEqual({
      id: chain.id,
      status: 'waiting',
      ideaId: idea.id,
    });
    expect(await findRunningAnalysis(env, idea.id)).toBe(chain.id);
  });

  it('другий запит, поки аналіз іде, - running без нового dispatch (дедуп)', async () => {
    const { env, wf } = setup();
    stubFetch();
    const idea = await createIdea(env);
    await startIdeaAnalysis(env, idea, {}, NOW, ctx);
    const again = await startIdeaAnalysis(env, (await findIdea(env, idea.id))!, {}, NOW + 1, ctx);
    expect(again.result).toMatchObject({ running: true, number: 1 });
    expect('prev' in again).toBe(false);
    expect(wf.created).toHaveLength(1);
  });

  it('кеш (S-3-4): той самий sha + є звіт → документ із кнопкою «Все одно запустити» у тред запиту, без ланцюга; force - повторний старт', async () => {
    const { env, db, wf } = setup();
    const { tg } = stubFetch();
    const idea = await createIdea(env);
    db.prepare(`UPDATE ideas SET head_sha = ?, analysis_md = ? WHERE id = ?`).run(
      SHA,
      REPORT,
      idea.id,
    );
    db.prepare(
      `INSERT INTO idea_events (id, idea_id, at, kind, note) VALUES ('e1', ?, '2026-09-01T10:00:00Z', 'analysis', 'code ok svitanok@bbbbbbb')`,
    ).run(idea.id);
    const out = await startIdeaAnalysis(env, (await findIdea(env, idea.id))!, {}, NOW, ctx);
    expect(out.result).toMatchObject({
      cached: true,
      number: 1,
      repo: 'svitanok',
      sha: 'bbbbbbb',
      analyzed_at: '01.09',
      short: shortOf(REPORT),
    });
    expect(wf.created).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM chains').get()).toEqual({ n: 0 });
    const doc = tg.find((c) => c.method === 'sendDocument');
    const form = doc!.form as FormData;
    expect(form.get('chat_id')).toBe('555');
    expect(form.get('message_thread_id')).toBe('99');
    expect(String(form.get('caption'))).toContain('не змінювався з 01.09');
    expect(JSON.parse(String(form.get('reply_markup')))).toEqual({
      inline_keyboard: rerunButton(idea.id),
    });
    expect((form.get('document') as File).name).toBe('idea-1-analysis.md');
    const forced = await startIdeaAnalysis(
      env,
      (await findIdea(env, idea.id))!,
      { force: true },
      NOW + 1,
      ctx,
    );
    expect(forced.result).toMatchObject({ started: true });
    expect(wf.created).toHaveLength(1);
  });

  it('кеш у DM: документ іде в приватний чат без message_thread_id', async () => {
    const { env, db } = setup();
    const { tg } = stubFetch();
    const idea = await createIdea(env);
    db.prepare(`UPDATE ideas SET head_sha = ?, analysis_md = ? WHERE id = ?`).run(
      SHA,
      REPORT,
      idea.id,
    );
    await startIdeaAnalysis(env, (await findIdea(env, idea.id))!, {}, NOW, {
      chatId: 777,
      threadId: 'dm',
    });
    const form = tg.find((c) => c.method === 'sendDocument')!.form as FormData;
    expect(form.get('chat_id')).toBe('777');
    expect(form.get('message_thread_id')).toBeNull();
  });

  it('інший sha - не кеш: новий прогін попри наявний звіт', async () => {
    const { env, db, wf } = setup();
    stubFetch({ sha: SHA2 });
    const idea = await createIdea(env);
    db.prepare(`UPDATE ideas SET head_sha = ?, analysis_md = ? WHERE id = ?`).run(
      SHA,
      REPORT,
      idea.id,
    );
    const out = await startIdeaAnalysis(env, (await findIdea(env, idea.id))!, {}, NOW, ctx);
    expect(out.result).toMatchObject({ started: true, sha: 'ccccccc' });
    expect(wf.created).toHaveLength(1);
  });

  it('без REPO_READ_PAT - явна відмова ДО будь-яких змін; без привʼязки Workflow - теж', async () => {
    const { env, db, wf } = setup({ REPO_READ_PAT: '' });
    stubFetch();
    const idea = await createIdea(env);
    await expect(startIdeaAnalysis(env, idea, {}, NOW, ctx)).rejects.toThrow(/REPO_READ_PAT/);
    expect(db.prepare(IDEA_STATUS()).get()).toEqual({ status: 'нова' });
    expect(wf.created).toHaveLength(0);
    const noWf = setup({ IDEA_ANALYSIS: undefined });
    stubFetch();
    const idea2 = await createIdea(noWf.env);
    await expect(startIdeaAnalysis(noWf.env, idea2, {}, NOW, ctx)).rejects.toThrow(/IDEA_ANALYSIS/);
  });

  it('create Workflow упав - ланцюг failed, статус назад, прогін закрито, помилка нагору (не «вже йде» назавжди)', async () => {
    const { env, db, wf, reg } = setup();
    stubFetch();
    wf.setCreateFails(true);
    const idea = await createIdea(env);
    await expect(startIdeaAnalysis(env, idea, {}, NOW, ctx)).rejects.toThrow(/не стартував/);
    expect(db.prepare('SELECT status FROM chains').get()).toEqual({ status: 'failed' });
    expect(db.prepare(IDEA_STATUS()).get()).toEqual({ status: 'нова' });
    expect(reg.finishes[0]!.patch.error).toContain('Workflow не створено');
    expect(await findRunningAnalysis(env, idea.id)).toBeNull();
    // Наступний запит - знову спроба, не «вже йде».
    wf.setCreateFails(false);
    const again = await startIdeaAnalysis(env, (await findIdea(env, idea.id))!, {}, NOW + 1, ctx);
    expect(again.result).toMatchObject({ started: true });
  });

  it('policy: T0 з «↩»; «↩» повертає статус і repo, скасовує ланцюг подією; tainted теж T0', async () => {
    const { env, db, wf } = setup();
    stubFetch();
    const idea = await createIdea(env, { domain: 'інше' });
    db.prepare(`UPDATE ideas SET repo = 'portfolio' WHERE id = ?`).run(idea.id);
    const out = await applyPolicy(
      env,
      {
        kind: 'ideas.analyze',
        payload: { id: '1', mode: 'code', repo: 'svitanok' },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    expect(out.mode).toBe('executed');
    if (out.mode !== 'executed') return;
    expect(out.undo).toBeTruthy();
    expect(db.prepare('SELECT status, repo FROM ideas').get()).toEqual({
      status: 'в аналізі',
      repo: 'svitanok',
    });
    expect(await resolveUndo(env, out.undo!.id, NOW + 1000)).toEqual({
      ok: true,
      status: 'undone',
    });
    expect(db.prepare('SELECT status, repo FROM ideas').get()).toEqual({
      status: 'нова',
      repo: 'portfolio',
    });
    expect(db.prepare('SELECT status FROM chains').get()).toEqual({ status: 'cancelled' });
    expect(wf.events).toEqual([
      { id: wf.created[0]!.id, ev: { type: 'artifact', payload: { status: 'cancelled' } } },
    ]);
    expect(await findRunningAnalysis(env, idea.id)).toBeNull();
    // ⚠️ Звуження taint 08.09: аналіз власної ідеї по власному репо назовні
    // нічого не виносить, тож у забрудненій сесії він теж іде одразу.
    const tainted = await applyPolicy(
      env,
      {
        kind: 'ideas.analyze',
        payload: { id: '1', mode: 'code' },
        threadId: '99',
        chatId: 555,
        tainted: true,
      },
      NOW,
    );
    expect(tainted.mode).toBe('executed');
  });
});

describe('runIdeaAnalysisChain (машина станів)', () => {
  async function started(over: Partial<Env> = {}) {
    const s = setup(over);
    stubFetch();
    const idea = await createIdea(s.env);
    const out = await startIdeaAnalysis(s.env, idea, {}, NOW, ctx);
    const params = s.wf.created[0]!.params;
    return { ...s, idea, params, chainId: String(out.result.chain_id) };
  }

  it('ok: dispatch без повторів → артефакт → Drive окремим кроком → analysis_md/head_sha/статус → прогін закрито → «Коротко» + документ', async () => {
    const { env, db, params, chainId } = await started();
    const { step, log, cfgs } = fakeStep([{ payload: { status: 'ok', md: REPORT } }]);
    const { io, sent, docs, alerts, dispatched, finished } = fakeIo();
    expect(await runIdeaAnalysisChain(env, params, step, io)).toEqual({
      outcome: 'done',
      driveId: 'drive-1',
    });
    expect(dispatched[0]).toEqual({
      run_id: params.runId,
      idea_id: params.ideaId,
      repo: 'svitanok',
      sha: SHA,
      title: 'Експорт у Sheets',
      idea: 'кнопка експорту',
    });
    expect(Object.keys(dispatched[0]!)).toEqual([...DISPATCH_INPUTS]);
    expect(cfgs.dispatch).toEqual({ retries: { limit: 0, delay: 0 } });
    expect(log).toEqual([
      'do:idea',
      'do:dispatch',
      `wait:wait-artifact:artifact:${WAIT_ARTIFACT_MS / 1000} seconds`,
      'do:cancelled',
      'do:drive',
      'do:save',
      'do:finish-run',
      'do:deliver-text',
      'do:deliver-doc',
    ]);
    expect(
      db.prepare('SELECT status, head_sha, analysis_md, artifact_drive_id, repo FROM ideas').get(),
    ).toEqual({
      status: 'план готовий',
      head_sha: SHA,
      analysis_md: REPORT,
      artifact_drive_id: 'drive-1',
      repo: 'svitanok',
    });
    expect(db.prepare('SELECT status FROM chains WHERE id = ?').get(chainId)).toEqual({
      status: 'done',
    });
    expect(sent[0]).toContain('📄 Аналіз ідеї #1 «Експорт у Sheets» по коду svitanok@bbbbbbb');
    expect(sent[0]).toContain('- Ризик: consent.');
    expect(sent[0]).not.toContain('Drive не збережено');
    expect(docs).toEqual([
      { filename: 'idea-1-analysis.md', content: REPORT, caption: 'Повний звіт: ідея #1' },
    ]);
    expect(alerts).toEqual([]);
    expect(finished).toEqual([{ runId: params.runId, error: null }]);
    expect(
      (
        db.prepare(`SELECT note FROM idea_events WHERE note LIKE 'code ok%'`).get() as {
          note: string;
        }
      ).note,
    ).toBe('code ok svitanok@bbbbbbb');
    expect(await findRunningAnalysis(env, params.ideaId)).toBeNull();
  });

  it('довгий/частковий звіт: у D1 - кап із позначкою, у документ - цілий; без Drive - позначка; partial - у тексті й події', async () => {
    const { env, db, params } = await started();
    const long = `## Коротко\n- x\n\n## Аналіз\n${'д'.repeat(ANALYSIS_MD_MAX + 500)}`;
    const { step } = fakeStep([{ payload: { status: 'ok', md: long, partial: true } }]);
    const { io, sent, docs } = fakeIo({ driveId: null });
    await runIdeaAnalysisChain(env, params, step, io);
    const row = db.prepare('SELECT analysis_md, artifact_drive_id FROM ideas').get() as {
      analysis_md: string;
      artifact_drive_id: string | null;
    };
    expect(row.analysis_md.length).toBe(ANALYSIS_MD_MAX);
    expect(row.analysis_md.endsWith('Drive)')).toBe(true);
    expect(row.artifact_drive_id).toBeNull();
    expect(docs[0]!.content.length).toBe(long.length);
    expect(sent[0]).toContain('копію в Drive не збережено');
    expect(sent[0]).toContain('частковий');
    expect(
      (
        db.prepare(`SELECT note FROM idea_events WHERE note LIKE 'code ok%'`).get() as {
          note: string;
        }
      ).note,
    ).toBe('code ok svitanok@bbbbbbb (частковий) (без Drive)');
  });

  it('failed від Actions (S-3-5): статус назад, подія, «не вдався» власнику, алерт у системний, прогін з помилкою - окремими кроками', async () => {
    const { env, db, params, chainId } = await started();
    const { step, log } = fakeStep([
      { payload: { status: 'failed', reason: 'claude: error_during_execution' } },
    ]);
    const { io, sent, docs, alerts, finished } = fakeIo();
    expect(await runIdeaAnalysisChain(env, params, step, io)).toEqual({
      outcome: 'failed',
      reason: 'claude: error_during_execution',
    });
    expect(log.slice(-4)).toEqual(['do:fail-db', 'do:fail-run', 'do:fail-notify', 'do:fail-alert']);
    expect(db.prepare('SELECT status, analysis_md FROM ideas').get()).toEqual({
      status: 'нова',
      analysis_md: null,
    });
    expect(db.prepare('SELECT status FROM chains WHERE id = ?').get(chainId)).toEqual({
      status: 'failed',
    });
    expect(sent).toEqual(['Аналіз ідеї #1 не вдався (лог у системному чаті).']);
    expect(alerts[0]).toContain(
      'Аналіз ідеї #1 по коду svitanok@bbbbbbb не вдався: claude: error_during_execution',
    );
    expect(docs).toEqual([]);
    expect(finished[0]).toEqual({
      runId: params.runId,
      error: 'actions: claude: error_during_execution',
    });
  });

  it('таймаут очікування - failed з причиною таймауту', async () => {
    const { env, params } = await started();
    const { step } = fakeStep([new Error('timeout')]);
    const { io, sent, alerts } = fakeIo();
    expect(await runIdeaAnalysisChain(env, params, step, io)).toMatchObject({
      outcome: 'failed',
      reason: `таймаут ${WAIT_ARTIFACT_MS / 60_000} хв - Actions не відповів`,
    });
    expect(sent[0]).toContain('не вдався');
    expect(alerts[0]).toContain('таймаут');
  });

  it('збій dispatch - failed одразу, без очікування артефакту', async () => {
    const { env, db, params } = await started();
    const { step, log } = fakeStep([]);
    const { io, alerts, finished } = fakeIo({ dispatchFails: true });
    expect(await runIdeaAnalysisChain(env, params, step, io)).toMatchObject({
      outcome: 'failed',
      reason: 'dispatch: dispatch 403: forbidden',
    });
    expect(log.some((l) => l.startsWith('wait:'))).toBe(false);
    expect(db.prepare(IDEA_STATUS()).get()).toEqual({ status: 'нова' });
    expect(alerts[0]).toContain('dispatch 403');
    expect(finished[0]!.error).toContain('dispatch');
  });

  it('«↩» після старту: подія cancelled або статус cancelled - результат відкинуто мовчки', async () => {
    const { env, db, params, chainId } = await started();
    const { step } = fakeStep([{ payload: { status: 'cancelled' } }]);
    const { io, sent, docs, alerts, finished } = fakeIo();
    expect(await runIdeaAnalysisChain(env, params, step, io)).toEqual({ outcome: 'cancelled' });
    expect(sent).toEqual([]);
    expect(docs).toEqual([]);
    expect(alerts).toEqual([]);
    expect(finished).toEqual([{ runId: params.runId, error: 'cancelled' }]);
    // Статус у базі теж достатній (подія не дійшла, артефакт прийшов).
    db.prepare(`UPDATE chains SET status = 'cancelled' WHERE id = ?`).run(chainId);
    const again = fakeStep([{ payload: { status: 'ok', md: REPORT } }]);
    expect(await runIdeaAnalysisChain(env, params, again.step, fakeIo().io)).toEqual({
      outcome: 'cancelled',
    });
    expect(db.prepare('SELECT analysis_md FROM ideas').get()).toEqual({ analysis_md: null });
  });

  it('статус «в аналізі», змінений власником тим часом, при збої не перезаписується', async () => {
    const { env, db, params } = await started();
    db.prepare(`UPDATE ideas SET status = 'відкладено'`).run();
    const { step } = fakeStep([{ payload: { status: 'failed', reason: 'x' } }]);
    await runIdeaAnalysisChain(env, params, step, fakeIo().io);
    expect(db.prepare(IDEA_STATUS()).get()).toEqual({ status: 'відкладено' });
  });
});

describe('POST /internal/artifact', () => {
  const PATH = '/internal/artifact';
  async function post(env: Env, runId: string, body: unknown, key = KEY) {
    const raw = JSON.stringify(body);
    const headers = await signedInternalHeaders(key, {
      method: 'POST',
      path: PATH,
      runId,
      rawBody: raw,
      nowMs: NOW,
    });
    return handleInternal(
      new Request(`https://svitanok.test${PATH}`, { method: 'POST', headers, body: raw }),
      env,
      NOW,
    );
  }

  async function startedChain(over: Partial<Env> = {}) {
    const s = setup(over);
    stubFetch();
    const idea = await createIdea(s.env);
    const out = await startIdeaAnalysis(s.env, idea, {}, NOW, ctx);
    const runId = (s.reg.begins[0] as { id: string }).id;
    return { ...s, idea, runId, chainId: String(out.result.chain_id) };
  }

  it('схема: idea_id і status обовʼязкові; md ≤ 100 000 символів вміщує кап скрипта в байтах', () => {
    expect(validateAgainst(ARTIFACT_SCHEMA, { idea_id: 'i', status: 'ok', md: 'x' }).ok).toBe(true);
    expect(validateAgainst(ARTIFACT_SCHEMA, { status: 'ok' }).ok).toBe(false);
    expect(
      validateAgainst(ARTIFACT_SCHEMA, { idea_id: 'i', status: 'ok', md: 'x'.repeat(100_001) }).ok,
    ).toBe(false);
    expect(ARTIFACT_SCHEMA.properties!.md!.maxLength).toBeGreaterThanOrEqual(ARTIFACT_MD_MAX_BYTES);
  });

  it('ok: підпис + живий run_id → подія artifact у Workflow (з partial), прогін НЕ закривається тут', async () => {
    const { env, runId, chainId, wf, reg, idea } = await startedChain();
    const res = await post(env, runId, {
      idea_id: idea.id,
      status: 'ok',
      repo: 'svitanok',
      sha: SHA,
      md: REPORT,
      meta: { partial: true, num_turns: 90 },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, chain_id: chainId, status: 'ok' });
    expect(reg.finishes).toEqual([]);
    expect(wf.events).toEqual([
      {
        id: chainId,
        ev: { type: 'artifact', payload: { status: 'ok', md: REPORT, partial: true } },
      },
    ]);
  });

  it('failed: подія з reason', async () => {
    const { env, runId, chainId, wf, idea } = await startedChain();
    const res = await post(env, runId, { idea_id: idea.id, status: 'failed', reason: 'таймаут' });
    expect(res.status).toBe(200);
    expect(wf.events[0]).toEqual({
      id: chainId,
      ev: { type: 'artifact', payload: { status: 'failed', reason: 'таймаут' } },
    });
  });

  it('відмови: чужий ключ 401, невідомий прогін 403, чужа idea_id 400, ok без md 400, кривий status 400, ланцюг не чекає 409', async () => {
    const { env, runId, chainId, wf, idea } = await startedChain();
    expect(
      (await post(env, runId, { idea_id: idea.id, status: 'ok', md: 'x' }, 'wrong')).status,
    ).toBe(401);
    expect((await post(env, 'ghost', { idea_id: idea.id, status: 'ok', md: 'x' })).status).toBe(
      403,
    );
    expect((await post(env, runId, { idea_id: 'other', status: 'ok', md: 'x' })).status).toBe(400);
    expect((await post(env, runId, { idea_id: idea.id, status: 'ok' })).status).toBe(400);
    expect((await post(env, runId, { idea_id: idea.id, status: 'meh' })).status).toBe(400);
    await cancelAnalysis(env, chainId);
    wf.events.length = 0;
    const res = await post(env, runId, { idea_id: idea.id, status: 'ok', md: 'x' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'chain-not-waiting', status: 'cancelled' });
    expect(wf.events).toEqual([]);
  });

  it('run_id без ланцюга аналізу (напр. чат-прогін) - 404 chain-unknown', async () => {
    const { env, reg } = setup();
    reg.active.add('chat-run');
    const res = await post(env, 'chat-run', { idea_id: 'i', status: 'ok', md: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'chain-unknown' });
  });

  it('sendEvent відкинуто інстансом - 409', async () => {
    const { env, runId, wf, idea } = await startedChain();
    wf.setReject(true);
    expect((await post(env, runId, { idea_id: idea.id, status: 'ok', md: 'x' })).status).toBe(409);
  });

  it('підпис signInternal напряму - той самий формат', async () => {
    const { env, runId, idea } = await startedChain();
    const raw = JSON.stringify({ idea_id: idea.id, status: 'ok', md: 'x' });
    const res = await handleInternal(
      new Request(`https://svitanok.test${PATH}`, {
        method: 'POST',
        headers: {
          'X-Internal-Timestamp': String(NOW),
          'X-Internal-Run': runId,
          'X-Internal-Nonce': 'n-z',
          'X-Internal-Signature': await signInternal(KEY, {
            method: 'POST',
            path: PATH,
            timestampMs: NOW,
            runId,
            nonce: 'n-z',
            rawBody: raw,
          }),
        },
        body: raw,
      }),
      env,
      NOW,
    );
    expect(res.status).toBe(200);
  });
});

describe('кнопка m:ia: (prerouter)', () => {
  it('тап: клавіатуру знято, force-старт через policy, у тред «Запустив … заново» з «↩», тост', async () => {
    const { env, db, wf } = setup();
    const { tg } = stubFetch();
    const idea = await createIdea(env);
    db.prepare(`UPDATE ideas SET head_sha = ?, analysis_md = ? WHERE id = ?`).run(
      SHA,
      REPORT,
      idea.id,
    );
    const deferred: (() => Promise<void>)[] = [];
    const toast = await handleBrainCallback(
      env,
      { data: `m:ia:${idea.id}`, chatId: 555, messageId: 42, threadId: 99 },
      NOW,
      (work) => deferred.push(work),
    );
    expect(toast).toBe('Запускаю аналіз заново');
    expect(wf.created).toHaveLength(0);
    for (const w of deferred) await w();
    expect(wf.created).toHaveLength(1);
    expect(tg.some((c) => c.method === 'editMessageReplyMarkup')).toBe(true);
    const msg = tg.find(
      (c) =>
        c.method === 'sendMessage' &&
        String((c.form as Record<string, unknown>).text).includes('заново'),
    )!.form as Record<string, unknown>;
    expect(String(msg.message_thread_id)).toBe('99');
    const kb = (msg.reply_markup as { inline_keyboard: { callback_data: string }[][] })
      .inline_keyboard;
    expect(kb[0]![0]!.callback_data).toMatch(/^u:/);
    expect(db.prepare(IDEA_STATUS()).get()).toEqual({ status: 'в аналізі' });
  });

  it('невідома ідея - «Не вийшло» у тред, без падіння', async () => {
    const { env } = setup();
    const { tg } = stubFetch();
    const toast = await handleBrainCallback(
      env,
      { data: 'm:ia:nope', chatId: 555, messageId: 1 },
      NOW,
    );
    expect(toast).toBe('Запускаю аналіз заново');
    expect(
      tg.some((c) => String((c.form as Record<string, unknown>).text ?? '').includes('Не вийшло')),
    ).toBe(true);
  });
});

describe('контракт і конфіг Worker', () => {
  it('скрипт Actions і ядро читають один контракт', () => {
    expect(WORKFLOW_INPUTS).toBe(DISPATCH_INPUTS);
    expect(IDEA_REPOS).toEqual(['svitanok', 'portfolio', 'moviehouse', 'modern-blog']);
  });

  it('wrangler.jsonc: Workflow IdeaAnalysis з привʼязкою IDEA_ANALYSIS; worker.js експортує кожен class_name', () => {
    const wrangler = readFileSync(join(ROOT, 'web', 'wrangler.jsonc'), 'utf8');
    expect(wrangler).toMatch(/"binding":\s*"IDEA_ANALYSIS",\s*"class_name":\s*"IdeaAnalysis"/);
    const worker = readFileSync(join(ROOT, 'web', 'worker.js'), 'utf8');
    expect(worker).toContain("export { IdeaAnalysis } from './core/ideas/analysis.mjs';");
    for (const m of wrangler.matchAll(/"class_name":\s*"(\w+)"/g)) {
      expect(worker).toMatch(new RegExp(`export \\{ ${m[1]} \\}`));
    }
  });
});
