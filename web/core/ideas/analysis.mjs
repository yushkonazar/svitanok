// Аналіз ідеї по коду (01 §3.9, 07 §6 Workflow IdeaAnalysis, S-3-3…S-3-5,
// S-3-8; етап 4 PR-2). `ideas.analyze(mode=code)` → startIdeaAnalysis:
// репо з переліку, HEAD-sha через GitHub API (REPO_READ_PAT), кеш за
// `ideas.head_sha` (той самий sha + є звіт = попередній документ без прогону,
// кнопка «Все одно запустити»), інакше - рядок у `chains` (kind idea), прогін
// у RunRegistry (trigger actions, стеля сторожа 45 хв) і інстанс Workflow.
//
// Машина станів runIdeaAnalysisChain: dispatch idea-analysis.yml
// (workflow_dispatch, inputs = поля скрипта) → waitForEvent(artifact, 42 хв)
// → зберегти (ideas.analysis_md, head_sha, статус «план готовий», копія в
// Drive) → «Коротко» + документ у тред → done; failed/таймаут/збій dispatch →
// статус назад, «Аналіз не вдався» власнику + алерт у TOPIC_SYSTEM (S-3-5).
// Подія artifact приходить із /internal/artifact (Actions підписує run_id).
// Вихід у світ - через io, як у DayPlanChain: тести ганяють машину з фейками.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { DEFAULT_GH_REPO } from '../../cron.mjs';
import { enqueueOutbox, drainOutbox, sendSystemAlert } from '../tg/outbox.mjs';
import { registryBegin, registryFinish } from '../run-registry/client.mjs';
import { ensureFolderPath, uploadFile } from '../adapters/drive.mjs';

export const CHAIN_KIND = 'idea';
export const ANALYSIS_PROFILE = 'idea-analysis';
/** Репозиторії, доступні для аналізу (S-3-8; парність зі скриптом тримає тест). */
export const IDEA_REPOS = ['svitanok', 'portfolio', 'moviehouse', 'modern-blog'];
/** Стеля job в Actions (07 §6) + запас на старт раннера. */
export const JOB_TIMEOUT_MIN = 40;
export const WAIT_ARTIFACT_MS = (JOB_TIMEOUT_MIN + 2) * 60_000;
/** Сторож RunRegistry для цього прогону: загальні 6 хв закрили б run_id до артефакту. */
export const ANALYSIS_RUN_STALE_MS = 45 * 60_000;
/** Inputs воркфлоу - ті самі імена, що WORKFLOW_INPUTS скрипта (тест парності). */
export const DISPATCH_INPUTS = ['run_id', 'idea_id', 'repo', 'sha', 'title', 'idea'];
/** Кап тексту ідеї в inputs (= IDEA_TEXT_MAX скрипта; inputs ≤ 65 535 разом). */
export const DISPATCH_IDEA_MAX = 12_000;
/** Кап analysis_md у D1 (= IDEA_TEXT_MAX реєстру ідей); повний звіт - у документі й Drive. */
export const ANALYSIS_MD_MAX = 20_000;
/** «Коротко» в чат ≤ 600 символів (code-reviewer.md «Формат відповіді»). */
export const SHORT_MAX = 600;
export const DRIVE_FOLDER_PATH = ['Світанок', 'ideas'];
const WORKFLOW_FILE = 'idea-analysis.yml';
const GITHUB_API = 'https://api.github.com';
const GITHUB_TIMEOUT_MS = 10_000;

/**
 * @typedef {{
 *   now: () => number,
 *   send: (text: string, buttons?: { text: string, callback_data: string }[][]) => Promise<void>,
 *   sendDocument: (filename: string, content: string, caption: string) => Promise<void>,
 *   alert: (text: string) => Promise<void>,
 *   dispatch: (inputs: Record<string, string>) => Promise<void>,
 *   uploadDrive: (name: string, content: string) => Promise<string | null>,
 *   finishRun: (runId: string, error: string | null) => Promise<void>,
 * }} AnalysisIo
 * @typedef {{
 *   do: <T>(name: string, fn: () => Promise<T>) => Promise<T>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} AnalysisStep
 * @typedef {{ chainId: string, ideaId: string, runId: string, repo: string, sha: string }} AnalysisParams
 * @typedef {{ idea_id: string, run_id: string, repo: string, sha: string, prev_status: string,
 *   chat_id: number | null, thread_id: string | null, awaiting: string | null }} ChainState
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - аналіз недоступний');
  return env.DB;
}

/** Власник GitHub - із GH_REPO (owner/repo), як у dispatch брифінгу. @param {Env} env */
export function repoOwner(env) {
  return String(env.GH_REPO?.trim() || DEFAULT_GH_REPO).split('/')[0] ?? '';
}

/**
 * HEAD default-гілки репо (кеш S-3-4). Без REPO_READ_PAT - явна відмова: тихо
 * запускати аналіз без кешу означало б 40 хв Actions на кожне «проаналізуй».
 * @param {Env} env @param {string} repo @param {typeof fetch} [fetchFn]
 */
export async function fetchHeadSha(env, repo, fetchFn = fetch) {
  const token = String(env.REPO_READ_PAT ?? '').trim();
  if (!token) throw new Error('REPO_READ_PAT не задано в Cloudflare - аналіз по коду недоступний');
  if (!IDEA_REPOS.includes(repo)) throw new Error(`repo «${repo}» поза переліком`);
  const res = await fetchFn(`${GITHUB_API}/repos/${repoOwner(env)}/${repo}/commits/HEAD`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github.sha',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'svitanok-idea-analysis',
    },
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });
  const text = (await res.text().catch(() => '')).trim();
  if (!res.ok) throw new Error(`GitHub ${res.status} на HEAD ${repo}`);
  if (!/^[0-9a-f]{40}$/.test(text)) throw new Error(`GitHub: HEAD ${repo} не sha`);
  return text;
}

/**
 * Запуск idea-analysis.yml (workflow_dispatch; відхилення від repository_dispatch
 * - plan.md етапу 4). inputs - лише DISPATCH_INPUTS, рядками.
 * @param {Env} env @param {Record<string, string>} inputs @param {typeof fetch} [fetchFn]
 */
export async function dispatchIdeaAnalysis(env, inputs, fetchFn = fetch) {
  const token = String(env.GH_DISPATCH_TOKEN ?? '').trim();
  if (!token) throw new Error('GH_DISPATCH_TOKEN не задано');
  /** @type {Record<string, string>} */
  const body = {};
  for (const k of DISPATCH_INPUTS) body[k] = String(inputs[k] ?? '');
  const slug = env.GH_REPO?.trim() || DEFAULT_GH_REPO;
  const res = await fetchFn(
    `${GITHUB_API}/repos/${slug}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'svitanok-idea-analysis',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: body }),
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`dispatch ${res.status}: ${text.slice(0, 120)}`);
  }
}

/**
 * Репо для ідеї: явний аргумент → колонка ideas.repo → svitanok для domain
 * svitanok; інакше - чесне питання власнику (S-3-2/S-3-8).
 * @param {{ repo: string | null, domain: string | null }} idea @param {unknown} arg
 */
export function resolveRepo(idea, arg) {
  const explicit = String(arg ?? '').trim();
  const repo = explicit || idea.repo || (idea.domain === 'svitanok' ? 'svitanok' : '');
  if (!repo) throw new Error(`вкажи repo (одне з: ${IDEA_REPOS.join(', ')})`);
  if (!IDEA_REPOS.includes(repo)) {
    throw new Error(`Доступ є лише до ${IDEA_REPOS.join(', ')} - не до «${repo}»`);
  }
  return repo;
}

/**
 * Розділ «## Коротко» звіту (≤ SHORT_MAX) - у чат; без розділу - перші рядки.
 * @param {string} md
 */
export function shortOf(md) {
  const lines = md.split(/\r?\n/);
  const from = lines.findIndex((l) => /^##\s*Коротко/.test(l));
  let picked = md;
  if (from >= 0) {
    const rest = lines.slice(from + 1);
    const to = rest.findIndex((l) => /^##\s/.test(l));
    picked = (to >= 0 ? rest.slice(0, to) : rest).join('\n');
  }
  const text = picked.trim();
  return text.length > SHORT_MAX ? `${text.slice(0, SHORT_MAX - 1)}…` : text;
}

/** @param {number} n */
export function analysisFilename(n) {
  return `idea-${n}-analysis.md`;
}

/** Кнопка повторного запуску під кешованим документом (07 §9 `m:`). @param {string} ideaId */
export function rerunButton(ideaId) {
  return [[{ text: '🔁 Все одно запустити', callback_data: `m:ia:${ideaId}` }]];
}

/**
 * Активний ланцюг аналізу цієї ідеї (дедуп: другий dispatch тієї самої ідеї
 * лише спалив би раннер і зіткнувся б у concurrency воркфлоу).
 * @param {Env} env @param {string} ideaId
 */
export async function findRunningAnalysis(env, ideaId) {
  const row = /** @type {{ id: string } | null} */ (
    await db(env)
      .prepare(
        `SELECT id FROM chains WHERE kind = ? AND status IN ('running', 'waiting')
           AND json_extract(state_json, '$.idea_id') = ? ORDER BY created_at DESC LIMIT 1`,
      )
      .bind(CHAIN_KIND, ideaId)
      .first()
  );
  return row ? String(row.id) : null;
}

/**
 * Ланцюг за run_id прогону в Actions (/internal/artifact підписує ним).
 * @param {Env} env @param {string} runId
 * @returns {Promise<{ id: string, status: string, state: ChainState } | null>}
 */
export async function findAnalysisByRun(env, runId) {
  const row = /** @type {{ id: string, status: string, state_json: string } | null} */ (
    await db(env)
      .prepare(
        `SELECT id, status, state_json FROM chains WHERE kind = ? AND json_extract(state_json, '$.run_id') = ? LIMIT 1`,
      )
      .bind(CHAIN_KIND, runId)
      .first()
  );
  if (!row) return null;
  return { id: String(row.id), status: String(row.status), state: JSON.parse(row.state_json) };
}

/**
 * @param {Env} env @param {string} chainId
 * @returns {Promise<{ status: string, state: ChainState } | null>}
 */
async function readChain(env, chainId) {
  const row = /** @type {{ status: string, state_json: string } | null} */ (
    await db(env)
      .prepare('SELECT status, state_json FROM chains WHERE id = ?')
      .bind(chainId)
      .first()
  );
  return row ? { status: String(row.status), state: JSON.parse(row.state_json) } : null;
}

/**
 * @param {Env} env @param {string} chainId
 * @param {{ status: string, awaiting: string | null }} patch
 */
export async function setAnalysisState(env, chainId, patch) {
  await db(env)
    .prepare(
      `UPDATE chains SET status = ?, state_json = json_set(COALESCE(state_json, '{}'), '$.awaiting', ?), updated_at = ? WHERE id = ?`,
    )
    .bind(patch.status, patch.awaiting, new Date().toISOString(), chainId)
    .run();
}

/** «↩» після старту (undo ideas.analyze): скасувати ланцюг - результат буде відкинуто. @param {Env} env @param {string} chainId */
export async function cancelAnalysis(env, chainId) {
  await db(env)
    .prepare(
      `UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('running', 'waiting')`,
    )
    .bind(new Date().toISOString(), chainId)
    .run();
}

/** @param {Env} env @param {string} ideaId @param {string} note @param {number} nowMs */
async function ideaEvent(env, ideaId, note, nowMs) {
  await db(env)
    .prepare('INSERT INTO idea_events (id, idea_id, at, kind, note) VALUES (?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), ideaId, new Date(nowMs).toISOString(), 'analysis', note)
    .run();
}

/** Дата останнього успішного аналізу по коду (для «не змінювався з DD.MM»). @param {Env} env @param {string} ideaId */
async function lastAnalyzedAt(env, ideaId) {
  const row = /** @type {{ at: string } | null} */ (
    await db(env)
      .prepare(
        `SELECT at FROM idea_events WHERE idea_id = ? AND kind = 'analysis' AND note LIKE 'code ok%' ORDER BY at DESC LIMIT 1`,
      )
      .bind(ideaId)
      .first()
  );
  return row ? String(row.at) : null;
}

/** «05.09» з ISO. @param {string | null} iso */
export function ddmm(iso) {
  if (!iso) return '?';
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '?';
  const [, m, day] = d.toISOString().slice(0, 10).split('-');
  return `${day}.${m}`;
}

/**
 * Старт аналізу по коду з чату (виконавець ideas.analyze mode=code, T0).
 * Повертає результат для моделі; документ і кнопка кешу йдуть у тред самі.
 * @param {Env} env
 * @param {import('../tools/ideas.mjs').IdeaRow} idea
 * @param {{ repo?: unknown, force?: unknown }} args
 * @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx
 * @param {{ fetchFn?: typeof fetch }} [deps]
 */
export async function startIdeaAnalysis(env, idea, args, nowMs, ctx, deps = {}) {
  const repo = resolveRepo(idea, args.repo);
  const running = await findRunningAnalysis(env, idea.id);
  if (running) {
    return {
      result: {
        number: idea.number,
        running: true,
        chain_id: running,
        note: 'аналіз цієї ідеї вже йде - результат прийде окремим повідомленням з документом',
      },
    };
  }
  const sha = await fetchHeadSha(env, repo, deps.fetchFn);
  const target = targetOf(env, ctx);
  if (!args.force && idea.head_sha === sha && idea.analysis_md) {
    const since = ddmm(await lastAnalyzedAt(env, idea.id));
    if (target.chatId != null) {
      await enqueueOutbox(
        env,
        {
          chatId: target.chatId,
          threadId: target.threadId,
          kind: 'document',
          payload: {
            filename: analysisFilename(idea.number),
            content: idea.analysis_md,
            caption: `Код ${repo} не змінювався з ${since} - ось попередній аналіз ідеї #${idea.number}.`,
            reply_markup: { inline_keyboard: rerunButton(idea.id) },
          },
        },
        nowMs,
      );
      await drainOutbox(env, { nowMs }).catch(() => {});
    }
    return {
      result: {
        number: idea.number,
        cached: true,
        repo,
        sha: sha.slice(0, 7),
        analyzed_at: since,
        short: shortOf(idea.analysis_md),
        note: 'документ із попереднім аналізом і кнопка «Все одно запустити» вже в чаті - не повторюй звіт цілком',
      },
    };
  }
  if (!env.IDEA_ANALYSIS) throw new Error('привʼязки IDEA_ANALYSIS (Workflow) немає');
  const chainId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const iso = new Date(nowMs).toISOString();
  /** @type {ChainState} */
  const state = {
    idea_id: idea.id,
    run_id: runId,
    repo,
    sha,
    prev_status: idea.status,
    chat_id: target.chatId,
    thread_id: target.threadId == null ? null : String(target.threadId),
    awaiting: 'artifact',
  };
  await db(env)
    .prepare(
      `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'waiting', ?, ?)`,
    )
    .bind(chainId, CHAIN_KIND, chainId, JSON.stringify(state), iso, iso)
    .run();
  await registryBegin(env, {
    id: runId,
    trigger: 'actions',
    profile: ANALYSIS_PROFILE,
    threadId: state.thread_id ?? 'dm',
    chatId: target.chatId == null ? null : Number(target.chatId),
    model: 'claude-sonnet-5',
    startedMs: nowMs,
    staleMs: ANALYSIS_RUN_STALE_MS,
  });
  await db(env)
    .prepare(`UPDATE ideas SET status = 'в аналізі', repo = ?, updated_at = ? WHERE id = ?`)
    .bind(repo, iso, idea.id)
    .run();
  await ideaEvent(env, idea.id, `code: dispatch ${repo}@${sha.slice(0, 7)}`, nowMs);
  await env.IDEA_ANALYSIS.create({
    id: chainId,
    params: /** @type {AnalysisParams} */ ({ chainId, ideaId: idea.id, runId, repo, sha }),
  });
  return {
    result: {
      number: idea.number,
      started: true,
      chain_id: chainId,
      repo,
      sha: sha.slice(0, 7),
      eta: `до ${JOB_TIMEOUT_MIN} хв`,
      note: 'результат прийде окремим повідомленням з документом; кажи власнику лише що запущено',
    },
    prev: { id: idea.id, status: idea.status, chain_id: chainId },
  };
}

/** Адреса треду, з якого просили аналіз; без чату - спільна тема. @param {Env} env @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx */
function targetOf(env, ctx) {
  const chatId =
    ctx.chatId != null
      ? Number(ctx.chatId)
      : env.TELEGRAM_CHAT_ID
        ? Number(env.TELEGRAM_CHAT_ID)
        : null;
  const threadId = ctx.chatId != null ? (ctx.threadId ?? null) : (env.TOPIC_ASSISTANT ?? null);
  return { chatId, threadId: threadId === 'dm' ? null : threadId };
}

// ── Машина станів Workflow ─────────────────────────────────────────────────

/**
 * @param {Env} env
 * @param {AnalysisParams} params
 * @param {AnalysisStep} step
 * @param {AnalysisIo} io
 */
export async function runIdeaAnalysisChain(env, params, step, io) {
  const { chainId, ideaId, runId, repo, sha } = params;
  const idea = await step.do('idea', async () => {
    const row = /** @type {{ number: number, title: string, body_md: string | null } | null} */ (
      await db(env)
        .prepare('SELECT number, title, body_md FROM ideas WHERE id = ?')
        .bind(ideaId)
        .first()
    );
    if (!row) throw new Error(`ідеї ${ideaId} немає`);
    return row;
  });
  const fail = async (/** @type {string} */ reason) => {
    await step.do('fail', async () => {
      const chain = await readChain(env, chainId);
      const prev = chain?.state.prev_status ?? 'нова';
      await db(env)
        .prepare(
          `UPDATE ideas SET status = ?, updated_at = ? WHERE id = ? AND status = 'в аналізі'`,
        )
        .bind(prev, new Date(io.now()).toISOString(), ideaId)
        .run();
      await ideaEvent(env, ideaId, `code failed: ${reason.slice(0, 200)}`, io.now());
      await setAnalysisState(env, chainId, { status: 'failed', awaiting: null });
      await io.finishRun(runId, `actions: ${reason.slice(0, 100)}`);
      await io.send(`Аналіз ідеї #${idea.number} не вдався (лог у системному чаті).`);
      await io.alert(
        `Аналіз ідеї #${idea.number} по коду ${repo}@${sha.slice(0, 7)} не вдався: ${reason.slice(0, 300)}`,
      );
    });
    return { outcome: 'failed', reason };
  };

  try {
    await step.do('dispatch', () =>
      io.dispatch({
        run_id: runId,
        idea_id: ideaId,
        repo,
        sha,
        title: String(idea.title ?? '').slice(0, 200),
        idea: String(idea.body_md ?? '').slice(0, DISPATCH_IDEA_MAX),
      }),
    );
  } catch (/** @type {any} */ e) {
    return fail(`dispatch: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  // Таймаут очікування у Workflows - виняток; тут це чесний null (S-3-5).
  /** @type {{ status?: string, md?: string, reason?: string, sha?: string } | null} */
  const artifact = await step
    .waitForEvent('wait-artifact', {
      type: 'artifact',
      timeout: `${Math.ceil(WAIT_ARTIFACT_MS / 1000)} seconds`,
    })
    .then((ev) => ev?.payload ?? null)
    .catch(() => null);

  // «↩» після старту: результат відкидається мовчки (власник сам скасував).
  const cancelled = await step.do(
    'cancelled?',
    async () => (await readChain(env, chainId))?.status === 'cancelled',
  );
  if (cancelled) {
    await step.do('discard', () => io.finishRun(runId, 'cancelled'));
    return { outcome: 'cancelled' };
  }
  if (!artifact) return fail(`таймаут ${JOB_TIMEOUT_MIN} хв - Actions не відповів`);
  if (artifact.status !== 'ok' || typeof artifact.md !== 'string' || !artifact.md.trim()) {
    return fail(String(artifact.reason ?? 'Actions: failed').slice(0, 300));
  }

  const md = artifact.md;
  const saved = await step.do('save', async () => {
    const nowMs = io.now();
    const iso = new Date(nowMs).toISOString();
    const driveId = await io.uploadDrive(analysisFilename(idea.number), md);
    await db(env)
      .prepare(
        `UPDATE ideas SET analysis_md = ?, head_sha = ?, repo = ?, artifact_drive_id = COALESCE(?, artifact_drive_id),
           status = 'план готовий', updated_at = ? WHERE id = ?`,
      )
      .bind(
        md.length > ANALYSIS_MD_MAX ? md.slice(0, ANALYSIS_MD_MAX) : md,
        sha,
        repo,
        driveId,
        iso,
        ideaId,
      )
      .run();
    await ideaEvent(
      env,
      ideaId,
      `code ok ${repo}@${sha.slice(0, 7)}${driveId ? '' : ' (без Drive)'}`,
      nowMs,
    );
    await setAnalysisState(env, chainId, { status: 'done', awaiting: null });
    await io.finishRun(runId, null);
    return { driveId };
  });
  await step.do('deliver', async () => {
    const short = shortOf(md);
    await io.send(
      `📄 Аналіз ідеї #${idea.number} «${idea.title}» по коду ${repo}@${sha.slice(0, 7)}:\n${short}${saved.driveId ? '' : '\n(копію в Drive не збережено - див. лог)'}`,
    );
    await io.sendDocument(analysisFilename(idea.number), md, `Повний звіт: ідея #${idea.number}`);
  });
  return { outcome: 'done', driveId: saved.driveId };
}

/**
 * Подія в ланцюг аналізу (з /internal/artifact).
 * @param {Env} env @param {string} chainId @param {Record<string, unknown>} payload
 */
export async function sendAnalysisEvent(env, chainId, payload) {
  if (!env.IDEA_ANALYSIS) throw new Error('привʼязки IDEA_ANALYSIS (Workflow) немає');
  const instance = await env.IDEA_ANALYSIS.get(chainId);
  await instance.sendEvent({ type: 'artifact', payload });
  return true;
}

/**
 * Бойове io: адреса треду - зі стану ланцюга (звідки просили), документ і
 * текст через outbox, алерт - спільний sendSystemAlert, Drive - best-effort
 * (null = не збережено, у лог і в текст власнику).
 * @param {Env} env @param {string} chainId
 */
export async function productionIo(env, chainId) {
  const chain = await readChain(env, chainId);
  const chatId =
    chain?.state.chat_id ?? (env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null);
  const threadId = chain?.state.thread_id ?? env.TOPIC_ASSISTANT ?? null;
  const post = async (
    /** @type {'send' | 'document'} */ kind,
    /** @type {Record<string, unknown>} */ payload,
  ) => {
    if (chatId == null) throw new Error('TELEGRAM_CHAT_ID не задано');
    await enqueueOutbox(env, { chatId, threadId, kind, payload }, Date.now());
    await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
      console.error(`idea-analysis ${chainId}: драйн outbox впав, доставить sweeper`, e?.message);
    });
  };
  return /** @type {AnalysisIo} */ ({
    now: () => Date.now(),
    send: (text, btns) =>
      post('send', { text, ...(btns ? { reply_markup: { inline_keyboard: btns } } : {}) }),
    sendDocument: (filename, content, caption) => post('document', { filename, content, caption }),
    alert: async (text) => void (await sendSystemAlert(env, text, Date.now())),
    dispatch: (inputs) => dispatchIdeaAnalysis(env, inputs),
    uploadDrive: async (name, content) => {
      try {
        const folderId = await ensureFolderPath(env, DRIVE_FOLDER_PATH);
        const up = await uploadFile(env, {
          name,
          parentId: folderId,
          bytes: new TextEncoder().encode(content),
          mimeType: 'text/markdown',
        });
        return up.id;
      } catch (/** @type {any} */ e) {
        console.error(`idea-analysis ${chainId}: копія в Drive не збережена`, e?.message);
        return null;
      }
    },
    finishRun: async (runId, error) => {
      await registryFinish(env, runId, { finishedMs: Date.now(), error, steps: 1 });
    },
  });
}

/** Workflow-клас (wrangler.jsonc `workflows`, worker.js export). */
export class IdeaAnalysis extends WorkflowEntrypoint {
  /**
   * @override
   * @param {any} event - WorkflowEvent<AnalysisParams>
   * @param {any} step - WorkflowStep
   */
  async run(event, step) {
    const env = /** @type {Env} */ (this.env);
    const params = /** @type {AnalysisParams} */ (event.payload);
    const io = await productionIo(env, params.chainId);
    try {
      return await runIdeaAnalysisChain(env, params, step, io);
    } catch (/** @type {any} */ e) {
      console.error(`idea-analysis chain ${params.chainId} впав`, e?.message);
      await setAnalysisState(env, params.chainId, { status: 'failed', awaiting: null }).catch(
        () => {},
      );
      throw e;
    }
  }
}
