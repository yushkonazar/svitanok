// Prerouter (01 §2.1, ADR-039, етап 2 PR-3): вхідна точка НОВОГО шляху для
// повідомлень у темі «Асистент» і DM. Детермінований: команди → нові
// обробники або легасі; «стоп» → abort; решта → класифікація N3 (quick/chat)
// → черга треду (RunRegistry DO) → статусник → POST /run мозку.
//
// Режими (01 §5, ADR-039): off - модуля «не існує» (handled=false завжди);
// shadow - повний шлях ЛИШЕ для префікса `v2:` (чеклист приймання на робочому
// боті), решта класифікується і пише рядок у runs, а відповідає легасі;
// on - повний шлях для всього.

import { tgCall } from '../telegram-client.mjs';
import { enqueueOutbox, drainOutbox } from './tg/outbox.mjs';
import {
  registryBegin,
  registryFinish,
  registryThreadClaim,
  registryThreadSetRun,
  registryThreadClear,
  registryThreadFinish,
  registryThreadRetry,
  registryThreadKickNext,
  registryThreadsSnapshot,
} from './run-registry/client.mjs';
import { callBrainRun, callBrainAbort } from './brain/run-client.mjs';

export const THREAD_DM = 'dm';
export const STATUS_DRAFT = '▸ Думаю…';
export const START_MAX_ATTEMPTS = 3;

const MODELS = { chat: 'claude-sonnet-5', quick: 'claude-haiku-4-5' };

// N3 (04-scenarios §N3): якорі власних даних - будь-який збіг = chat.
// Суперсет канону безпечний: хибний chat коштує лише секунд, хибний quick -
// відповіді без даних власника.
const ANCHOR_RE =
  /(мій|моя|мої|мене|мені|зустріч|календар|пошт|лист|нагада|запиши|збережи|знайди в|покажи|витрат|іде[яїй]|бажан|поїздк|столик|чат)/i;
const URL_RE = /https?:\/\/|www\./i;
const FACT_QUESTION_RE = /(скільки|коли|хто такий|хто така|хто |що таке|який рік|якого року)/i;
const NUMBER_OP_RE = /\d[\d\s.,]*\s*[%+\-*/×÷^]|[%+\-*/×÷^]\s*\d/;

/** Класифікація N3: тривіальне → quick, решта → chat.
 *  @param {string} text */
export function classifyRoute(text) {
  const t = text.trim();
  if (t.length > 120) return 'chat';
  if (ANCHOR_RE.test(t)) return 'chat';
  if (URL_RE.test(t)) return 'chat';
  if (NUMBER_OP_RE.test(t) || FACT_QUESTION_RE.test(t)) return 'quick';
  return 'chat';
}

/** Нові команди (07 §10: /new + підказки R26). null = не наша - легасі.
 *  @param {string} text */
export function parseNewCommand(text) {
  const m = text.trim().match(/^\/(new|idea|wish|money|inbox|status|forget)(?:@\w+)?(?:\s|$)/);
  return m ? /** @type {string} */ (m[1]) : null;
}

/** Підказки R26: підставляють текст - працює все і без команд. */
const HINTS = {
  idea: 'Напиши: «збережи ідею: …» - і я занесу її в реєстр.',
  wish: 'Напиши: «хочу …» (гра, покупка, поїздка) - поставлю на відстеження.',
  money: 'Напиши: «витрати за тиждень» або «куди пішли гроші в серпні».',
  inbox: 'Напиши: «знайди в чаті <назва> …» - пошук по збережених чатах.',
};

/**
 * Головний вхід з worker.js. true = оброблено новим шляхом (легасі не чіпати).
 * @param {Env} env
 * @param {{ kind: string, chatId: number | null, threadId: number | string | null, text?: string, messageId?: number | null }} parsed
 * @param {number} [nowMs]
 */
export async function prerouteMessage(env, parsed, nowMs = Date.now()) {
  const mode = env.ASSISTANT_V2;
  if (mode !== 'shadow' && mode !== 'on') return false;
  if (parsed.kind !== 'message' || parsed.chatId == null) return false;
  let text = String(parsed.text ?? '').trim();
  if (!text) return false;
  // Той самий периметр, що в легасі (commands.mjs): тема «Асистент» або DM.
  const inAssistant =
    parsed.threadId == null || String(parsed.threadId) === String(env.TOPIC_ASSISTANT ?? '');
  if (!inAssistant) return false;

  if (mode === 'shadow') {
    if (!/^v2:/i.test(text)) {
      await shadowClassifyLog(env, parsed, text, nowMs);
      return false;
    }
    text = text.replace(/^v2:\s*/i, '');
    if (!text) return false;
  }

  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  const send = (/** @type {string} */ body) => reply(env, parsed, body, nowMs);

  const cmd = parseNewCommand(text);
  if (cmd) {
    if (cmd in HINTS) {
      await send(HINTS[/** @type {keyof typeof HINTS} */ (cmd)]);
      return true;
    }
    if (cmd === 'new') {
      await resetThreadSession(env, threadKey, nowMs);
      await send('Почали з чистого аркуша.');
      return true;
    }
    if (cmd === 'status') {
      await send(await systemStatusLine(env));
      return true;
    }
    // /forget: меню T2 потребує колекцій (етап 3) і чатів (етап 6) - чесна
    // заглушка замість порожнього меню.
    await send('Забування приїде разом із колекціями (етап 3) і чатами (етап 6).');
    return true;
  }
  // Інші /-команди - легасі (07 §10: «лишаються як є»).
  if (text.startsWith('/')) return false;

  if (/^стоп[.!]?$/i.test(text)) {
    await stopThread(env, parsed, threadKey, nowMs);
    return true;
  }

  const route = classifyRoute(text);
  const claim = await registryThreadClaim(env, threadKey, { text, route, atMs: nowMs });
  if ('queued' in claim) {
    await send(
      claim.queued === -1 ? 'Черга повна - спробуй трохи пізніше.' : `▸ Черга: ${claim.queued}`,
    );
    return true;
  }
  await startClaimedRun(env, parsed, threadKey, { text, route, attempts: 0, atMs: nowMs }, nowMs);
  return true;
}

/**
 * Прогін для ВЖЕ взятого треду (claim start / kick / ескалація): статусник →
 * begin → сесія з D1 → POST /run. Невдалий старт - S-0-7: ретрай через чергу
 * (стеля START_MAX_ATTEMPTS), «підняття» робить задача brain-health.
 * @param {Env} env
 * @param {{ chatId: number | null, threadId: number | string | null }} parsed
 * @param {string} threadKey
 * @param {{ text: string, route: string, attempts: number, atMs: number, statusMessageId?: number | null }} entry
 * @param {number} nowMs
 * @param {number | null} [reuseStatusId] - ескалація quick→chat редагує той
 *   самий статусник, нового не шле
 */
export async function startClaimedRun(env, parsed, threadKey, entry, nowMs, reuseStatusId = null) {
  const statusMessageId = reuseStatusId ?? (await sendStatusDraft(env, parsed));
  const runId = crypto.randomUUID();
  await registryBegin(env, {
    id: runId,
    trigger: entry.route,
    profile: entry.route,
    threadId: threadKey,
    model: MODELS[/** @type {'chat' | 'quick'} */ (entry.route)] ?? null,
    startedMs: nowMs,
  });
  await registryThreadSetRun(env, threadKey, runId, statusMessageId);

  const sess = entry.route === 'chat' ? await readSession(env, threadKey) : null;
  const res = await callBrainRun(
    env,
    {
      runId,
      profile: /** @type {'chat' | 'quick'} */ (entry.route),
      threadId: threadKey,
      inputText: entry.text,
      tainted: sess?.tainted ?? false,
      ...(statusMessageId != null ? { statusMessageId } : {}),
      ...(sess
        ? { session: { sdk_session_id: sess.sdkSessionId, summary_md: sess.summaryMd } }
        : {}),
    },
    nowMs,
  );
  if (res.ok) return;

  // Мозок не взяв: закрити прогін, повернути запит у чергу або чесно здатись.
  await registryFinish(env, runId, { finishedMs: nowMs, error: `brain-start: ${res.status}` });
  console.error(`prerouter: /run не стартував (${res.status} ${res.detail})`);
  const attempts = entry.attempts + 1;
  if (attempts >= START_MAX_ATTEMPTS) {
    await registryThreadFinishAndKick(env, parsed, threadKey, nowMs);
    await editStatus(
      env,
      parsed,
      statusMessageId,
      'Не вдалося - мозок недоступний. Напиши пізніше.',
      nowMs,
    );
    return;
  }
  await registryThreadRetry(env, threadKey, { ...entry, attempts, statusMessageId });
  await editStatus(
    env,
    parsed,
    statusMessageId,
    'Мозок недоступний - спробую ще раз за ~5 хв.',
    nowMs,
  );
}

/**
 * Після завершення прогону треду (кличе handleRuns роутера): віддати чергу.
 * @param {Env} env
 * @param {{ chatId: number | null, threadId: number | string | null }} parsed
 * @param {string} threadKey
 * @param {number} nowMs
 */
export async function registryThreadFinishAndKick(env, parsed, threadKey, nowMs) {
  const { next } = await registryThreadFinish(env, threadKey);
  if (next)
    await startClaimedRun(env, parsed, threadKey, next, nowMs, next.statusMessageId ?? null);
}

/**
 * «Підняття» черг після відновлення мозку (задача brain-health, S-0-7):
 * вільні треди з чергою стартують голову.
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function kickPendingThreads(env, nowMs = Date.now()) {
  const threads = await registryThreadsSnapshot(env);
  let kicked = 0;
  for (const [threadKey, t] of Object.entries(threads)) {
    if (t.activeRunId != null || t.queue.length === 0) continue;
    const { next } = await registryThreadKickNext(env, threadKey);
    if (!next) continue;
    const parsed = parsedForThread(env, threadKey);
    await startClaimedRun(env, parsed, threadKey, next, nowMs, next.statusMessageId ?? null);
    kicked += 1;
  }
  return { kicked };
}

/** @typedef {{ chatId: number | null, threadId: number | string | null }} ThreadTarget */

/** «стоп» (S-0-3): очистити чергу, абортнути активний прогін, чесний підпис.
 *  @param {Env} env @param {ThreadTarget} parsed @param {string} threadKey @param {number} nowMs */
async function stopThread(env, parsed, threadKey, nowMs) {
  const { activeRunId, statusMessageId, cleared } = await registryThreadClear(env, threadKey);
  if (activeRunId == null && cleared === 0) {
    await reply(env, parsed, 'Нема чого зупиняти.', nowMs);
    return;
  }
  if (activeRunId != null) {
    const res = await callBrainAbort(env, activeRunId, nowMs);
    if (!res.ok) console.error(`prerouter: abort ${activeRunId} не пройшов: ${res.detail}`);
    await registryFinish(env, activeRunId, { finishedMs: nowMs, error: 'stopped' });
  }
  if (statusMessageId != null) await editStatus(env, parsed, statusMessageId, 'Зупинив.', nowMs);
  else await reply(env, parsed, 'Зупинив.', nowMs);
}

/** Shadow-класифікація без відповіді (01 §5): рядок у runs для приймального
 *  порівняння - і далі легасі.
 *  @param {Env} env @param {ThreadTarget} parsed @param {string} text @param {number} nowMs */
async function shadowClassifyLog(env, parsed, text, nowMs) {
  const route = classifyRoute(text);
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  const runId = crypto.randomUUID();
  await registryBegin(env, {
    id: runId,
    trigger: route,
    profile: route,
    threadId: threadKey,
    model: null,
    startedMs: nowMs,
  });
  await registryFinish(env, runId, { finishedMs: nowMs, steps: 0 });
}

/** /new (S-0-4): нова sdk-сесія, taint скинуто, згортка ЛИШАЄТЬСЯ.
 *  @param {Env} env @param {string} threadKey @param {number} nowMs */
async function resetThreadSession(env, threadKey, nowMs) {
  if (!env.DB) {
    console.error('prerouter: /new без DB - сесію не скинуто');
    return;
  }
  await env.DB.prepare(
    `INSERT INTO sessions (thread_id, sdk_session_id, started_at, last_at, tainted, turn_count)
     VALUES (?1, NULL, ?2, ?2, 0, 0)
     ON CONFLICT (thread_id) DO UPDATE SET sdk_session_id = NULL, tainted = 0, last_at = ?2`,
  )
    .bind(threadKey, new Date(nowMs).toISOString())
    .run();
}

/** /status: стан системи одним повідомленням (мінімальний зріз PR-3).
 *  @param {Env} env */
async function systemStatusLine(env) {
  const parts = [];
  try {
    const expected = JSON.parse((await env.BRIEFING.get('brainExpected')) ?? 'null');
    parts.push(
      expected?.gitSha ? `Мозок: ${String(expected.gitSha).slice(0, 8)}` : 'Мозок: невідомо',
    );
  } catch {
    parts.push('Мозок: невідомо');
  }
  const threads = await registryThreadsSnapshot(env);
  const active = Object.values(threads).filter((t) => t.activeRunId != null).length;
  const queued = Object.values(threads).reduce((n, t) => n + t.queue.length, 0);
  parts.push(`Прогони: ${active} активних, ${queued} у черзі`);
  parts.push(`Режим: ${env.ASSISTANT_V2}`);
  return parts.join(' · ');
}

// ── Транспортні дрібниці ─────────────────────────────────────────────────────

/** @param {Env} env @param {string} threadKey @returns {ThreadTarget} */
function parsedForThread(env, threadKey) {
  return {
    chatId: env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null,
    threadId: threadKey === THREAD_DM ? null : threadKey,
  };
}

/** Відповідь новим шляхом - через outbox (порядок і 429 як у deliver).
 *  @param {Env} env @param {ThreadTarget} parsed @param {string} text @param {number} nowMs */
async function reply(env, parsed, text, nowMs) {
  if (parsed.chatId == null) return;
  await enqueueOutbox(
    env,
    {
      chatId: parsed.chatId,
      threadId: parsed.threadId == null ? null : parsed.threadId,
      kind: 'send',
      payload: { text },
    },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch((/** @type {any} */ e) =>
    console.error('prerouter: драйн відповіді впав (sweeper добере)', e?.message),
  );
}

/** Статусник «▸ Думаю…» - ПРЯМИЙ sendMessage (потрібен message_id для
 *  стрімінгу, outbox його не повертає). Збій - null: прогін піде без статусу.
 *  @param {Env} env @param {ThreadTarget} parsed */
async function sendStatusDraft(env, parsed) {
  if (parsed.chatId == null) return null;
  try {
    const res = await tgCall(env, 'sendMessage', {
      chat_id: parsed.chatId,
      ...(parsed.threadId != null ? { message_thread_id: Number(parsed.threadId) } : {}),
      text: STATUS_DRAFT,
    });
    const body = /** @type {any} */ (await res.json().catch(() => null));
    const id = body?.result?.message_id;
    return typeof id === 'number' ? id : null;
  } catch (/** @type {any} */ e) {
    console.error('prerouter: статусник не надіслано', e?.message);
    return null;
  }
}

/** @param {Env} env @param {ThreadTarget} parsed @param {number | null} messageId
 *  @param {string} text @param {number} nowMs */
async function editStatus(env, parsed, messageId, text, nowMs) {
  if (messageId == null || parsed.chatId == null) {
    await reply(env, parsed, text, nowMs);
    return;
  }
  await enqueueOutbox(
    env,
    { chatId: parsed.chatId, kind: 'edit', payload: { message_id: messageId, text } },
    nowMs,
  );
  await drainOutbox(env, { nowMs }).catch(() => {});
}

/** Сесія треду з D1 для resume (ADR-038). Збій читання - чесний null-стан
 *  (свіжа сесія) з fail-safe tainted=true, як у router.readThreadTainted.
 *  @param {Env} env @param {string} threadKey */
async function readSession(env, threadKey) {
  if (!env.DB) return { sdkSessionId: null, summaryMd: null, tainted: true };
  try {
    const { results } = await env.DB.prepare(
      'SELECT sdk_session_id, summary_md, tainted FROM sessions WHERE thread_id = ?',
    )
      .bind(threadKey)
      .all();
    const row = /** @type {any} */ (results?.[0]);
    if (!row) return { sdkSessionId: null, summaryMd: null, tainted: false };
    return {
      sdkSessionId: row.sdk_session_id ?? null,
      summaryMd: row.summary_md ?? null,
      tainted: row.tainted === 1,
    };
  } catch (/** @type {any} */ e) {
    console.error('prerouter: читання сесії впало - свіжа сесія, tainted fail-safe', e?.message);
    return { sdkSessionId: null, summaryMd: null, tainted: true };
  }
}
