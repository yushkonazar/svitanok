// Маршрутизатор internal API (етап 1: PR-5 auth, PR-6 tools, PR-7 deliver/
// status через outbox); runs-телеметрія мозку (етап 2) поки чесно відповідає
// 501 not-implemented.
//
// Порядок перевірок: прапорець → метод → розмір → підпис → run_id → nonce →
// контракт → виконання. Дешеве і зовнішнє - першим; жодна гілка не виконує
// роботи до підпису.

import { json, readCappedBody } from '../../http-core.mjs';
import { verifyInternalRequest, INTERNAL_SIG_TTL_MS } from './auth.mjs';
import {
  registryHas,
  registryConsumeNonce,
  registryRunInfo,
  registryFinish,
} from '../run-registry/client.mjs';
import { TOOLS } from '../tools/index.mjs';
import { enqueueOutbox, drainOutbox, dropPendingEdits, sendSystemAlert } from '../tg/outbox.mjs';
import { renderMdParts } from '../tg/markdown.mjs';
import { applyPolicy } from '../policy/proposals.mjs';
import { isTaintActive } from '../policy/core.mjs';
import { writeMemoryChunks } from '../memory.mjs';
import { readRunProfile, saveWeeklyReport } from '../brain/weekly-review.mjs';
import { saveInboxDigest } from '../inbox/digest.mjs';
import { sendChainEvent } from '../chains/registry.mjs';
import { findAnalysisByRun, sendAnalysisEvent } from '../ideas/analysis.mjs';
import { loadInstruction } from '../instructions.mjs';
import {
  WORKER_CHAT_MAX,
  saveWorkerResult,
  sendWorkerDocument,
  uploadWorkerResult,
  workerButtons,
} from '../brain/worker-results.mjs';
import { startClaimedRun, registryThreadFinishAndKick, parsedForThread } from '../prerouter.mjs';
import {
  TOOL_REQUEST_SCHEMA,
  DELIVER_SCHEMA,
  STATUS_SCHEMA,
  RUNS_SCHEMA,
  SESSION_SCHEMA,
  ARTIFACT_SCHEMA,
  INSTRUCTION_SCHEMA,
  TAINT_SCHEMA,
  validateAgainst,
} from './schemas.mjs';

/** Кап тіла: найбільше з контрактів - deliver ≤ 64К тексту; з запасом на JSON.
 *  Публічний ендпоїнт без ліміту розміру - відкриті двері, тож кап ДО читання. */
export const MAX_INTERNAL_BODY_BYTES = 128 * 1024;

/** @type {Record<string, import('./schemas.mjs').InternalSchema>} */
const ROUTE_SCHEMAS = {
  deliver: DELIVER_SCHEMA,
  status: STATUS_SCHEMA,
  runs: RUNS_SCHEMA,
  session: SESSION_SCHEMA,
  artifact: ARTIFACT_SCHEMA,
  instruction: INSTRUCTION_SCHEMA,
  taint: TAINT_SCHEMA,
};

/**
 * POST /internal/* - усі відповіді JSON, помилки з явною причиною.
 * @param {Request} request
 * @param {Env} env
 * @param {number} [nowMs]
 * @param {ExecutionContext} [ctx] - для драйну outbox ПІСЛЯ відповіді
 *   (waitUntil); без нього (юніт-тести) драйн awaited синхронно.
 */
export async function handleInternal(request, env, nowMs = Date.now(), ctx = undefined) {
  // off: коду «не існує» - та сама відповідь, що на будь-який невідомий шлях.
  if (env.ASSISTANT_V2 !== 'shadow' && env.ASSISTANT_V2 !== 'on') {
    return json({ ok: false, error: 'not-found' }, 404);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405);

  // Кап розміру: content-length — дешевий ранній відсів, але вірити йому не
  // можна (на chunked/HTTP2 його просто немає), тож читання — ЛИШЕ потоком зі
  // стелею (readCappedBody рве стрім на першому байті понад кап). Інакше
  // atacker без підпису змушував би матеріалізувати мегабайти ДО криптографії.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_INTERNAL_BODY_BYTES) {
    return json({ ok: false, error: 'body-too-large' }, 413);
  }
  const read = await readCappedBody(request, MAX_INTERNAL_BODY_BYTES);
  if (!read.ok) {
    return read.tooLarge
      ? json({ ok: false, error: 'body-too-large' }, 413)
      : json({ ok: false, error: 'no-body' }, 400);
  }
  const bodyText = read.raw;

  const path = new URL(request.url).pathname;
  const auth = await verifyInternalRequest({
    method: request.method,
    path,
    headers: request.headers,
    bodyText,
    nowMs,
    env,
  });
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  // Прогін мусить бути живим у RunRegistry (07 §3): підпис доводить «хто»,
  // run_id - «навіщо саме зараз». Збій реєстру = відмова, не пропуск.
  if (!(await registryHas(env, auth.runId))) {
    return json({ ok: false, error: 'run-unknown' }, 403);
  }
  // Nonce споживається ПІСЛЯ підпису й run_id (інакше атакер без ключа міг би
  // «випалювати» чужі nonce) і ПЕРЕД будь-якою роботою: повтор підписаного
  // запиту в вікні TTL — реплей, а не друга дія. Памʼять — 2×TTL: доки підпис
  // узагалі міг би пройти, память про nonce мусить жити.
  if (!(await registryConsumeNonce(env, auth.runId, auth.nonce, nowMs, 2 * INTERNAL_SIG_TTL_MS))) {
    return json({ ok: false, error: 'replayed' }, 401);
  }

  /** @type {unknown} */
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    return json({ ok: false, error: 'bad-json' }, 400);
  }

  const toolMatch = path.match(/^\/internal\/tool\/([a-z0-9._-]+)$/);
  if (toolMatch) {
    const name = /** @type {string} */ (toolMatch[1]);
    const tool = TOOLS[name];
    if (!tool) return json({ ok: false, error: 'tool-unknown', tool: name }, 404);
    const envelope = validateAgainst(TOOL_REQUEST_SCHEMA, body);
    if (!envelope.ok) return json({ ok: false, error: `contract: ${envelope.error}` }, 400);
    const args = /** @type {{ args: Record<string, unknown> }} */ (body).args;
    const contract = validateAgainst(tool.args, args);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);

    // Write-інструменти йдуть ЛИШЕ через policy (01 §2.1: policy - єдине
    // місце, що викликає виконавців запису): T0 - виконати + «↩», tainted -
    // ескалація до пропозиції T1 (другий барʼєр, який хук мозку не обійде).
    if (tool.write) {
      // Зазвичай kind інструмента статичний. Виняток - proposals.create
      // (07 §4): він сам НЕ дія, а обгортка «створи пропозицію на дію X», тож
      // рівень підтвердження визначає kind із аргументів. Гілки за іменем
      // інструмента тут немає свідомо: контракт описаний у самому реєстрі
      // (write.kindFrom), і наступний такий інструмент не потребуватиме правки
      // роутера.
      const writeKind =
        tool.write.kind ?? String(/** @type {any} */ (args)?.[tool.write.kindFrom ?? ''] ?? '');
      if (!writeKind) {
        return json({ ok: false, error: 'policy: kind не заданий', tool: name }, 400);
      }
      const info = await registryRunInfo(env, auth.runId);
      const threadId = info?.threadId ?? null;
      const tainted = await readThreadTainted(env, threadId, nowMs);
      /** @type {Awaited<ReturnType<typeof applyPolicy>>} */
      let policyOut;
      try {
        policyOut = await applyPolicy(
          env,
          {
            kind: writeKind,
            // proposals.create передає у виконавця САМ payload дії, а не
            // обгортку {kind, payload} - інакше виконавець отримав би зайвий
            // рівень вкладеності.
            payload: tool.write.kindFrom
              ? /** @type {any} */ (args?.payload ?? {})
              : /** @type {any} */ (args),
            threadId,
            // Адреса прогону - для виконавців, що шлють щось власнику
            // (нагадування): її задає ядро, не модель (security-ревʼю PR-6).
            chatId: info?.chatId ?? null,
            tainted,
            viaProposal: Boolean(tool.write.kindFrom),
          },
          nowMs,
        );
      } catch (/** @type {any} */ e) {
        console.error(`internal: policy ${writeKind} впала`, e?.message);
        return json(
          { ok: false, error: 'tool-failed', tool: name, reason: String(e?.message ?? '') },
          502,
        );
      }
      if (policyOut.mode === 'error') {
        return json({ ok: false, error: `policy: ${policyOut.error}`, tool: name }, 400);
      }
      // Write-інструмент, чий РЕЗУЛЬТАТ несе зовнішній текст (назви ігор із
      // Steam), теж позначає тред: інакше зовнішній вміст ішов би в контекст
      // моделі, а сесія лишалась би «чистою», і наступні T0 виконувались би
      // без ✅. Той самий FAIL-CLOSED, що й для читання нижче.
      if (tool.tainting && !(await markRunThreadTainted(env, auth.runId, nowMs))) {
        return json({ ok: false, error: 'taint-not-persisted', tool: name }, 503);
      }
      if (policyOut.mode === 'proposed') {
        return json({
          ok: true,
          tool: name,
          tainted,
          mode: 'proposed',
          proposal: policyOut.proposal,
        });
      }
      return json({
        ok: true,
        tool: name,
        tainted,
        mode: 'executed',
        result: policyOut.result,
        ...(policyOut.undo ? { undo: policyOut.undo } : {}),
      });
    }

    /** @type {{ result: unknown }} */
    let out;
    try {
      out = await tool.run(env, args, nowMs);
    } catch (/** @type {any} */ e) {
      // Збій джерела - явний 502 із причиною, не тиха деградація і не 500-стек.
      console.error(`internal: інструмент ${name} впав`, e?.message);
      return json(
        { ok: false, error: 'tool-failed', tool: name, reason: String(e?.message ?? '') },
        502,
      );
    }

    // Подвійний барʼєр (01 §4.2), половина ядра: після tainting-інструмента
    // тред прогону позначається в sessions.tainted - навіть якщо хук мозку
    // обійдено, policy (PR-8) побачить прапорець тут. FAIL-CLOSED: якщо
    // прапорець НЕ вдалось персистувати, зовнішній вміст не віддається -
    // інакше транзієнтний збій DO/D1 давав би прогін із зовнішнім вмістом,
    // який policy вважатиме чистим.
    if (tool.tainting && !(await markRunThreadTainted(env, auth.runId, nowMs))) {
      return json({ ok: false, error: 'taint-not-persisted', tool: name }, 503);
    }

    return json({ ok: true, tool: name, tainted: Boolean(tool.tainting), result: out.result });
  }

  const route = path.match(
    /^\/internal\/(deliver|status|runs|session|artifact|instruction|taint)$/,
  )?.[1];
  if (route) {
    const schema = ROUTE_SCHEMAS[route];
    // Регекс розширили, а схему забули — гучний 500, не мовчазний пропуск
    // повз контракт (перманентний ?? {type:'object'} саме це й маскував би).
    if (!schema) return json({ ok: false, error: 'no-contract' }, 500);
    const contract = validateAgainst(schema, body);
    if (!contract.ok) return json({ ok: false, error: `contract: ${contract.error}` }, 400);
    if (route === 'deliver')
      return handleDeliver(env, ctx, auth.runId, /** @type {any} */ (body), nowMs);
    if (route === 'status')
      return handleStatus(env, ctx, auth.runId, /** @type {any} */ (body), nowMs);
    if (route === 'session') return handleSession(env, /** @type {any} */ (body), nowMs);
    if (route === 'artifact') return handleArtifact(env, auth.runId, /** @type {any} */ (body));
    if (route === 'instruction') return handleInstruction(env, /** @type {any} */ (body), nowMs);
    if (route === 'taint') return handleTaint(env, auth.runId, /** @type {any} */ (body), nowMs);
    return handleRuns(env, ctx, auth.runId, /** @type {any} */ (body), nowMs);
  }

  return json({ ok: false, error: 'not-found' }, 404);
}

/**
 * Фінальна відповідь прогону (07 §3): Rich message (HTML + кнопки) у тему
 * прогону через outbox. Довший за стелю Telegram текст розбивається на
 * частини ще в enqueue; кнопки їдуть на останній. Драйн - одразу (відповідь
 * мозку чекає доставки; пауза між частинами ~1 с - прийнятно), ретраї 429 -
 * sweeper планувальника.
 * @param {Env} env
 * @param {ExecutionContext | undefined} ctx
 * @param {string} runId
 * @param {{ text: string, buttons?: { text: string, callback_data: string }[][], worker?: { name: string, text: string } }} body
 * @param {number} nowMs
 */
async function handleDeliver(env, ctx, runId, body, nowMs) {
  if (!env.TELEGRAM_CHAT_ID) return json({ ok: false, error: 'chat-not-configured' }, 500);
  // Кнопки мозку живуть у ВЛАСНОМУ просторі префіксів 07 §9 (p·c·r·a·u·m):
  // callback_data поза ним міг би адресувати легасі-обробники (rc:, sl:, ev:…)
  // і виконати дію БЕЗ підтвердження - тап власника є згодою на НАПИС кнопки,
  // не на її payload (confused deputy із security-ревʼю).
  for (const rowBtns of body.buttons ?? []) {
    for (const btn of rowBtns) {
      if (!/^(p|c|r|a|u|m):/.test(btn.callback_data)) {
        return json(
          {
            ok: false,
            error: `contract: callback_data поза простором 07 §9: "${btn.callback_data}"`,
          },
          400,
        );
      }
    }
  }
  // Ціль - чат ПРОГОНУ (ревʼю PR-3): без chatId відповідь DM-прогону летіла в
  // супергрупу з нечисловим thread_id 'dm' → Bad Request → failed-ряд outbox.
  const info = await registryRunInfo(env, runId);
  const threadKey = info?.threadId ?? env.TOPIC_ASSISTANT ?? null;
  const target =
    threadKey == null
      ? { chatId: env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null, threadId: null }
      : parsedForThread(env, String(threadKey), info?.chatId ?? null);
  if (target.chatId == null) return json({ ok: false, error: 'chat-not-configured' }, 500);
  // Статус-повідомлення - це ЧЕРНЕТКА відповіді (01 §3.1 «Rich draft»), тож
  // фінал заміняє її, а не лягає другим повідомленням. Без цього чернетка
  // назавжди лишалась на останньому партіалі, і власник бачив обірваний
  // шматок («2 494,24 (14 672») плюс повну відповідь окремо. Розбиття довгої
  // відповіді й порядок частин лишаються в enqueueOutbox.
  const draftId = info?.statusMessageId ?? null;
  // Результат працівника (S-7-1): рядок у reports ДО відправки, бо кнопки
  // несуть його id; довгий - файлом одразу (кнопки .md тоді немає) + Drive.
  /** @type {{ id: string, name: string, text: string } | null} */
  let saved = null;
  if (body.worker) {
    try {
      saved = await saveWorkerResult(env, body.worker, nowMs);
    } catch (/** @type {any} */ e) {
      return json({ ok: false, error: `contract: ${String(e?.message ?? '')}` }, 400);
    }
  }
  const longWorker = saved != null && saved.text.length > WORKER_CHAT_MAX;
  const buttons = [...(body.buttons ?? []), ...(saved ? workerButtons(saved.id, !longWorker) : [])];
  // Незіслані партіали цієї ж чернетки більше не потрібні: інакше черга
  // спершу покаже обірваний шматок і лише потім фінал.
  if (draftId != null) await dropPendingEdits(env, target.chatId, draftId);
  const { queued } = await enqueueOutbox(
    env,
    {
      chatId: target.chatId,
      threadId: target.threadId,
      kind: 'send',
      editFirstMessageId: draftId,
      // Markdown моделі → HTML Telegram частинами (tg/markdown.mjs); текст у
      // reports/сесії лишається Markdown.
      parts: renderMdParts(body.text),
      payload: buttons.length ? { reply_markup: { inline_keyboard: buttons } } : {},
    },
    nowMs,
  );
  if (saved && longWorker) {
    await sendWorkerDocument(
      env,
      { chatId: target.chatId, threadId: target.threadId },
      saved,
      nowMs,
    );
  }
  await scheduleDrain(env, ctx, nowMs);
  // Копія в Drive - ПІСЛЯ драйну і у фоні: два-три виклики Google не сміють
  // затримувати відповідь мозку (той самий мотив, що в scheduleDrain).
  if (saved && longWorker) {
    const drive = uploadWorkerResult(env, saved, nowMs);
    if (ctx?.waitUntil) ctx.waitUntil(drive);
    else await drive;
  }
  // Звіт профілю weekly-review (S-9-1): текст у reports разом із хешем
  // інструкції. ПІСЛЯ enqueue: власник має отримати звіт, навіть якщо запис у
  // базу впав, - тоді про це скаже лог і рядок у відповіді, а не тиша в темі.
  let reportId = null;
  const profile = await readRunProfile(env, runId).catch(() => null);
  if (profile === 'weekly-review') {
    try {
      reportId = (await saveWeeklyReport(env, body.text, nowMs)).id;
    } catch (/** @type {any} */ e) {
      console.error('internal: звіт не збережено в reports', e?.message);
    }
  }
  // Дайджест чатів (S-2-5): текст у `inbox_digests` - вони лишаються назавжди,
  // навіть коли самі повідомлення зникнуть за ретенцією. Той самий порядок:
  // спершу доставка власнику, потім запис.
  if (profile === 'inbox-digest') {
    try {
      await saveInboxDigest(env, body.text, nowMs);
    } catch (/** @type {any} */ e) {
      console.error('internal: дайджест не збережено в inbox_digests', e?.message);
    }
  }
  return json({
    ok: true,
    queued,
    ...(draftId != null ? { edited: draftId } : {}),
    ...(reportId ? { report_id: reportId } : {}),
    ...(saved ? { worker_result_id: saved.id } : {}),
  });
}

/**
 * Інструкція працівника для delegate (етап 4, S-7-3): лише kind=agent (персону
 * цим шляхом не віддаємо - вона їде в /run). Немає рядка або хеш розійшовся -
 * 404 + алерт власнику «не налаштований»: мозок скаже це моделі, а власник
 * побачить у системному чаті, чому.
 * @param {Env} env @param {{ name: string }} body @param {number} nowMs
 */
async function handleInstruction(env, body, nowMs) {
  if (!env.DB) return json({ ok: false, error: 'db-not-configured' }, 500);
  /** @type {Awaited<ReturnType<typeof loadInstruction>>} */
  let ins;
  try {
    ins = await loadInstruction(env, body.name);
  } catch (/** @type {any} */ e) {
    console.error(`internal: інструкція працівника «${body.name}» недоступна`, e?.message);
    await sendSystemAlert(
      env,
      `Працівник «${body.name}» не налаштований: ${String(e?.message ?? '')}`,
      nowMs,
    );
    return json({ ok: false, error: 'instruction-missing', reason: String(e?.message ?? '') }, 404);
  }
  if (ins.kind !== 'agent') return json({ ok: false, error: 'not-a-worker', kind: ins.kind }, 400);
  return json({ ok: true, name: ins.name, version_hash: ins.hash, body_md: ins.body });
}

/**
 * Taint від мозку (01 §4.2): вихід працівника з tainted_output - зовнішній
 * вміст, і тред позначається так само, як після mail.*: FAIL-CLOSED - без
 * персистованого прапорця мозок результат не видає.
 * @param {Env} env @param {string} runId @param {{ source: string }} body @param {number} nowMs
 */
async function handleTaint(env, runId, body, nowMs) {
  if (!(await markRunThreadTainted(env, runId, nowMs))) {
    return json({ ok: false, error: 'taint-not-persisted', source: body.source }, 503);
  }
  return json({ ok: true, source: body.source, tainted: true });
}

/**
 * Оновлення статус-повідомлення (07 §3): незіслані edit-и того ж message_id
 * заміняються новішим - це і є троттлінг до фактичної швидкості відправки.
 * @param {Env} env
 * @param {ExecutionContext | undefined} ctx
 * @param {string} runId
 * @param {{ message_id: number, text: string }} body
 * @param {number} nowMs
 */
async function handleStatus(env, ctx, runId, body, nowMs) {
  // Той самий принцип, що в handleDeliver: edit іде в чат ПРОГОНУ, інакше
  // статусник DM-прогону «редагувався» б у чужому чаті (ревʼю PR-3).
  const info = await registryRunInfo(env, runId);
  const chatId = info?.chatId ?? (env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null);
  if (chatId == null) return json({ ok: false, error: 'chat-not-configured' }, 500);
  await dropPendingEdits(env, chatId, body.message_id);
  const { queued } = await enqueueOutbox(
    env,
    {
      chatId,
      kind: 'edit',
      payload: { message_id: body.message_id, text: body.text },
    },
    nowMs,
  );
  await scheduleDrain(env, ctx, nowMs);
  return json({ ok: true, queued });
}

/**
 * Драйн ПІСЛЯ відповіді (ctx.waitUntil): доставка 16 частин з паузами - це
 * ~17 с, і тримати відповідь мозку стільки означало б хибний таймаут на його
 * боці, хоча все відправлено. Без ctx (юніт-тести кличуть router напряму) -
 * чесний await, щоб тест бачив доставку синхронно.
 * @param {Env} env
 * @param {ExecutionContext | undefined} ctx
 * @param {number} nowMs
 */
async function scheduleDrain(env, ctx, nowMs) {
  const drained = drainOutbox(env, { nowMs }).catch(
    (/** @type {any} */ e) =>
      void console.error('outbox: драйн після deliver/status впав (sweeper добере)', e?.message),
  );
  if (ctx?.waitUntil) {
    ctx.waitUntil(drained);
    return;
  }
  await drained;
}

/**
 * Телеметрія прогону від мозку (07 §3, дротування - етап 2 PR-2): кроки в
 * run_steps + закриття прогону в RunRegistry (ідемпотентність фіналу тримає
 * сам реєстр: finished_at IS NULL). Поля кроків коерсяться дбайливо - контракт
 * RUNS_SCHEMA гарантує лише «масив обʼєктів», а телеметрія не сміє валити
 * прогін через криве поле.
 * Після закриття прогону тут же живе продовження треду (ADR-039): ескалація
 * quick→chat (крок name='escalate' з текстом у note) або наступний запис
 * черги; обидва - у waitUntil, щоб відповідь мозку не чекала нового прогону.
 * @param {Env} env
 * @param {ExecutionContext | undefined} ctx
 * @param {string} runId
 * @param {{ steps: Record<string, unknown>[], outcome?: { escalate?: { text?: string, status_message_id?: number } } }} body
 * @param {number} nowMs
 */
async function handleRuns(env, ctx, runId, body, nowMs) {
  if (!env.DB) return json({ ok: false, error: 'db-not-configured' }, 500);
  const steps = body.steps;
  try {
    for (let i = 0; i < steps.length; i += 1) {
      const s = steps[i] ?? {};
      const ms = Number(s.ms);
      await env.DB.prepare(
        `INSERT INTO run_steps (id, run_id, n, at, kind, name, ms, ok, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          crypto.randomUUID(),
          runId,
          Number.isFinite(Number(s.n)) ? Number(s.n) : i + 1,
          typeof s.at === 'string' ? s.at : new Date(nowMs).toISOString(),
          typeof s.kind === 'string' ? s.kind : 'tool',
          s.name != null ? String(s.name).slice(0, 128) : null,
          Number.isFinite(ms) ? ms : null,
          s.ok == null ? null : s.ok ? 1 : 0,
          s.note != null ? String(s.note).slice(0, 500) : null,
        )
        .run();
    }
  } catch (/** @type {any} */ e) {
    console.error('internal: запис run_steps впав', e?.message);
    return json({ ok: false, error: 'steps-not-persisted' }, 500);
  }
  const failed = steps.some((s) => s && s.kind === 'error');
  // finish повертає threadId/chatId щойно закритого прогону - окремий
  // runInfo-виклик до фінішу більше не потрібен (ревʼю PR-3, efficiency).
  const info = await registryFinish(env, runId, {
    finishedMs: nowMs,
    error: failed ? 'brain-error' : null,
    steps: steps.length,
  });

  // Подія в ланцюг від працівника (етап 3 PR-8): доставляється ДО продовження
  // треду і незалежно від нього; збій sendEvent - у лог, ланцюг дочекається
  // таймауту і піде резервом (машина станів терпить тишу працівника).
  const chainOut =
    /** @type {{ id?: unknown, event?: unknown, payload?: Record<string, unknown> } | undefined} */ (
      /** @type {any} */ (body.outcome)?.chain
    );
  if (chainOut && typeof chainOut.id === 'string' && typeof chainOut.event === 'string') {
    try {
      await sendChainEvent(env, chainOut.id, chainOut.event, chainOut.payload ?? {});
    } catch (/** @type {any} */ e) {
      console.error(
        `internal: подія ${chainOut.event} у ланцюг ${chainOut.id} не доставлена`,
        e?.message,
      );
    }
  }

  if (info?.threadId != null) {
    const threadKey = String(info.threadId);
    const target = parsedForThread(env, threadKey, info.chatId ?? null);
    // Керівний сигнал - із КОНТРАКТНОГО body.outcome (ревʼю PR-3: телеметрія
    // не транспорт керування); крок name='escalate' - лише журнальний слід і
    // fallback на вікно деплою, поки мозок ще шле старий формат.
    const outcomeEsc = body.outcome?.escalate;
    const stepEsc = steps.find((s) => s && s.kind === 'reply' && s.name === 'escalate');
    const esc = outcomeEsc ?? stepEsc;
    const escText =
      typeof outcomeEsc?.text === 'string'
        ? outcomeEsc.text
        : typeof stepEsc?.note === 'string'
          ? stepEsc.note
          : '';
    // Строго number ≥ 1: Number(null) дав би message_id 0 (ревʼю PR-3).
    const escStatusId =
      typeof esc?.status_message_id === 'number' && esc.status_message_id >= 1
        ? esc.status_message_id
        : null;
    const continueThread = async () => {
      if (esc && escText) {
        // S-N3-6: статус «думаю довше…», той самий текст у chat, той самий
        // статусник; тред НЕ звільняється - ескалація є продовженням.
        if (escStatusId != null && target.chatId != null) {
          await enqueueOutbox(
            env,
            {
              chatId: target.chatId,
              kind: 'edit',
              payload: { message_id: escStatusId, text: '▸ Думаю довше…' },
            },
            nowMs,
          );
          await drainOutbox(env, { nowMs }).catch(() => {});
        }
        await startClaimedRun(
          env,
          target,
          threadKey,
          { text: escText, route: 'chat', attempts: 0, atMs: nowMs, chatId: target.chatId },
          nowMs,
          escStatusId,
        );
        return;
      }
      await registryThreadFinishAndKick(env, target, threadKey, runId, nowMs);
    };
    const cont = continueThread().catch(
      (/** @type {any} */ e) => void console.error('internal: продовження треду впало', e?.message),
    );
    if (ctx?.waitUntil) ctx.waitUntil(cont);
    else await cont;
  }
  return json({ ok: true, steps: steps.length });
}

/**
 * Артефакт idea-analysis.yml (07 §3, етап 4 PR-2): job в Actions підписав
 * run_id, який ядро зареєструвало до dispatch. Ланцюг - за run_id зі стану
 * chains; idea_id тіла мусить збігатися (підпис доводить «хто», збіг - «про
 * що»). Подія їде у Workflow IdeaAnalysis, який зберігає результат і сам
 * закриває прогін у реєстрі на кожному фіналі (один власник життя прогону;
 * повтор артефакту рубає nonce і 409 інстанса). Ланцюг, що вже не чекає
 * (таймаут, «↩»), - 409: Actions побачить це в лозі, власник - нічого зайвого.
 * @param {Env} env
 * @param {string} runId
 * @param {{ idea_id: string, status: string, repo?: string, sha?: string, md?: string, reason?: string, meta?: Record<string, unknown> }} body
 */
async function handleArtifact(env, runId, body) {
  if (body.status !== 'ok' && body.status !== 'failed') {
    return json({ ok: false, error: 'contract: status лише ok|failed' }, 400);
  }
  if (body.status === 'ok' && !(typeof body.md === 'string' && body.md.trim())) {
    return json({ ok: false, error: 'contract: ok без md' }, 400);
  }
  if (!env.DB) return json({ ok: false, error: 'db-not-configured' }, 500);
  const chain = await findAnalysisByRun(env, runId);
  if (!chain) return json({ ok: false, error: 'chain-unknown' }, 404);
  if (chain.ideaId !== body.idea_id) {
    return json({ ok: false, error: 'idea-mismatch' }, 400);
  }
  if (chain.status !== 'waiting' && chain.status !== 'running') {
    return json({ ok: false, error: 'chain-not-waiting', status: chain.status }, 409);
  }
  const partial = body.meta?.partial === true;
  try {
    await sendAnalysisEvent(env, chain.id, {
      status: body.status,
      ...(body.md != null ? { md: body.md } : {}),
      ...(body.reason != null ? { reason: body.reason } : {}),
      ...(partial ? { partial: true } : {}),
    });
  } catch (/** @type {any} */ e) {
    console.error(`internal: подія artifact у ланцюг ${chain.id} не доставлена`, e?.message);
    return json({ ok: false, error: 'chain-not-waiting', reason: String(e?.message ?? '') }, 409);
  }
  return json({ ok: true, chain_id: chain.id, status: body.status });
}

/**
 * Сесійний стан від мозку (ADR-038): upsert у D1 sessions. sdk_session_id і
 * summary_md оновлюються ЛИШЕ коли передані (COALESCE) - виклик з самим
 * turns_inc не затирає збережену згортку; tainted тут НЕ чіпається (його
 * ведуть markRunThreadTainted і policy - інакше мозок міг би зняти прапорець).
 * Помилка D1 - явний 500: мовчазна втрата sdk_session_id означала б нову
 * сесію наступного дня без жодного сліду чому.
 * @param {Env} env
 * @param {{ thread_id: string, sdk_session_id?: string, summary_md?: string,
 *   turns_inc?: number }} body
 * @param {number} nowMs
 */
async function handleSession(env, body, nowMs) {
  if (!env.DB) return json({ ok: false, error: 'db-not-configured' }, 500);
  const iso = new Date(nowMs).toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO sessions (thread_id, sdk_session_id, started_at, last_at, tainted, summary_md, turn_count)
       VALUES (?1, ?2, ?3, ?3, 0, ?4, ?5)
       ON CONFLICT (thread_id) DO UPDATE SET
         sdk_session_id = COALESCE(excluded.sdk_session_id, sessions.sdk_session_id),
         summary_md = COALESCE(excluded.summary_md, sessions.summary_md),
         last_at = excluded.last_at,
         turn_count = sessions.turn_count + ?5`,
    )
      .bind(
        body.thread_id,
        body.sdk_session_id ?? null,
        iso,
        body.summary_md ?? null,
        body.turns_inc ?? 0,
      )
      .run();
  } catch (/** @type {any} */ e) {
    console.error('internal: upsert session впав', e?.message);
    return json({ ok: false, error: 'session-not-persisted' }, 500);
  }
  // Згортка → памʼять (memory_chunks + Vectorize). Сесія ВЖЕ персистована,
  // тому збій памʼяті не 500 (це відкотило б у мозку те, що насправді
  // записано), а чесне поле у відповіді + гучний лог; згортка в будь-якому
  // разі лежить у sessions.summary_md (резерв ADR-020).
  if (body.summary_md != null) {
    try {
      const { written } = await writeMemoryChunks(env, body.thread_id, body.summary_md, nowMs);
      return json({ ok: true, thread_id: body.thread_id, memory_chunks: written });
    } catch (/** @type {any} */ e) {
      console.error('internal: запис памʼяті впав (згортка збережена в sessions)', e?.message);
      return json({
        ok: true,
        thread_id: body.thread_id,
        memory: 'failed',
        reason: String(e?.message ?? ''),
      });
    }
  }
  return json({ ok: true, thread_id: body.thread_id });
}

/**
 * Прапорець taint треду з D1 sessions - джерело істини для policy (01 §4.2).
 * Позначка - epoch-ms останнього зовнішнього читання; діє TAINT_TTL_MS
 * (policy/core). FAIL-SAFE: невідомий тред / збій D1 = вважаємо tainted
 * (ескалація до пропозиції) - помилка інфраструктури не сміє відчиняти
 * T0-запис.
 * @param {Env} env
 * @param {string | number | null} threadId
 * @param {number} nowMs
 */
async function readThreadTainted(env, threadId, nowMs) {
  if (threadId == null) return true;
  if (!env.DB) {
    console.error('internal: привʼязки DB немає - taint вважаємо true (fail-safe)');
    return true;
  }
  try {
    const { results } = await env.DB.prepare('SELECT tainted FROM sessions WHERE thread_id = ?')
      .bind(String(threadId))
      .all();
    const row = /** @type {{ tainted?: number } | undefined} */ (results?.[0]);
    // Треду ще немає в sessions = зовнішнього не читали = чиста сесія.
    return row ? isTaintActive(row.tainted, nowMs) : false;
  } catch (/** @type {any} */ e) {
    console.error('internal: читання taint впало - вважаємо true (fail-safe)', e?.message);
    return true;
  }
}

/**
 * Половина подвійного барʼєра, що живе в ядрі (01 §4.2): тред прогону, який
 * прочитав зовнішнє, позначається в D1 sessions.tainted (epoch-ms читання,
 * діє TAINT_TTL_MS) - policy (PR-8)
 * дивитиметься СЮДИ, а не вірити хуку мозку. Повертає true лише коли прапорець
 * СПРАВДІ персистовано - викликач на false відмовляє у видачі зовнішнього
 * вмісту (fail-closed), тому кожен зрив тут і гучний, і не тихо-пропущений.
 * @param {Env} env
 * @param {string} runId
 * @param {number} nowMs
 */
async function markRunThreadTainted(env, runId, nowMs) {
  try {
    const info = await registryRunInfo(env, runId);
    const threadId = info?.threadId;
    if (threadId == null) {
      console.error(`internal: прогін ${runId} без threadId - taint не записано в sessions`);
      return false;
    }
    if (!env.DB) {
      console.error('internal: привʼязки DB немає - taint не записано в sessions');
      return false;
    }
    const iso = new Date(nowMs).toISOString();
    // Позначка - момент читання (epoch-ms): policy рахує від нього TAINT_TTL_MS.
    await env.DB.prepare(
      `INSERT INTO sessions (thread_id, started_at, last_at, tainted, turn_count)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT (thread_id) DO UPDATE SET tainted = excluded.tainted, last_at = excluded.last_at`,
    )
      .bind(String(threadId), iso, iso, nowMs)
      .run();
    return true;
  } catch (/** @type {any} */ e) {
    console.error('internal: запис taint у sessions впав', e?.message);
    return false;
  }
}
