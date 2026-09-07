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
import { loadSentMessages, putSentMessages } from '../kv-store.mjs';
import { recordSentMessage } from '../tg-core.mjs';
import { isPrimaryOwner } from '../auth-core.mjs';
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
  registrySweep,
} from './run-registry/client.mjs';
import { callBrainRun, callBrainAbort } from './brain/run-client.mjs';
import { readExpected } from './brain/health.mjs';
import { parsePolicyCallback, T2_WORDS, isTaintActive } from './policy/core.mjs';
import { resolveProposal, resolveUndo } from './policy/proposals.mjs';
import {
  transcribeVoice,
  savePendingVoice,
  claimPendingVoice,
  finishPendingVoice,
  VOICE_LONG_S,
} from './voice.mjs';
import { loadInstruction } from './instructions.mjs';
import { WEEKLY_NOW_RE, buildWeeklyReviewInput } from './brain/weekly-review.mjs';
import { runCollectionsList } from './tools/collections.mjs';
import { applyPolicy } from './policy/proposals.mjs';
import { muteHintTopic, HINT_TOPICS } from './hints/daily-hint.mjs';
import { loadWorkerResult, sendWorkerDocument, WORKER_FOLLOWUPS } from './brain/worker-results.mjs';
import {
  findAwaitingChain,
  sendChainEvent,
  readChainKind,
  choiceEvent,
  textEvent,
  dayPlanChoiceEvent,
  CANCEL_TEXT_RE,
} from './chains/registry.mjs';
import { softWaitingLine } from './chains/nudge.mjs';

export const THREAD_DM = 'dm';
/** Скільки транскрипта показуємо в «Я почув»: одне повідомлення з кнопками
 *  (Telegram ріже на 4096, а клавіатура лишається лише на останній частині).
 *  У прогін іде ПОВНИЙ текст із voice_pending. */
const VOICE_PREVIEW_MAX_CHARS = 700;
// Не експортуються свідомо (ревʼю PR-3): споживачів назовні немає, а export
// сигналив би «на це хтось спирається».
const STATUS_DRAFT = '▸ Думаю…';
const START_MAX_ATTEMPTS = 3;
const STOP_RE = /^стоп[.!]?$/i;
/** Скільки найновіших рішень по пропозиціях іде в дайджест входу моделі. */
const DECISIONS_MAX = 8;

const MODELS = {
  chat: 'claude-sonnet-5',
  quick: 'claude-haiku-4-5',
  'weekly-review': 'claude-sonnet-5',
  'day-planner': 'claude-sonnet-5',
};
/** Імʼя інструкції в D1 за маршрутом (дзеркало INSTRUCTION_NAME_BY_PROFILE мозку). */
const INSTRUCTION_BY_ROUTE = {
  chat: 'persona',
  quick: 'quick',
  'weekly-review': 'weekly-review',
  'day-planner': 'day-planner',
};
/** @typedef {'chat' | 'quick' | 'weekly-review' | 'day-planner'} RunRoute */

// N3 (04-scenarios §N3): якорі власних даних - будь-який збіг = chat.
// Суперсет канону безпечний: хибний chat коштує лише секунд, хибний quick -
// відповіді без даних власника.
const ANCHOR_RE =
  /(мій|моя|мої|мене|мені|зустріч|календар|пошт|лист|нагада|запиши|збережи|знайди в|покажи|витрат|іде[яїй]|бажан|поїздк|столик|чат)/i;
const URL_RE = /https?:\/\/|www\./i;
const FACT_QUESTION_RE = /(скільки|коли|хто такий|хто така|хто |що таке|який рік|якого року)/i;
// Мінус НЕ в класі операторів (ревʼю PR-3: «2026-08-27», «топ-5», «18-30»
// ставали quick) - віднімання ловиться лише відділеним пробілами « - ».
const NUMBER_OP_RE = /\d[\d\s.,]*\s*[%+*/×÷^]|[%+*/×÷^]\s*\d|\d\s+-\s+\d/;

/** Звернення до працівника на імʼя («аналітик: скільки…», «редактор, переклади»)
 *  - завжди chat: quick працівників не має і лише ескалює, а це 8-10 с
 *  (замір приймання етапу 4, 06.09). Імена - з таблиці persona.md. */
const WORKER_PREFIX_RE =
  /^(копірайтер|редактор|дослідник|аналітик|навчальний|планувальник|фінансист|секретар(-пошт[а-яії]*)?)(\s*[:,]|\s+-\s)/i;

/** Класифікація N3: тривіальне → quick, решта → chat.
 *  @param {string} text */
export function classifyRoute(text) {
  const t = text.trim();
  if (t.length > 120) return 'chat';
  if (WORKER_PREFIX_RE.test(t)) return 'chat';
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
 * @param {{ kind?: string, chatId?: number | null, threadId?: number | string | null, text?: unknown, messageId?: number | null, fromId?: number | string | null, voice?: { fileId: string, durationS: number, fileSize: number | null } | null }} parsed
 * @param {number} [nowMs]
 */
export async function prerouteMessage(env, parsed, nowMs = Date.now()) {
  const mode = env.ASSISTANT_V2;
  if (mode !== 'shadow' && mode !== 'on') return false;
  if (parsed.kind !== 'message' || parsed.chatId == null) return false;
  // S1/B1 (security-ревʼю PR-3): новий шлях - ЛИШЕ головний власник, як і
  // callback-гілка. Співвласник падає в легасі, де handleCommand сам відсіює
  // (вільний текст = відмова) - інакше він запускав би прогони мозку з сесією
  // власника, «стоп» і /new.
  if (!isPrimaryOwner(env, parsed.fromId)) return false;
  // Той самий периметр, що в легасі (commands.mjs): тема «Асистент» або DM.
  const inAssistant =
    parsed.threadId == null || String(parsed.threadId) === String(env.TOPIC_ASSISTANT ?? '');
  if (!inAssistant) return false;

  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };

  // Голос (кейс 6, ADR-040) - ДО текстових гілок: у голосового text порожній.
  // У shadow працює БЕЗ префікса v2: (усвідомлене відхилення, назване в
  // ADR-040): префікс не вимовиш, а легасі голосові ніколи не обробляв - новий
  // шлях нічого в нього не краде. Прогін стартує лише після тапу ✅.
  if (parsed.voice) {
    await handleVoiceMessage(env, target, parsed.voice, nowMs);
    return true;
  }

  let text = String(parsed.text ?? '').trim();
  if (!text) return false;

  const threadKeyEarly = target.threadId == null ? THREAD_DM : String(target.threadId);
  if (mode === 'shadow') {
    if (!/^v2:/i.test(text)) {
      // «стоп» у shadow (ревʼю PR-4): голос запускає прогони БЕЗ префікса
      // (ADR-040), тож зупиняти їх теж треба без нього - інакше єдиний спосіб
      // спинити голосовий прогін це написати «v2: стоп», про що ніде не
      // сказано. Перехоплюємо лише коли є що зупиняти: без активного прогону
      // «стоп» лишається легасі-агенту, як і раніше.
      if (STOP_RE.test(text) && (await hasLiveThread(env, threadKeyEarly))) {
        await stopThread(env, target, threadKeyEarly, nowMs);
        return true;
      }
      await shadowClassifyLog(env, target, text, nowMs);
      return false;
    }
    text = text.replace(/^v2:\s*/i, '');
    if (!text) return false;
  }

  const threadKey = target.threadId == null ? THREAD_DM : String(target.threadId);
  const send = (/** @type {string} */ body) => reply(env, target, body, nowMs);

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
    // /forget (S-0-5): меню T2 - колекції (етап 3); чати - етап 6, «усе» -
    // етап 7 (спершу експорт). Кнопка m:fg:<id> створює пропозицію зі словом.
    await sendForgetMenu(env, target, nowMs);
    return true;
  }
  // Інші /-команди - легасі (07 §10: «лишаються як є»).
  if (text.startsWith('/')) return false;

  // Слово-підтвердження T2 (01 §4.3): відкрита пропозиція цього треду з таким
  // словом - це рішення власника, а не повідомлення для моделі.
  if (await resolveT2Word(env, target, threadKey, text, nowMs)) return true;

  // «Не нагадуй про X» (S-0-16): тема підказок вимикається детерміновано,
  // без прогону - модель не мусить угадувати ключ і форму факту.
  const mute = /^(?:більше\s+)?не\s+нагадуй\s+про\s+([a-z]+)\.?$/i.exec(text);
  if (mute && HINT_TOPICS.includes(String(mute[1]).toLowerCase())) {
    const topic = String(mute[1]).toLowerCase();
    const sess = await readSession(env, threadKey, nowMs);
    const out = await muteHintTopic(
      env,
      topic,
      { threadId: threadKey, tainted: sess.tainted },
      nowMs,
    );
    if (out.mode === 'executed') {
      await reply(env, target, `Вимкнув підказки про ${topic}.`, nowMs, {
        ...(out.undo ? { reply_markup: { inline_keyboard: out.undo.buttons } } : {}),
      });
    } else if (out.mode === 'proposed') {
      await reply(
        env,
        target,
        `Вимкнути підказки про ${topic}? Сесія з зовнішнім вмістом - потрібне ✅.`,
        nowMs,
        {
          reply_markup: { inline_keyboard: out.proposal.buttons },
        },
      );
    } else {
      await reply(env, target, `Не вийшло: ${out.error}`, nowMs);
    }
    return true;
  }

  // Ланцюги (етап 3 PR-8 план дня, етап 5 столик): ланцюг чекає слова
  // власника в темі «Асистент» (намір/уточнення, назва закладу, час, імена)
  // - текст іде подією в Workflow, не в мозок. Інші теми не чіпаємо: питання
  // ставилось саме тут. Збій доставки - у мозок, як звичайне повідомлення.
  if (threadKey === String(env.TOPIC_ASSISTANT ?? '')) {
    const awaiting = await findAwaitingChain(env, threadKey).catch((/** @type {any} */ e) => {
      // Збій D1 тут не блокує повідомлення (воно піде в мозок), але й не мовчить.
      console.error('prerouter: пошук ланцюга впав', e?.message);
      return null;
    });
    const ev = awaiting ? textEvent(awaiting.kind, awaiting.awaiting, text) : null;
    if (awaiting && ev) {
      try {
        await sendChainEvent(env, awaiting.id, ev.type, ev.payload);
        return true;
      } catch (/** @type {any} */ e) {
        console.error('prerouter: подія в ланцюг не доставлена', e?.message);
      }
    }
    // Ланцюг столика чекає понад добу (S-1-6): мʼякий рядок раз на день - не
    // на «скасуй столик» (мозок зараз скасує) і лише для ланцюгів цього треду.
    if (!CANCEL_TEXT_RE.test(text)) {
      const soft = await softWaitingLine(env, nowMs, threadKey).catch((/** @type {any} */ e) => {
        console.error('prerouter: мʼякий рядок ланцюга впав', e?.message);
        return null;
      });
      if (soft) await reply(env, target, soft, nowMs);
    }
  }

  await routeThreadText(env, target, threadKey, text, nowMs);
  return true;
}

/**
 * Меню /forget: по кнопці на колекцію (T2 зі словом). Порожньо - чесно.
 * @param {Env} env @param {ThreadTarget} target @param {number} nowMs
 */
async function sendForgetMenu(env, target, nowMs) {
  /** @type {{ id: string, name: string, records: number }[]} */
  let collections;
  try {
    collections = /** @type {{ id: string, name: string, records: number }[]} */ (
      (await runCollectionsList(env)).result
    );
  } catch (/** @type {any} */ e) {
    await reply(env, target, `Колекції недоступні: ${String(e?.message ?? '')}`, nowMs);
    return;
  }
  if (collections.length === 0) {
    await reply(env, target, 'Забувати поки нічого: колекцій немає (чати - етап 6).', nowMs);
    return;
  }
  const rows = collections
    .slice(0, 10)
    .map((c) => [{ text: `🗑 ${c.name} (${c.records})`, callback_data: `m:fg:${c.id}` }]);
  await reply(env, target, 'Що забути? Це T2 - після кнопки попрошу слово.', nowMs, {
    reply_markup: { inline_keyboard: rows },
  });
}

/**
 * Напис власника збігся зі словом відкритої T2-пропозиції треду → виконати.
 * Слово порівнюється без регістру; пропозицій зі словом у треді - одиниці.
 * @param {Env} env @param {ThreadTarget} target @param {string} threadKey
 * @param {string} text @param {number} nowMs
 * @returns {Promise<boolean>} true = це було слово, оброблено
 */
async function resolveT2Word(env, target, threadKey, text, nowMs) {
  if (!env.DB) return false;
  const word = text.trim().toUpperCase();
  // Лише відомі слова T2 (їх чотири): «дякую» чи «привіт» не мають ходити в
  // D1 перед кожним прогоном.
  if (!T2_WORDS.includes(word)) return false;
  let row;
  try {
    row = /** @type {any} */ (
      await env.DB.prepare(
        `SELECT id FROM proposals WHERE status = 'open' AND level = 'T2' AND word = ?
         AND thread_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(word, threadKey)
        .first()
    );
  } catch (/** @type {any} */ e) {
    console.error('prerouter: пошук T2-слова впав', e?.message);
    return false;
  }
  if (!row) return false;
  const res = await resolveProposal(env, { id: String(row.id), choice: 'ok', word }, nowMs);
  const erased =
    res.ok && 'status' in res && res.status === 'approved' && res.executed
      ? String(/** @type {any} */ (res.result)?.erased ?? 'готово')
      : null;
  await reply(env, target, erased ? `Стерто: ${erased}.` : proposalToast(res), nowMs);
  return true;
}

/**
 * Вільний текст у тред: «стоп» → abort; інакше класифікація → статусник →
 * черга → прогін. Спільний хвіст двох входів - повідомлення власника і
 * підтвердженого ✅ транскрипта голосового (ADR-040): голос далі ЙДЕ ЯК ТЕКСТ,
 * включно зі «стоп».
 * @param {Env} env
 * @param {ThreadTarget} target
 * @param {string} threadKey
 * @param {string} text
 * @param {number} nowMs
 */
async function routeThreadText(env, target, threadKey, text, nowMs) {
  if (STOP_RE.test(text)) {
    await stopThread(env, target, threadKey, nowMs);
    return;
  }

  // «звіт зараз» (S-9-5) - профіль weekly-review за запитом: той самий шлях
  // (черга, статусник, ретраї), інша інструкція й модель.
  const route = WEEKLY_NOW_RE.test(text) ? 'weekly-review' : classifyRoute(text);
  await startOrQueueThreadText(env, target, threadKey, text, route, nowMs);
}

/**
 * Поставити текст у тред: статусник → claim → старт або черга. Спільний вхід
 * для повідомлення власника і для планувальника (задача weekly-review кладе
 * «звіт зараз» у тему сама - S-9-1). Повертає runId стартованого прогону або
 * null, якщо запит став у чергу (стартує після поточного) чи старт не вдався.
 * @param {Env} env
 * @param {ThreadTarget} target
 * @param {string} threadKey
 * @param {string} text
 * @param {RunRoute} route
 * @param {number} nowMs
 * @returns {Promise<string | null>}
 */
export async function startOrQueueThreadText(env, target, threadKey, text, route, nowMs) {
  // Статусник ДО claim (S-0-2, ревʼю PR-3): при старті стане «▸ Думаю…»
  // прогону, при черзі - редагованим «▸ Черга: N» (не вічним повідомленням-
  // сиротою), а його id поїде в queue-entry для reuse при підйомі.
  const statusMessageId = await sendStatusDraft(env, target);
  const entry = {
    text,
    route,
    attempts: 0,
    atMs: nowMs,
    chatId: target.chatId,
    statusMessageId,
  };
  const claim = await registryThreadClaim(env, threadKey, entry);
  if ('queued' in claim) {
    const note =
      claim.queued === -1 ? 'Черга повна - спробуй трохи пізніше.' : `▸ Черга: ${claim.queued}`;
    if (statusMessageId != null) await editStatus(env, target, statusMessageId, note, nowMs);
    else await reply(env, target, note, nowMs);
    return null;
  }
  return startClaimedRun(env, target, threadKey, entry, nowMs, statusMessageId);
}

/**
 * Голосове повідомлення (S-6-1..5, ADR-040): коротке - одразу розпізнати й
 * показати «Я почув» з ✅/✏️; довге (> 5 хв) - спершу спитати «Розпізнати?»
 * (S-6-4; file_id чекає тапу в voice_pending, бо в callback_data не влазить).
 * @param {Env} env
 * @param {ThreadTarget} target
 * @param {{ fileId: string, durationS: number, fileSize?: number | null }} voice
 * @param {number} nowMs
 */
async function handleVoiceMessage(env, target, voice, nowMs) {
  if (voice.durationS > VOICE_LONG_S) {
    const id = await pendingOrFail(
      env,
      target,
      {
        kind: 'file',
        fileId: voice.fileId,
        durationS: voice.durationS,
        chatId: target.chatId,
        threadId: target.threadId,
      },
      nowMs,
    );
    if (id == null) return;
    await reply(
      env,
      target,
      `Довге голосове (~${Math.round(voice.durationS / 60)} хв) - можу розпізнати, але краще коротше.`,
      nowMs,
      voiceKeyboard([{ text: 'Розпізнати', callback_data: `v:${id}:go` }]),
    );
    return;
  }
  await transcribeAndPresent(env, target, voice, nowMs);
}

/** Розпізнати і показати транскрипт із ✅/✏️ (T0: дія - лише після тапу).
 *  Повертає false, коли показати не вдалося, - викликач із claim-ом на це
 *  спирається (ряд лишається в грі для повторного тапу).
 *  @param {Env} env @param {ThreadTarget} target
 *  @param {{ fileId: string, durationS: number, fileSize?: number | null }} voice
 *  @param {number} nowMs @returns {Promise<boolean>} */
async function transcribeAndPresent(env, target, voice, nowMs) {
  const res = await transcribeVoice(env, voice, nowMs);
  if (!res.ok) {
    const msg = {
      misconfigured: 'Розпізнавання не налаштоване - перевір ключ Deepgram.',
      'too-big': 'Голосове завелике - Telegram віддає ботам файли до 20 МБ.',
      failed: 'Не вдалося розпізнати - спробуй ще раз або напиши текстом.',
    }[res.error];
    await reply(env, target, msg, nowMs);
    // Транспортний збій вартий повторного тапу; misconfig і завеликий файл -
    // ні, повтор дасть те саме.
    return res.error !== 'failed';
  }
  if (!res.text) {
    await reply(env, target, 'Не розчув - повтори або напиши.', nowMs);
    return true;
  }
  const id = await pendingOrFail(
    env,
    target,
    {
      kind: 'transcript',
      text: res.text,
      durationS: voice.durationS,
      chatId: target.chatId,
      threadId: target.threadId,
    },
    nowMs,
  );
  if (id == null) return false;
  const mark = res.fallback ? '\n(резервний розпізнавач)' : '';
  // Стеля ПОКАЗУ окремо від стелі транскрипта (ревʼю PR-4): у прогін піде
  // повний текст із voice_pending, а «Я почув» лишається одним повідомленням
  // із кнопками - інакше довге голосове рветься на пʼять частин, і ✅/✏️
  // опиняються під стіною тексту на останній.
  await reply(
    env,
    target,
    `Я почув: «${previewText(res.text)}»${mark}`,
    nowMs,
    voiceKeyboard([
      { text: '✅', callback_data: `v:${id}:ok` },
      { text: '✏️', callback_data: `v:${id}:edit` },
    ]),
  );
  return true;
}

/** Записати очікування тапу; збій - чесна відповідь і null (спільний хвіст
 *  обох гілок голосу).
 *  @param {Env} env @param {ThreadTarget} target
 *  @param {Parameters<typeof savePendingVoice>[1]} entry @param {number} nowMs */
async function pendingOrFail(env, target, entry, nowMs) {
  try {
    return await savePendingVoice(env, entry, nowMs);
  } catch (/** @type {any} */ e) {
    console.error('prerouter: voice_pending не записано', e?.message);
    await reply(env, target, 'Не вдалося прийняти голосове - спробуй ще раз.', nowMs);
    return null;
  }
}

/** @param {string} text */
function previewText(text) {
  if (text.length <= VOICE_PREVIEW_MAX_CHARS) return text;
  return [...text].slice(0, VOICE_PREVIEW_MAX_CHARS).join('') + '…';
}

/** @param {{ text: string, callback_data: string }[]} row */
function voiceKeyboard(row) {
  return { reply_markup: { inline_keyboard: [row] } };
}

/**
 * Прогін для ВЖЕ взятого треду (claim start / kick / ескалація): статусник →
 * begin → сесія з D1 → POST /run. Невдалий старт - S-0-7: ретрай через чергу
 * (стеля START_MAX_ATTEMPTS), «підняття» робить задача brain-health.
 * @param {Env} env
 * @param {{ chatId: number | null, threadId: number | string | null }} parsed
 * @param {string} threadKey
 * @param {{ text: string, route: string, attempts: number, atMs: number, chatId?: number | null, statusMessageId?: number | null }} entry
 * @param {number} nowMs
 * @param {number | null} [reuseStatusId] - ескалація quick→chat редагує той
 *   самий статусник, нового не шле
 */
export async function startClaimedRun(env, parsed, threadKey, entry, nowMs, reuseStatusId = null) {
  // Інструкція профілю з D1 (PR-5) - ПЕРШОЮ дією: мозок не має доступу до
  // бази, тож текст їде в тілі /run разом із хешем, і без нього прогону не
  // буде. Перевірка до begin/claim свідома (ревʼю PR-5): інакше кожна відмова
  // відкочувала б три записи, а гілка відкоту через finishAndKick піднімала б
  // наступний запис черги - той падав би так само, і один вебхук давав би до
  // шести однакових відмов поспіль.
  const route = /** @type {RunRoute} */ (entry.route);
  const instructionName = INSTRUCTION_BY_ROUTE[route] ?? 'persona';
  let instruction;
  try {
    const loaded = await loadInstruction(env, instructionName);
    instruction = { name: loaded.name, version_hash: loaded.hash, body_md: loaded.body };
  } catch (/** @type {any} */ e) {
    console.error(`prerouter: інструкція «${instructionName}» недоступна`, e?.message);
    // Найімовірніша причина - вікно між деплоєм воркера і синком, тобто стан
    // самозагойний: той самий шлях, що для недоступного мозку (S-0-7).
    await retryOrGiveUp(env, parsed, threadKey, entry, nowMs, reuseStatusId, {
      retry: 'Інструкції ще синхронізуються - спробую за ~5 хв.',
      giveUp: 'Інструкції асистента не синхронізовані - скажи, коли полагодимо.',
    });
    return null;
  }
  // Вхід звіту (weekly-review §0) будує ЯДРО: період, перша неділя, попередній
  // звіт, хеш інструкції - текст власника («звіт зараз») моделі не потрібен.
  // Рішення власника по пропозиціях (✅/❌/«↩») після попередньої відповіді
  // моделі в цьому треді: модель їх не бачить (виконує ядро по кнопці), і без
  // цього рядка казала «колекція ще не створена» після ✅ (приймання 05.09).
  const decisions = route === 'chat' ? await recentDecisions(env, threadKey, nowMs) : '';
  const inputText =
    route === 'weekly-review'
      ? (await buildWeeklyReviewInput(env, nowMs, instruction.version_hash)).text
      : decisions
        ? `${decisions}\n\n${entry.text}`
        : entry.text;

  const statusMessageId = reuseStatusId ?? (await sendStatusDraft(env, parsed));
  const runId = crypto.randomUUID();
  await registryBegin(env, {
    id: runId,
    trigger: route,
    profile: route,
    threadId: threadKey,
    chatId: parsed.chatId,
    model: MODELS[route] ?? null,
    startedMs: nowMs,
  });
  const { claimed } = await registryThreadSetRun(env, threadKey, runId, statusMessageId, nowMs);
  if (!claimed) {
    // «стоп» устиг у вікні pending (ревʼю PR-3): тред зник - мозок НЕ кличемо,
    // інакше прогін-сирота доставив би відповідь після «Зупинив.».
    await registryFinish(env, runId, { finishedMs: nowMs, error: 'cancelled' });
    if (reuseStatusId == null && statusMessageId != null && parsed.chatId != null) {
      await tgCall(env, 'deleteMessage', {
        chat_id: parsed.chatId,
        message_id: statusMessageId,
      }).catch(() => {});
    }
    return null;
  }

  const sess = route === 'chat' ? await readSession(env, threadKey, nowMs) : null;
  const res = await callBrainRun(
    env,
    {
      instruction,
      runId,
      profile: route,
      threadId: threadKey,
      inputText,
      tainted: sess?.tainted ?? false,
      ...(statusMessageId != null ? { statusMessageId } : {}),
      ...(sess
        ? { session: { sdk_session_id: sess.sdkSessionId, summary_md: sess.summaryMd } }
        : {}),
    },
    nowMs,
  );
  if (res.ok) return runId;

  console.error(`prerouter: /run не стартував (${res.status} ${res.detail})`);
  if (res.status === 0) {
    // Транспортна невизначеність (таймаут 10 с / мережа): 202 міг ЗАГУБИТИСЬ,
    // а прогін у мозку жити - ретрай дав би подвійну LLM-роботу, а finish
    // зробив би живому прогону 403 на кожен колбек (ревʼю PR-3). Лишаємо
    // активним: живий - доставить, мертвий - сторож (registrySweep) звільнить
    // тред і чесно скаже власнику.
    await editStatus(env, parsed, statusMessageId, 'Звʼязок із мозком повільний - чекаю…', nowMs);
    return runId;
  }

  // Мозок ВІДПОВІВ відмовою - прогін точно не стартував. Спершу повернути
  // запис у чергу, потім закривати прогін: зворотний порядок лишав би тред
  // взятим фантомом при смерті ізоляту між викликами (ревʼю PR-3).
  const attempts = entry.attempts + 1;
  if (attempts >= START_MAX_ATTEMPTS) {
    await registryFinish(env, runId, { finishedMs: nowMs, error: `brain-start: ${res.status}` });
    await registryThreadFinishAndKick(env, parsed, threadKey, runId, nowMs);
    await editStatus(
      env,
      parsed,
      statusMessageId,
      'Не вдалося - мозок недоступний. Напиши пізніше.',
      nowMs,
    );
    return null;
  }
  await registryThreadRetry(env, threadKey, { ...entry, attempts, statusMessageId });
  await registryFinish(env, runId, { finishedMs: nowMs, error: `brain-start: ${res.status}` });
  await editStatus(
    env,
    parsed,
    statusMessageId,
    'Мозок недоступний - спробую ще раз за ~5 хв.',
    nowMs,
  );
  return null;
}

/**
 * Старт не вдався з ПЕРЕХІДНОЇ причини (мозок лежить, інструкції ще не
 * синхронізовані): повернути запис у чергу зі спробою+1 і чесно сказати, або,
 * вичерпавши стелю, здатися й звільнити тред. Прогону тут ще немає - claim
 * знімає сам threadRetry, тож рекурсивного підйому черги (а з ним і серії
 * однакових відмов на один вебхук) не буває.
 * @param {Env} env
 * @param {ThreadTarget} parsed
 * @param {string} threadKey
 * @param {{ text: string, route: string, attempts: number, atMs: number, chatId?: number | null, statusMessageId?: number | null }} entry
 * @param {number} nowMs
 * @param {number | null} statusMessageId
 * @param {{ retry: string, giveUp: string }} texts
 */
async function retryOrGiveUp(env, parsed, threadKey, entry, nowMs, statusMessageId, texts) {
  const attempts = entry.attempts + 1;
  if (attempts >= START_MAX_ATTEMPTS) {
    await registryThreadClear(env, threadKey);
    await editStatus(env, parsed, statusMessageId, texts.giveUp, nowMs);
    return;
  }
  await registryThreadRetry(env, threadKey, { ...entry, attempts, statusMessageId });
  await editStatus(env, parsed, statusMessageId, texts.retry, nowMs);
}

/**
 * Після завершення прогону треду (кличе handleRuns роутера): віддати чергу.
 * runId - власник claim-у: чужий finish (summarize) - no-op у DO (ревʼю PR-3).
 * @param {Env} env
 * @param {{ chatId: number | null, threadId: number | string | null }} parsed
 * @param {string} threadKey
 * @param {string | null} runId
 * @param {number} nowMs
 */
export async function registryThreadFinishAndKick(env, parsed, threadKey, runId, nowMs) {
  const { next } = await registryThreadFinish(env, threadKey, runId);
  if (!next) return;
  const target = next.chatId != null ? { ...parsed, chatId: next.chatId } : parsed;
  // «▸ Черга: N» цього запису стає «▸ Думаю…» його прогону.
  if (next.statusMessageId != null) {
    await editStatus(env, target, next.statusMessageId, STATUS_DRAFT, nowMs);
  }
  await startClaimedRun(env, target, threadKey, next, nowMs, next.statusMessageId ?? null);
}

/**
 * «Підняття» черг після відновлення мозку (задача brain-health, S-0-7):
 * спершу сторож (звільнити мертві claim-и, чесно закрити їхні статусники),
 * потім вільні треди з чергою стартують голову. Збій одного треду не зупиняє
 * решту (ізоляція, як у тіку планувальника).
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function kickPendingThreads(env, nowMs = Date.now()) {
  const { freedThreads } = await registrySweep(env, nowMs);
  for (const freed of freedThreads) {
    console.error(
      `prerouter: сторож звільнив тред ${freed.threadId} (мертвий claim, у черзі ${freed.queued})`,
    );
    if (freed.statusMessageId != null) {
      const target = parsedForThread(env, freed.threadId, freed.chatId);
      await editStatus(
        env,
        target,
        freed.statusMessageId,
        'Не дочекався відповіді мозку - напиши ще раз.',
        nowMs,
      ).catch(() => {});
    }
  }

  const threads = await registryThreadsSnapshot(env);
  let kicked = 0;
  for (const [threadKey, t] of Object.entries(threads)) {
    if (t.activeRunId != null || t.queue.length === 0) continue;
    try {
      const { next } = await registryThreadKickNext(env, threadKey);
      if (!next) continue;
      const parsed = parsedForThread(env, threadKey, next.chatId ?? null);
      if (next.statusMessageId != null) {
        await editStatus(env, parsed, next.statusMessageId, STATUS_DRAFT, nowMs);
      }
      await startClaimedRun(env, parsed, threadKey, next, nowMs, next.statusMessageId ?? null);
      kicked += 1;
    } catch (/** @type {any} */ e) {
      console.error(`prerouter: підняття треду ${threadKey} впало`, e?.message);
    }
  }
  return { kicked };
}

/**
 * Callback-и простору мозку 07 §9 (дротування p:/u: - борг PR-8 етапу 1).
 * Повертає текст тосту або null («не наш» - легасі-ланцюг worker.js).
 * p:/u: - бойові (policy PR-8); v: - голос (ADR-040, кнопки ядра, не мозку);
 * c:/r:/a:/m: - чесні заглушки до своїх етапів.
 *
 * `defer` (ревʼю PR-4): куди скласти РОБОТУ, що триває довше за вікно
 * answerCallbackQuery (розпізнавання - до 45 с, старт прогону - до 10 с).
 * Telegram інвалідує callback_query за секунди, тож тост мусить повернутись
 * одразу, а робота - виконатись після відповіді, у тому ж waitUntil. Без
 * `defer` робота виконується інлайн (тести, майбутні викликачі).
 * @param {Env} env
 * @param {{ data?: unknown, chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {number} [nowMs]
 * @param {((work: () => Promise<void>) => void) | null} [defer]
 * @returns {Promise<string | null>}
 */
export async function handleBrainCallback(env, parsed, nowMs = Date.now(), defer = null) {
  if (env.ASSISTANT_V2 !== 'shadow' && env.ASSISTANT_V2 !== 'on') return null;
  const data = String(parsed.data ?? '');
  const policy = parsePolicyCallback(data);
  if (policy) {
    if (policy.kind === 'undo') {
      return undoToast(await resolveUndo(env, policy.id, nowMs));
    }
    const res = await resolveProposal(env, { id: policy.id, choice: policy.choice }, nowMs);
    if (res.ok && 'status' in res) {
      await clearKeyboard(env, parsed);
      // Тост Telegram зникає за секунди й не лишається в історії - рішення й
      // результат мусять стояти в треді (приймання 05.09: «після ✅ нічого не
      // відбувається»). Модель дізнається про нього дайджестом у наступному
      // прогоні (recentDecisions).
      await reply(
        env,
        { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null },
        decisionText(res),
        nowMs,
      );
    } else if (!res.ok && res.error !== 'unknown-proposal') {
      // Збій після ✅ (виконавця ще немає, виконання впало, слово T2, кривий
      // payload) - теж у тред, інакше та сама тиша, що й до фіксу (ревʼю 05.09).
      await reply(
        env,
        { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null },
        `⚠️ ${proposalToast(res)}`,
        nowMs,
      );
    }
    return proposalToast(res);
  }
  const vm = data.match(/^v:([0-9a-f]{12}):(ok|edit|go)$/);
  if (vm) {
    return voiceCallbackToast(
      env,
      parsed,
      /** @type {string} */ (vm[1]),
      /** @type {'ok' | 'edit' | 'go'} */ (vm[2]),
      nowMs,
      defer,
    );
  }
  // m:w:<id>:short|tone|md - кнопки під результатом працівника (S-7-1, етап 4
  // PR-3): підказка в тред тим самим шляхом, що текст власника, або файл.
  const wm = data.match(/^m:w:([A-Za-z0-9-]{1,40}):(short|tone|md)$/);
  if (wm) {
    return workerResultToast(
      env,
      parsed,
      /** @type {string} */ (wm[1]),
      /** @type {'short' | 'tone' | 'md'} */ (wm[2]),
      nowMs,
      defer,
    );
  }
  // m:ia:<ideaId> - «Все одно запустити» під кешованим аналізом (S-3-4, етап 4
  // PR-2): повторний прогін по коду попри кеш; T0 через policy, як і з чату.
  const ia = data.match(/^m:ia:([A-Za-z0-9-]{1,40})$/);
  if (ia) return ideaRerunToast(env, parsed, /** @type {string} */ (ia[1]), nowMs, defer);
  // m:fg:<id> - меню /forget (S-0-5): пропозиція T2 forget(collection) зі
  // словом; слово власник пише текстом, prerouter його впізнає (resolveT2Word).
  const fg = data.match(/^m:fg:([A-Za-z0-9-]{1,40})$/);
  if (fg) return forgetMenuToast(env, parsed, /** @type {string} */ (fg[1]), nowMs);
  // m:fx:<txId>:<choice> - кнопки під незвичною покупкою (S-4-2, S-4-4, етап 6
  // PR-1). Повідомлення будує ядро без моделі; модель вмикається лише тут,
  // коли власник САМ попросив («Перевірити ціни», «Категорія»).
  const fx = data.match(/^m:fx:([A-Za-z0-9_=-]{1,44}):(price|ok|cat|dupy)$/);
  if (fx) {
    return financeCallbackToast(
      env,
      parsed,
      /** @type {string} */ (fx[1]),
      /** @type {'price' | 'ok' | 'cat' | 'dupy'} */ (fx[2]),
      nowMs,
      defer,
    );
  }
  // c:<chainId>:<choice> - кнопки ланцюгів (07 §9): вибір іде подією у
  // Workflow; kind - з рядка chains, тип події - з назви кнопки (registry).
  const cm = data.match(/^c:([A-Za-z0-9-]{1,40}):([a-z_0-9]{1,16})$/);
  if (cm) {
    return chainCallbackToast(
      env,
      parsed,
      /** @type {string} */ (cm[1]),
      /** @type {string} */ (cm[2]),
    );
  }
  const stub = data.match(/^([cram]):/)?.[1];
  if (!stub) return null;
  return {
    // c: не за форматом вище (чужий/пошкоджений chainId або choice) - чесна
    // відмова, а не легасі «Застаріла кнопка» з іншою причиною.
    c: 'Невідома кнопка ланцюга.',
    r: 'Нагадування нового шляху - з інструментами запису (PR-6).',
    a: 'Відповіді на питання прогону - пізніше цим етапом.',
    m: 'Меню - пізніше.',
  }[/** @type {'c' | 'r' | 'a' | 'm'} */ (stub)];
}

// Мапа кнопок плану дня живе в chains/registry.mjs; реекспорт заради тестів.
export { dayPlanChoiceEvent };

/**
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} chainId @param {string} choice
 */
async function chainCallbackToast(env, parsed, chainId, choice) {
  const kind = await readChainKind(env, chainId).catch((/** @type {any} */ e) => {
    console.error('prerouter: kind ланцюга не прочитано', e?.message);
    return null;
  });
  if (!kind) return 'Ланцюг не знайдено - напиши текстом.';
  const ev = choiceEvent(kind, choice);
  if (!ev) return 'Невідома кнопка ланцюга.';
  try {
    await sendChainEvent(env, chainId, ev.type, ev.payload);
  } catch (/** @type {any} */ e) {
    console.error('prerouter: кнопка ланцюга не доставлена', e?.message);
    return 'Ланцюг не відповідає - напиши текстом.';
  }
  // Кнопка з `keep` (пункт чекліста поїздки) лишає клавіатуру: у блоці
  // кілька пунктів, і власник відмічає їх один за одним.
  if (ev.keep) return 'Відмітив.';
  await clearKeyboard(env, parsed);
  return 'Прийняв.';
}

/**
 * Тап у меню /forget: створити T2-пропозицію forget(collection) і сказати
 * слово. Тред пропозиції - тред кнопки, щоб слово з того ж треду її знайшло.
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} collectionId
 * @param {number} nowMs
 */
async function forgetMenuToast(env, parsed, collectionId, nowMs) {
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  const out = await applyPolicy(
    env,
    {
      kind: 'forget',
      payload: { target: 'collection', collection: collectionId },
      threadId: threadKey,
      chatId: parsed.chatId ?? null,
      tainted: false,
    },
    nowMs,
  );
  if (out.mode !== 'proposed')
    return `Не вийшло: ${out.mode === 'error' ? out.error : 'без пропозиції'}`;
  await clearKeyboard(env, parsed);
  await reply(
    env,
    target,
    `Щоб стерти колекцію з усіма записами, напиши слово: ${out.proposal.word} (діє 10 хв).`,
    nowMs,
  );
  return 'Чекаю слово';
}

/**
 * «Все одно запустити» (S-3-4): аналіз по коду заново, попри кеш sha. Тап
 * власника - чиста сесія (tainted:false, як у forgetMenuToast); результат
 * старту - у тред, сам звіт прийде з Workflow документом. Робота - у defer
 * (GitHub API для HEAD + dispatch - секунди, тост має піти одразу).
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} ideaId @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer
 */
async function ideaRerunToast(env, parsed, ideaId, nowMs, defer) {
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  const work = async () => {
    let text;
    /** @type {Record<string, unknown> | undefined} */
    let extra;
    try {
      const out = await applyPolicy(
        env,
        {
          kind: 'ideas.analyze',
          payload: { id: ideaId, mode: 'code', force: true },
          threadId: threadKey,
          chatId: parsed.chatId ?? null,
          tainted: false,
        },
        nowMs,
      );
      text =
        out.mode === 'executed'
          ? rerunText(/** @type {Record<string, unknown>} */ (out.result))
          : `Не вийшло: ${out.mode === 'error' ? out.error : 'без пропозиції'}`;
      // T0 з кнопки - теж із «↩» (ревʼю PR-2): без неї undo-рядок лежав би
      // в базі, а власник не мав би що натиснути.
      if (out.mode === 'executed' && out.undo)
        extra = { reply_markup: { inline_keyboard: out.undo.buttons } };
    } catch (/** @type {any} */ e) {
      text = `Не вийшло: ${String(e?.message ?? e)}`;
    }
    await reply(env, target, text, nowMs, extra);
  };
  await clearKeyboard(env, parsed);
  if (defer) {
    defer(() =>
      work().catch((/** @type {any} */ e) =>
        console.error('prerouter: повторний аналіз ідеї впав', e?.message),
      ),
    );
  } else await work();
  return 'Запускаю аналіз заново';
}

/**
 * Тап під повідомленням про незвичну покупку (S-4-2, S-4-4). «Ок» і «Ні» -
 * просто зняти клавіатуру: власник подивився, питання закрите. «Перевірити
 * ціни» і «Категорія» кладуть у тред текст ВІД ІМЕНІ ВЛАСНИКА тим самим
 * шляхом, що його повідомлення (черга треду, статусник, ретраї) - жодного
 * окремого стану й жодного нового профілю.
 *
 * Текст підказки будує ЯДРО з полів транзакції, не модель: description
 * мерчанта в нього не потрапляє (це зовнішній текст - Фінансист візьме його
 * сам через finance.query і за своїми правилами).
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} txId @param {'price' | 'ok' | 'cat' | 'dupy'} choice @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer
 */
async function financeCallbackToast(env, parsed, txId, choice, nowMs, defer) {
  if (choice === 'ok' || choice === 'dupy') {
    await clearKeyboard(env, parsed);
    return choice === 'ok' ? 'Ок' : 'Добре, перевір';
  }
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  if (target.chatId == null) return 'Невідомий чат.';
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  const text =
    choice === 'price' ? `перевір ціни по покупці ${txId}` : `зміни категорію покупки ${txId}`;
  const work = () =>
    startOrQueueThreadText(env, target, threadKey, text, 'chat', nowMs).then(() => undefined);
  await clearKeyboard(env, parsed);
  if (defer) {
    defer(() =>
      work().catch((/** @type {any} */ e) =>
        console.error('prerouter: кнопка фінансів впала', e?.message),
      ),
    );
  } else await work();
  return choice === 'price' ? 'Шукаю ціни' : 'Слухаю категорію';
}

/**
 * Кнопки під результатом працівника (S-7-1): «Коротше»/«Інший тон» - підказка
 * в тред як текст власника (chat-сесія памʼятає задачу й результат), «.md» -
 * файл із бази. Клавіатуру не знімаємо: кнопки можна тиснути кілька разів.
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} id @param {'short' | 'tone' | 'md'} choice @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer - старт прогону довший за
 *   вікно тосту (як у ideaRerunToast)
 */
async function workerResultToast(env, parsed, id, choice, nowMs, defer) {
  /** @type {Awaited<ReturnType<typeof loadWorkerResult>>} */
  let result;
  try {
    result = await loadWorkerResult(env, id);
  } catch (/** @type {any} */ e) {
    // Збій бази - не «протухло» (ревʼю PR-3): власник має бачити різницю.
    console.error('prerouter: результат працівника не прочитано', e?.message);
    return 'База недоступна - спробуй пізніше.';
  }
  if (!result) return 'Результат уже не в базі.';
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  if (target.chatId == null) return 'Невідомий чат.';
  if (choice === 'md') {
    await sendWorkerDocument(env, /** @type {any} */ (target), result, nowMs);
    return 'Файл у треді';
  }
  const work = () =>
    startOrQueueThreadText(env, target, threadKey, WORKER_FOLLOWUPS[choice], 'chat', nowMs).then(
      () => undefined,
    );
  if (defer) {
    defer(() =>
      work().catch((/** @type {any} */ e) =>
        console.error('prerouter: підказка за кнопкою працівника впала', e?.message),
      ),
    );
  } else await work();
  return choice === 'short' ? 'Скорочую' : 'Міняю тон';
}

/** Текст у тред після старту заново. @param {Record<string, unknown>} r */
export function rerunText(r) {
  const n = r.number != null ? `#${String(r.number)}` : '';
  if (r.started)
    return `Запустив аналіз ідеї ${n} по коду ${String(r.repo)}@${String(r.sha)} заново - ${String(r.eta)}, результат прийде документом.`;
  if (r.running) return `Аналіз ідеї ${n} уже йде - дочекайся документа.`;
  return `Аналіз ідеї ${n}: ${String(r.note ?? 'без змін')}`;
}

/**
 * Тап кнопки голосу (ADR-040): ✅ - транскрипт іде в тред як текст; ✏️ -
 * скасувати; «Розпізнати» - довге голосове в роботу.
 *
 * claimPendingVoice - CAS (claimed_at): подвійний тап другому віддає
 * «Застаріло», не другий прогін. Ряд ЛИШАЄТЬСЯ до відомого результату: при
 * збої «Розпізнати» його повертають у гру разом із живою кнопкою - інакше
 * file_id зникав би назавжди на першій же мережевій невдачі (ревʼю PR-4).
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null }} parsed
 * @param {string} id
 * @param {'ok' | 'edit' | 'go'} choice
 * @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer
 * @returns {Promise<string>}
 */
async function voiceCallbackToast(env, parsed, id, choice, nowMs, defer) {
  const row = await claimPendingVoice(env, id, nowMs);
  if (!row) return 'Застаріло - надішли голосове ще раз.';
  const run = async (/** @type {() => Promise<void>} */ work) => {
    if (defer) defer(work);
    else await work();
  };

  if (choice === 'edit') {
    await finishPendingVoice(env, id, true);
    await clearKeyboard(env, parsed);
    return 'Ок - напиши текстом.';
  }

  /** @type {ThreadTarget} */
  const target = {
    chatId: row.chatId != null ? Number(row.chatId) : (parsed.chatId ?? null),
    threadId: row.threadId,
  };

  if (choice === 'ok' && row.kind === 'transcript' && row.text) {
    const threadKey = row.threadId == null ? THREAD_DM : String(row.threadId);
    const text = row.text;
    // Рішення власника прийнято - кнопки зайві незалежно від долі прогону.
    await clearKeyboard(env, parsed);
    await run(async () => {
      try {
        await routeThreadText(env, target, threadKey, text, nowMs);
      } catch (/** @type {any} */ e) {
        console.error('prerouter: підтверджений транскрипт не поїхав', e?.message);
        await reply(env, target, 'Не вдалося запустити - напиши ще раз.', nowMs).catch(() => {});
      }
      await finishPendingVoice(env, id, true);
    });
    return 'Прийняв ✅';
  }

  if (choice === 'go' && row.kind === 'file' && row.fileId) {
    const fileId = row.fileId;
    const durationS = row.durationS;
    await run(async () => {
      const ok = await transcribeAndPresent(env, target, { fileId, durationS }, nowMs).catch(
        (/** @type {any} */ e) => {
          console.error('prerouter: розпізнавання довгого голосового впало', e?.message);
          return false;
        },
      );
      await finishPendingVoice(env, id, ok);
      // Кнопку знімаємо ЛИШЕ при успіху: інакше повторний тап - єдиний спосіб
      // дістати те саме аудіо, і він має лишитись.
      if (ok) await clearKeyboard(env, parsed);
    });
    return 'Розпізнаю…';
  }

  // Розсинхрон kind↔choice (не трапляється зі своїх кнопок) - чесна відмова.
  await finishPendingVoice(env, id, true);
  return 'Застаріло - надішли голосове ще раз.';
}

/** Зняти інлайн-клавіатуру - best-effort: тост важливіший за косметику.
 *  @param {Env} env @param {{ chatId?: number | null, messageId?: number | null }} parsed */
async function clearKeyboard(env, parsed) {
  if (parsed.messageId == null || parsed.chatId == null) return;
  await tgCall(env, 'editMessageReplyMarkup', {
    chat_id: parsed.chatId,
    message_id: parsed.messageId,
  }).catch(() => {});
}

/** @param {Awaited<ReturnType<typeof resolveProposal>>} res */
function proposalToast(res) {
  if (!res.ok) {
    if (res.error === 'word-required') return 'Це T2: напиши слово-підтвердження текстом.';
    if (res.error.startsWith('no-executor'))
      return 'Прийнято, але виконавця ще немає - лишив відкритою.';
    return `Не вийшло: ${res.error}`;
  }
  if ('already' in res) return `Вже вирішено (${res.already}).`;
  if (res.status === 'approved') return res.executed ? 'Підтверджено ✅' : 'Підтверджено.';
  if (res.status === 'rejected') return 'Відхилено.';
  return 'Прострочено - створи запит заново.';
}

/**
 * Рядок у тред після рішення по пропозиції: що саме сталось і з чим.
 * @param {Awaited<ReturnType<typeof resolveProposal>>} res
 */
function decisionText(res) {
  if (!res.ok || !('status' in res)) return proposalToast(res);
  // Підпис із результату виконавця; без назви там - із payload пропозиції
  // (export віддає {filename, rows}, accept - {date}; приймання 05.09, B4).
  const payload = 'payload' in res ? res.payload : null;
  const fromResult = res.status === 'approved' ? describeProposal(res.kind, res.result) : res.kind;
  const what = fromResult !== res.kind ? fromResult : describeProposal(res.kind, payload);
  if (res.status === 'approved') return `✅ Виконано: ${what}.`;
  if (res.status === 'rejected') return `❌ Відхилено: ${what}.`;
  return `⌛ Прострочено: ${what} - попроси ще раз, якщо ще актуально.`;
}

/**
 * Коротко про дію для власника: kind + впізнаваний ключ із payload/result
 * (назва, текст, ключ факту). Без JSON у чаті.
 * @param {string} kind @param {unknown} obj
 */
export function describeProposal(kind, obj) {
  const o = /** @type {Record<string, unknown>} */ (obj && typeof obj === 'object' ? obj : {});
  // Порядок: назва → дата (plan.*) → файл (export) → короткий текст → колекція
  // → номер → id. Довгий text (чернетка плану) - не підпис (приймання 05.09, B4).
  const shortText = typeof o.text === 'string' && o.text.length <= 80 ? o.text : null;
  const label =
    kind === 'facts.set'
      ? [o.kind, o.key].filter(Boolean).join('.')
      : (o.title ??
        o.name ??
        o.date ??
        o.filename ??
        shortText ??
        o.collection ??
        (o.number != null ? `#${o.number}` : null) ??
        // delete/cancel/analyze шлють лише id (ревʼю 05.09) - хай буде хоч він.
        (o.id != null ? String(o.id) : null));
  // payload писала модель (можливо, з листа): керівні символи геть, інакше
  // «\n[Ядро] …» у назві підробив би рядок дайджесту (security-ревʼю 05.09).
  // kind не санітизуємо - невідомий kind applyPolicy відкидає ще до запису.
  const clean = String(label ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, 80);
  // Гості з РЕЗУЛЬТАТУ виконавця (calendar.event/invite, етап 5): власник
  // мусить бачити, кому справді пішло запрошення, а не лише назву з payload
  // моделі (security-ревʼю етапу 5).
  const guests = Array.isArray(o.attendees)
    ? o.attendees
        .map((a) =>
          String(a ?? '')
            .replace(/\p{Cc}+/gu, ' ')
            .trim(),
        )
        .filter(Boolean)
        .slice(0, 10)
    : [];
  const tail = guests.length ? ` (гості: ${guests.join(', ')})` : '';
  return clean ? `${kind} «${clean}»${tail}` : `${kind}${tail}`;
}

/**
 * Дайджест рішень власника по пропозиціях цього треду, ухвалених ПІСЛЯ
 * останнього завершеного chat-прогону (кнопки ✅/❌/«↩» виконує ядро, модель
 * їх не бачить). Порожній рядок, якщо рішень не було.
 * @param {Env} env @param {string} threadKey @param {number} nowMs
 */
async function recentDecisions(env, threadKey, nowMs) {
  if (!env.DB) return '';
  try {
    const last = /** @type {{ t?: string } | null} */ (
      await env.DB.prepare(
        `SELECT max(finished_at) AS t FROM runs WHERE thread_id = ? AND finished_at IS NOT NULL AND profile = 'chat'`,
      )
        .bind(threadKey)
        .first()
    );
    const since = last?.t ?? new Date(nowMs - 24 * 3_600_000).toISOString();
    const { results } = await env.DB.prepare(
      `SELECT kind, status, payload_json, decided_at FROM proposals
       WHERE thread_id = ? AND decided_at IS NOT NULL AND decided_at > ?
       ORDER BY decided_at DESC LIMIT ?`,
    )
      .bind(threadKey, since, DECISIONS_MAX + 1)
      .all();
    // Найновіші (ревʼю 05.09: ASC LIMIT брав найстаріші, а решта губилась
    // назавжди - наступний since уже стояв за ними); показуємо хронологічно,
    // а про відкинуті старіші кажемо одним рядком.
    const all =
      /** @type {{ kind: string, status: string, payload_json: string, decided_at: string }[]} */ (
        results ?? []
      );
    const rows = all.slice(0, DECISIONS_MAX).reverse();
    if (rows.length === 0) return '';
    const more = all.length > DECISIONS_MAX ? '\n… і ще раніші рішення - див. пропозиції' : '';
    const lines = rows.map((r) => {
      /** @type {unknown} */
      let payload = null;
      try {
        payload = JSON.parse(r.payload_json);
      } catch {
        // кривий JSON - лише kind без деталей
      }
      const undo = r.kind.startsWith('undo:');
      const kind = undo ? r.kind.slice('undo:'.length) : r.kind;
      const verdict = undo
        ? '↩ скасовано'
        : r.status === 'approved'
          ? '✅ виконано'
          : r.status === 'rejected'
            ? '❌ відхилено'
            : '⌛ прострочено';
      return `${verdict}: ${describeProposal(kind, payload)}`;
    });
    return `[Ядро] Рішення власника по твоїх пропозиціях після попередньої відповіді (виконано ядром, не повторюй):\n${lines.join('\n')}${more}`;
  } catch (/** @type {any} */ e) {
    console.error('prerouter: дайджест рішень не зібрано', e?.message);
    return '';
  }
}

/** @param {Awaited<ReturnType<typeof resolveUndo>>} res */
function undoToast(res) {
  if (!res.ok) return `Не вийшло: ${res.error}`;
  if ('already' in res) return 'Вже застосовано.';
  return res.status === 'undone' ? 'Відкочено ↩' : 'Вікно скасування минуло (10 хв).';
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

/** Чи має тред що зупиняти (активний прогін або чергу) - дешевий знімок DO.
 *  Збій читання не має ковтати «стоп»: невідомо = ні, лишаємо легасі.
 *  @param {Env} env @param {string} threadKey */
async function hasLiveThread(env, threadKey) {
  try {
    const threads = await registryThreadsSnapshot(env);
    const t = Object.entries(threads).find(([key]) => key === threadKey)?.[1];
    return Boolean(t && (t.activeRunId != null || t.queue.length > 0));
  } catch (/** @type {any} */ e) {
    console.error('prerouter: знімок тредів для «стоп» не прочитано', e?.message);
    return false;
  }
}

/** Shadow-класифікація без відповіді (01 §5): рядок у runs для приймального
 *  порівняння - і далі легасі.
 *  @param {Env} env @param {ThreadTarget} parsed @param {string} text @param {number} nowMs */
async function shadowClassifyLog(env, parsed, text, nowMs) {
  const route = classifyRoute(text);
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  const runId = crypto.randomUUID();
  // trigger='shadow' (ревʼю PR-3): інакше класифікація була б невідрізненна
  // від бойових прогонів у runs і забруднила б статистику назавжди; profile
  // лишається route - саме його порівнює приймання.
  await registryBegin(env, {
    id: runId,
    trigger: 'shadow',
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
  const expected = await readExpected(env);
  parts.push(
    expected?.gitSha ? `Мозок: ${String(expected.gitSha).slice(0, 8)}` : 'Мозок: невідомо',
  );
  const threads = await registryThreadsSnapshot(env);
  const active = Object.values(threads).filter((t) => t.activeRunId != null).length;
  const queued = Object.values(threads).reduce((n, t) => n + t.queue.length, 0);
  parts.push(`Прогони: ${active} активних, ${queued} у черзі`);
  // Інструкції (ревʼю PR-5): після переходу на D1 «не синхронізовані» - чи не
  // найімовірніша причина мертвого чату, а /status був першим, куди власник
  // дивиться, і мовчав про них.
  parts.push(await instructionsStatusLine(env));
  parts.push(`Режим: ${env.ASSISTANT_V2}`);
  return parts.join(' · ');
}

/** @param {Env} env */
async function instructionsStatusLine(env) {
  if (!env.DB) return 'Інструкції: немає DB';
  try {
    const { results } = await env.DB.prepare(
      'SELECT count(*) AS n, max(deployed_at) AS last FROM instructions',
    ).all();
    const row = /** @type {any} */ (results?.[0]);
    const n = Number(row?.n ?? 0);
    if (n === 0) return 'Інструкції: НЕМАЄ (синк не відпрацював)';
    return `Інструкції: ${n}, оновлені ${String(row?.last ?? '?').slice(0, 10)}`;
  } catch (/** @type {any} */ e) {
    console.error('prerouter: читання instructions для /status', e?.message);
    return 'Інструкції: невідомо';
  }
}

// ── Транспортні дрібниці ─────────────────────────────────────────────────────

/** Ціль відправки для треду: chatId прогону/запису або спільний чат.
 *  @param {Env} env @param {string} threadKey @param {number | null} [chatId]
 *  @returns {ThreadTarget} */
export function parsedForThread(env, threadKey, chatId = null) {
  return {
    chatId: chatId ?? (env.TELEGRAM_CHAT_ID ? Number(env.TELEGRAM_CHAT_ID) : null),
    threadId: threadKey === THREAD_DM ? null : threadKey,
  };
}

/** Відповідь новим шляхом - через outbox (порядок і 429 як у deliver).
 *  extra - додаткові поля payload (reply_markup кнопок v:, ADR-040).
 *  @param {Env} env @param {ThreadTarget} parsed @param {string} text
 *  @param {number} nowMs @param {Record<string, unknown>} [extra] */
async function reply(env, parsed, text, nowMs, extra = undefined) {
  if (parsed.chatId == null) return;
  await enqueueOutbox(
    env,
    {
      chatId: parsed.chatId,
      threadId: parsed.threadId == null ? null : parsed.threadId,
      kind: 'send',
      payload: { text, ...(extra ?? {}) },
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
    if (typeof id !== 'number') return null;
    // Чернетка стає самою відповіддю (фікс 30.08), тож /clear мусить знати про
    // неї - інакше відповіді асистента переживають очищення.
    try {
      await putSentMessages(
        env,
        recordSentMessage(await loadSentMessages(env), parsed.chatId, parsed.threadId, id),
      );
    } catch (/** @type {any} */ e) {
      console.error('prerouter: трекінг чернетки для /clear не вдався', e?.message);
    }
    return id;
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
 *  @param {Env} env @param {string} threadKey @param {number} nowMs */
async function readSession(env, threadKey, nowMs) {
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
      // Позначка - epoch-ms останнього зовнішнього читання, діє TAINT_TTL_MS.
      tainted: isTaintActive(row.tainted, nowMs),
    };
  } catch (/** @type {any} */ e) {
    console.error('prerouter: читання сесії впало - свіжа сесія, tainted fail-safe', e?.message);
    return { sdkSessionId: null, summaryMd: null, tainted: true };
  }
}
