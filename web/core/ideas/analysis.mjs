// Аналіз ідеї по коду (01 §3.9, 07 §6 Workflow IdeaAnalysis, S-3-3…S-3-5,
// S-3-8; етап 4 PR-2). `ideas.analyze(mode=code)` → startIdeaAnalysis:
// репо з переліку, HEAD-sha через GitHub API (REPO_READ_PAT), кеш за
// `ideas.head_sha` (той самий sha + є звіт = попередній документ без прогону,
// кнопка «Все одно запустити»), інакше - рядок у `chains` (kind idea), прогін
// у RunRegistry (trigger actions, стеля сторожа понад очікування артефакту)
// і інстанс Workflow.
//
// Машина станів runIdeaAnalysisChain: dispatch idea-analysis.yml
// (workflow_dispatch, inputs = контракт) → waitForEvent(artifact) → Drive →
// зберегти (ideas.analysis_md, head_sha, статус «план готовий») → «Коротко»
// + документ у тред → done; failed/таймаут/збій dispatch → статус назад,
// «Аналіз не вдався» власнику + алерт у TOPIC_SYSTEM (S-3-5). Подія artifact
// приходить із /internal/artifact (Actions підписує run_id). Життя прогону в
// RunRegistry закриває ЛИШЕ Workflow - на кожному термінальному шляху.
//
// Кожен побічний ефект - окремий step.do (ревʼю PR-2): Workflows повторюють
// крок, що кинув, цілком, і два ефекти в одному кроці означали б подвоєне
// повідомлення чи другий файл у Drive після збою на другому з них. Dispatch -
// без повторів: таймаут після того, як GitHub уже прийняв запит, породив би
// другий раннер. Вихід у світ - через io, як у DayPlanChain.

import { WorkflowEntrypoint } from 'cloudflare:workers';
import { GITHUB_API, ghHeaders, ghOwner, ghRepoSlug } from '../adapters/github.mjs';
import { enqueueOutbox, drainOutbox, sendDocument, sendSystemAlert } from '../tg/outbox.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import { registryBegin, registryFinish } from '../run-registry/client.mjs';
import { uploadMarkdown } from '../adapters/drive.mjs';
import { setChainState, readChainState } from '../chains/state.mjs';
import {
  IDEA_REPOS,
  DISPATCH_INPUTS,
  DISPATCH_IDEA_MAX,
  JOB_TIMEOUT_MIN,
  IDEA_TEXT_MAX,
} from './contract.mjs';
// Лише функція (виклик у рантаймі): ideas.mjs імпортує цей модуль, і будь-яка
// константа звідти на верхньому рівні тут упала б у TDZ циклу.
import { logIdeaEvent } from '../tools/ideas.mjs';

export { IDEA_REPOS, DISPATCH_INPUTS, DISPATCH_IDEA_MAX, JOB_TIMEOUT_MIN };

/**
 * Текст ідеї для inputs воркфлоу: тіло, а без тіла - заголовок.
 *
 * ⚠️ GitHub відповідає 422 «Required input 'idea' not provided» на ПОРОЖНІЙ
 * рядок в обовʼязковому вході - тобто ідея, записана одним заголовком (а це
 * звичайна річ: «ТЕСТ - додати темну тему»), ламала аналіз по коду ще до
 * старту раннера. Прогін 08.09.
 * @param {{ title?: unknown, body_md?: unknown }} idea
 */
export function ideaTextForDispatch(idea) {
  const body = String(idea.body_md ?? '').trim();
  return body || String(idea.title ?? '').trim();
}

export const CHAIN_KIND = 'idea';
export const ANALYSIS_PROFILE = 'idea-analysis';
/** Очікування артефакту: стеля job + запас на чергу раннера (ревʼю PR-2: 2 хв
 *  не покривали чергу - повний звіт прилітав у вже закритий ланцюг). */
export const WAIT_ARTIFACT_MS = (JOB_TIMEOUT_MIN + 10) * 60_000;
/** Сторож RunRegistry для цього прогону - завжди ПІСЛЯ кінця очікування:
 *  загальні 6 хв закрили б run_id до артефакту. */
export const ANALYSIS_RUN_STALE_MS = WAIT_ARTIFACT_MS + 3 * 60_000;
/** Кап analysis_md у D1 (= IDEA_TEXT_MAX реєстру); повний звіт - у документі й Drive. */
export const ANALYSIS_MD_MAX = IDEA_TEXT_MAX;
/** «Коротко» в чат ≤ 600 символів (code-reviewer.md «Формат відповіді»). */
export const SHORT_MAX = 600;
export const DRIVE_FOLDER_PATH = ['Світанок', 'ideas'];
const WORKFLOW_FILE = 'idea-analysis.yml';
const GITHUB_TIMEOUT_MS = 10_000;
/** Модель Код-оглядача - з front-matter code-reviewer.md (той самий id, що в мозку). */
const ANALYSIS_MODEL = 'claude-sonnet-5';
const TRUNCATED_NOTE = '\n\n…(звіт обрізано для бази; повний - у документі й Drive)';

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
 * @typedef {{ retries?: { limit: number, delay: string | number, backoff?: string } }} StepConfig
 * @typedef {{
 *   do: <T>(name: string, cfgOrFn: StepConfig | (() => Promise<T>), fn?: () => Promise<T>) => Promise<T>,
 *   waitForEvent: (name: string, opts: { type: string, timeout: string }) => Promise<{ payload: any }>,
 * }} AnalysisStep
 * @typedef {{ chainId: string, ideaId: string, runId: string, repo: string, sha: string,
 *   prevStatus: string, chatId: number, threadId: string | null }} AnalysisParams
 */

/** @param {Env} env */
function db(env) {
  if (!env.DB) throw new Error('привʼязки DB немає - аналіз недоступний');
  return env.DB;
}

/**
 * HEAD default-гілки репо (кеш S-3-4). Без REPO_READ_PAT - явна відмова: тихо
 * запускати аналіз без кешу означало б 40 хв Actions на кожне «проаналізуй».
 * @param {Env} env @param {string} repo
 */
export async function fetchHeadSha(env, repo) {
  const token = String(env.REPO_READ_PAT ?? '').trim();
  if (!token) throw new Error('REPO_READ_PAT не задано в Cloudflare - аналіз по коду недоступний');
  if (!IDEA_REPOS.includes(repo)) throw new Error(`repo «${repo}» поза переліком`);
  const res = await fetch(`${GITHUB_API}/repos/${ghOwner(env)}/${repo}/commits/HEAD`, {
    headers: ghHeaders(token, {
      accept: 'application/vnd.github.sha',
      agent: 'svitanok-idea-analysis',
    }),
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
 * @param {Env} env @param {Record<string, string>} inputs
 */
export async function dispatchIdeaAnalysis(env, inputs) {
  const token = String(env.GH_DISPATCH_TOKEN ?? '').trim();
  if (!token) throw new Error('GH_DISPATCH_TOKEN не задано');
  /** @type {Record<string, string>} */
  const body = {};
  for (const k of DISPATCH_INPUTS) body[k] = String(inputs[k] ?? '');
  const res = await fetch(
    `${GITHUB_API}/repos/${ghRepoSlug(env)}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    {
      method: 'POST',
      headers: ghHeaders(token, { agent: 'svitanok-idea-analysis', json: true }),
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
 * Репо для ідеї: явний аргумент → колонка ideas.repo → domain, якщо він сам є
 * репозиторієм (svitanok); інакше - чесне питання власнику (S-3-2/S-3-8).
 * @param {{ repo: string | null, domain: string | null }} idea @param {unknown} arg
 */
export function resolveRepo(idea, arg) {
  const explicit = String(arg ?? '').trim();
  const byDomain = idea.domain && IDEA_REPOS.includes(idea.domain) ? idea.domain : '';
  const repo = explicit || idea.repo || byDomain;
  if (!repo) throw new Error(`вкажи repo (одне з: ${IDEA_REPOS.join(', ')})`);
  if (!IDEA_REPOS.includes(repo)) {
    throw new Error(`Доступ є лише до ${IDEA_REPOS.join(', ')} - не до «${repo}»`);
  }
  return repo;
}

/**
 * Розділ «## Коротко» звіту (≤ SHORT_MAX) - у чат; без розділу - початок.
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

/** Звіт під кап бази - з позначкою, щоб кешована копія не видавала себе за повну. @param {string} md */
export function clipAnalysis(md) {
  if (md.length <= ANALYSIS_MD_MAX) return md;
  return md.slice(0, ANALYSIS_MD_MAX - TRUNCATED_NOTE.length) + TRUNCATED_NOTE;
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
 * @returns {Promise<{ id: string, status: string, ideaId: string } | null>}
 */
export async function findAnalysisByRun(env, runId) {
  const row = /** @type {{ id: string, status: string, idea_id: string } | null} */ (
    await db(env)
      .prepare(
        `SELECT id, status, json_extract(state_json, '$.idea_id') AS idea_id FROM chains
           WHERE kind = ? AND json_extract(state_json, '$.run_id') = ? LIMIT 1`,
      )
      .bind(CHAIN_KIND, runId)
      .first()
  );
  return row
    ? { id: String(row.id), status: String(row.status), ideaId: String(row.idea_id) }
    : null;
}

/**
 * «↩» після старту (undo ideas.analyze): ланцюг - cancelled, і подія будить
 * Workflow одразу (ревʼю PR-2: інакше він спав би до кінця очікування, а
 * прогін висів у реєстрі). Actions зупинити нема як (dispatch не повертає id
 * запуску) - його артефакт упреться в 409, і це чесний мінімум.
 * @param {Env} env @param {string} chainId
 */
export async function cancelAnalysis(env, chainId) {
  const { meta } = await db(env)
    .prepare(
      `UPDATE chains SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('running', 'waiting')`,
    )
    .bind(new Date().toISOString(), chainId)
    .run();
  if (!meta?.changes) return false;
  try {
    await sendAnalysisEvent(env, chainId, { status: 'cancelled' });
  } catch (/** @type {any} */ e) {
    console.error(
      `idea-analysis ${chainId}: подія cancelled не доставлена (закриє таймаут)`,
      e?.message,
    );
  }
  return true;
}

/** Повернути ideas.repo після «↩» (старт міг його переписати). @param {Env} env @param {string} ideaId @param {string | null} repo */
export async function restoreIdeaRepo(env, ideaId, repo) {
  await db(env).prepare('UPDATE ideas SET repo = ? WHERE id = ?').bind(repo, ideaId).run();
}

/** Дата останнього успішного аналізу по коду («не змінювався з DD.MM»). @param {Env} env @param {string} ideaId */
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
 * Адреса треду, з якого просили аналіз (та сама мапа, що parsedForThread
 * prerouter-а): тред 'dm' = приватний чат власника, тема - спільний чат;
 * без контексту - тема «Асистент». Без чату - помилка, не тиша (ревʼю PR-2).
 * @param {Env} env @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx
 */
export function targetOf(env, ctx) {
  const key = ctx.threadId == null ? null : String(ctx.threadId);
  const isDm = key === 'dm';
  const chatId =
    ctx.chatId != null
      ? Number(ctx.chatId)
      : isDm
        ? env.TELEGRAM_OWNER_USER_ID
          ? Number(env.TELEGRAM_OWNER_USER_ID)
          : null
        : env.TELEGRAM_CHAT_ID
          ? Number(env.TELEGRAM_CHAT_ID)
          : null;
  const threadId = isDm
    ? null
    : (key ?? (env.TOPIC_ASSISTANT == null ? null : String(env.TOPIC_ASSISTANT)));
  if (chatId == null)
    throw new Error('немає чату для відповіді (TELEGRAM_CHAT_ID / контекст прогону)');
  return { chatId, threadId };
}

/**
 * Старт аналізу по коду з чату (виконавець ideas.analyze mode=code, T0).
 * Повертає результат для моделі; документ і кнопка кешу йдуть у тред самі.
 * @param {Env} env
 * @param {import('../tools/ideas.mjs').IdeaRow} idea
 * @param {{ repo?: unknown, force?: unknown }} args
 * @param {number} nowMs
 * @param {{ chatId?: number | string | null, threadId?: number | string | null }} ctx
 */
export async function startIdeaAnalysis(env, idea, args, nowMs, ctx) {
  const repo = resolveRepo(idea, args.repo);
  // Порожня ідея - відмова ДО запуску job'а: інакше 40-хвилинний раннер
  // стартував би заради тексту, якого немає, а GitHub і зовсім відповів би
  // 422 на порожній обовʼязковий вхід (прогін 08.09).
  if (!ideaTextForDispatch(idea)) {
    throw new Error(
      `в ідеї #${idea.number} немає тексту - додай опис, інакше аналізувати нема чого`,
    );
  }
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
  const sha = await fetchHeadSha(env, repo);
  const target = targetOf(env, ctx);
  if (!args.force && idea.head_sha === sha && idea.analysis_md) {
    const since = ddmm(await lastAnalyzedAt(env, idea.id));
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
    await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
      console.error('idea-analysis: драйн outbox впав (sweeper добере)', e?.message),
    );
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
  /** @type {AnalysisParams} */
  const params = {
    chainId,
    ideaId: idea.id,
    runId,
    repo,
    sha,
    prevStatus: idea.status,
    chatId: target.chatId,
    threadId: target.threadId,
  };
  await db(env)
    .prepare(
      `INSERT INTO chains (id, kind, workflow_id, state_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'waiting', ?, ?)`,
    )
    .bind(
      chainId,
      CHAIN_KIND,
      chainId,
      JSON.stringify({ idea_id: idea.id, run_id: runId, repo, sha }),
      iso,
      iso,
    )
    .run();
  await registryBegin(env, {
    id: runId,
    trigger: 'actions',
    profile: ANALYSIS_PROFILE,
    threadId: target.threadId ?? 'dm',
    chatId: target.chatId,
    model: ANALYSIS_MODEL,
    startedMs: nowMs,
    staleMs: ANALYSIS_RUN_STALE_MS,
  });
  await db(env)
    .prepare(`UPDATE ideas SET status = 'в аналізі', repo = ?, updated_at = ? WHERE id = ?`)
    .bind(repo, iso, idea.id)
    .run();
  await logIdeaEvent(env, idea.id, 'analysis', `code: dispatch ${repo}@${sha.slice(0, 7)}`, nowMs);
  try {
    await env.IDEA_ANALYSIS.create({ id: chainId, params });
  } catch (/** @type {any} */ e) {
    // Інстанса немає - ланцюг не сміє лишитись waiting назавжди (кожен наступний
    // запит бачив би «вже йде»): відкат до стану до старту, помилка - моделі.
    await markAnalysisCrashed(
      env,
      params,
      `Workflow не створено: ${String(e?.message ?? e)}`,
      nowMs,
      false,
    );
    throw new Error(`Workflow аналізу не стартував: ${String(e?.message ?? e)}`, { cause: e });
  }
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
    prev: { id: idea.id, status: idea.status, repo: idea.repo, chain_id: chainId },
  };
}

/**
 * Аварійне закриття (Workflow не створено / впав повз машину станів): ланцюг
 * failed, статус ідеї назад, прогін закрито, алерт - помилка видима (S-3-5).
 * @param {Env} env @param {AnalysisParams} p @param {string} reason @param {number} nowMs @param {boolean} alert
 */
export async function markAnalysisCrashed(env, p, reason, nowMs, alert = true) {
  const iso = new Date(nowMs).toISOString();
  await db(env)
    .prepare(`UPDATE ideas SET status = ?, updated_at = ? WHERE id = ? AND status = 'в аналізі'`)
    .bind(p.prevStatus, iso, p.ideaId)
    .run();
  await logIdeaEvent(env, p.ideaId, 'analysis', `code failed: ${reason.slice(0, 200)}`, nowMs);
  await setChainState(env, p.chainId, { status: 'failed', awaiting: null });
  await registryFinish(env, p.runId, {
    finishedMs: nowMs,
    error: `actions: ${reason.slice(0, 100)}`,
    steps: 1,
  });
  if (alert)
    await sendSystemAlert(
      env,
      `Аналіз ідеї по коду ${p.repo}@${p.sha.slice(0, 7)} впав: ${reason.slice(0, 300)}`,
      nowMs,
    );
}

// ── Машина станів Workflow ─────────────────────────────────────────────────

/**
 * @param {Env} env
 * @param {AnalysisParams} params
 * @param {AnalysisStep} step
 * @param {AnalysisIo} io
 */
export async function runIdeaAnalysisChain(env, params, step, io) {
  const { chainId, ideaId, runId, repo, sha, prevStatus } = params;
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
    await step.do('fail-db', async () => {
      await db(env)
        .prepare(
          `UPDATE ideas SET status = ?, updated_at = ? WHERE id = ? AND status = 'в аналізі'`,
        )
        .bind(prevStatus, new Date(io.now()).toISOString(), ideaId)
        .run();
      await logIdeaEvent(env, ideaId, 'analysis', `code failed: ${reason.slice(0, 200)}`, io.now());
      await setChainState(env, chainId, { status: 'failed', awaiting: null });
    });
    await step.do('fail-run', () => io.finishRun(runId, `actions: ${reason.slice(0, 100)}`));
    await step.do('fail-notify', () =>
      io.send(`Аналіз ідеї #${idea.number} не вдався (лог у системному чаті).`),
    );
    await step.do('fail-alert', () =>
      io.alert(
        `Аналіз ідеї #${idea.number} по коду ${repo}@${sha.slice(0, 7)} не вдався: ${reason.slice(0, 300)}`,
      ),
    );
    return { outcome: 'failed', reason };
  };

  try {
    // Без повторів: другий dispatch = другий job на ту саму ідею. Рушій
    // Workflows вимагає `delay` навіть при limit 0 - без нього крок падає
    // WorkflowFatalError «invalid format» (приймання 06.09).
    await step.do('dispatch', { retries: { limit: 0, delay: 0 } }, () =>
      io.dispatch({
        run_id: runId,
        idea_id: ideaId,
        repo,
        sha,
        title: String(idea.title ?? '').slice(0, 200),
        // ⚠️ `idea` у воркфлоу - required, а GitHub вважає ПОРОЖНІЙ рядок
        // ненаданим входом і відповідає 422 «Required input 'idea' not
        // provided» (прогін 08.09: ідея без опису). Тому текст = тіло, а якщо
        // тіла немає - заголовок; порожнечу відсіює перевірка вище.
        idea: ideaTextForDispatch(idea).slice(0, DISPATCH_IDEA_MAX),
      }),
    );
  } catch (/** @type {any} */ e) {
    return fail(`dispatch: ${String(e?.message ?? e).slice(0, 200)}`);
  }

  // Таймаут очікування у Workflows - виняток; тут це чесний null (S-3-5).
  /** @type {{ status?: string, md?: string, reason?: string, partial?: boolean } | null} */
  const artifact = await step
    .waitForEvent('wait-artifact', {
      type: 'artifact',
      timeout: `${Math.ceil(WAIT_ARTIFACT_MS / 1000)} seconds`,
    })
    .then((ev) => ev?.payload ?? null)
    .catch(() => null);

  // «↩» після старту: результат відкидається мовчки (власник сам скасував).
  const cancelled = await step.do(
    'cancelled',
    async () =>
      artifact?.status === 'cancelled' ||
      (await readChainState(env, chainId))?.status === 'cancelled',
  );
  if (cancelled) {
    await step.do('discard', () => io.finishRun(runId, 'cancelled'));
    return { outcome: 'cancelled' };
  }
  if (!artifact) return fail(`таймаут ${WAIT_ARTIFACT_MS / 60_000} хв - Actions не відповів`);
  if (artifact.status !== 'ok' || typeof artifact.md !== 'string' || !artifact.md.trim()) {
    return fail(String(artifact.reason ?? 'Actions: failed').slice(0, 300));
  }

  const md = artifact.md;
  const partial = artifact.partial === true;
  // Drive - окремим кроком ДО бази: повтор save після збою D1 не заливав би
  // другий файл (крок памʼятає результат).
  const driveId = await step.do('drive', () => io.uploadDrive(analysisFilename(idea.number), md));
  await step.do('save', async () => {
    const nowMs = io.now();
    await db(env)
      .prepare(
        `UPDATE ideas SET analysis_md = ?, head_sha = ?, repo = ?, artifact_drive_id = COALESCE(?, artifact_drive_id),
           status = 'план готовий', updated_at = ? WHERE id = ?`,
      )
      .bind(clipAnalysis(md), sha, repo, driveId, new Date(nowMs).toISOString(), ideaId)
      .run();
    await logIdeaEvent(
      env,
      ideaId,
      'analysis',
      `code ok ${repo}@${sha.slice(0, 7)}${partial ? ' (частковий)' : ''}${driveId ? '' : ' (без Drive)'}`,
      nowMs,
    );
    await setChainState(env, chainId, { status: 'done', awaiting: null });
  });
  await step.do('finish-run', () => io.finishRun(runId, null));
  await step.do('deliver-text', () =>
    io.send(
      `📄 Аналіз ідеї #${idea.number} «${idea.title}» по коду ${repo}@${sha.slice(0, 7)}${partial ? ' (частковий - не вклався у стелю ходів)' : ''}:\n${shortOf(md)}${driveId ? '' : '\n(копію в Drive не збережено - див. лог)'}`,
    ),
  );
  await step.do('deliver-doc', () =>
    io.sendDocument(analysisFilename(idea.number), md, `Повний звіт: ідея #${idea.number}`),
  );
  return { outcome: 'done', driveId };
}

/**
 * Подія в ланцюг аналізу (з /internal/artifact або скасування).
 * @param {Env} env @param {string} chainId @param {Record<string, unknown>} payload
 */
export async function sendAnalysisEvent(env, chainId, payload) {
  if (!env.IDEA_ANALYSIS) throw new Error('привʼязки IDEA_ANALYSIS (Workflow) немає');
  const instance = await env.IDEA_ANALYSIS.get(chainId);
  await instance.sendEvent({ type: 'artifact', payload });
  return true;
}

/**
 * Бойове io: адреса треду - з параметрів (звідки просили), документ і текст
 * через outbox, алерт - спільний sendSystemAlert, Drive - best-effort
 * (null = не збережено, у лог і в текст власнику).
 * @param {Env} env @param {AnalysisParams} p
 */
export function productionIo(env, p) {
  const post = async (
    /** @type {'send' | 'document'} */ kind,
    /** @type {Record<string, unknown>} */ payload,
    /** @type {import('../tg/markdown.mjs').MdPart[]} [parts] */ parts,
  ) => {
    await enqueueOutbox(
      env,
      { chatId: p.chatId, threadId: p.threadId, kind, payload, parts },
      Date.now(),
    );
    await drainOutbox(env, { nowMs: Date.now() }).catch((/** @type {any} */ e) => {
      console.error(`idea-analysis ${p.chainId}: драйн outbox впав, доставить sweeper`, e?.message);
    });
  };
  return /** @type {AnalysisIo} */ ({
    now: () => Date.now(),
    // «Коротко» зі звіту - Markdown → HTML Telegram, як deliver.
    send: (text, btns) =>
      post('send', btns ? { reply_markup: { inline_keyboard: btns } } : {}, renderMdParts(text)),
    sendDocument: (filename, content, caption) =>
      sendDocument(
        env,
        { chatId: p.chatId, threadId: p.threadId },
        { filename, content, caption },
        Date.now(),
      ),
    alert: async (text) => void (await sendSystemAlert(env, text, Date.now())),
    dispatch: (inputs) => dispatchIdeaAnalysis(env, inputs),
    uploadDrive: (name, content) =>
      uploadMarkdown(env, DRIVE_FOLDER_PATH, name, content, `idea-analysis ${p.chainId}`),
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
    try {
      return await runIdeaAnalysisChain(env, params, step, productionIo(env, params));
    } catch (/** @type {any} */ e) {
      // Збій повз машину станів (крок вичерпав повтори): той самий видимий
      // фінал, що й у fail() - статус, прогін, алерт (ревʼю PR-2).
      console.error(`idea-analysis chain ${params.chainId} впав`, e?.message);
      await markAnalysisCrashed(env, params, String(e?.message ?? e), Date.now()).catch(
        (/** @type {any} */ e2) =>
          console.error(`idea-analysis ${params.chainId}: аварійне закриття впало`, e2?.message),
      );
      throw e;
    }
  }
}
