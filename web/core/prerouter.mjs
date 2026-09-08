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
import { parseCommand } from '../tg-core.mjs';
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
import { parsePolicyCallback, T2_WORD_RE, isTaintActive } from './policy/core.mjs';
import { resolveProposal, resolveUndo, undoLastInThread } from './policy/proposals.mjs';
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
import { activeRemindersForList } from '../commands.mjs';
import { buildRemindersKeyboard, formatRemindersListMessage } from '../reminders-core.mjs';
import { actionPhrase, actionIcon } from './tg/phrase.mjs';
import { proposalVolume } from './policy/volume.mjs';
import { LINK_FOLLOWUPS } from './links.mjs';
import { resolveWaypoint } from './tools/places.mjs';
import { routesEta } from './adapters/maps.mjs';
import { findIdea } from './tools/ideas.mjs';
import { kyivClock } from '../kyiv-time.mjs';
import { renderMdParts } from './tg/markdown.mjs';
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
import { startInboxExport, tooBig, FILE_MAX_BYTES } from './chains/inbox-export.mjs';
import { listInboxChats } from './inbox/store.mjs';

export const THREAD_DM = 'dm';
/** Скільки транскрипта показуємо в «Я почув»: одне повідомлення з кнопками
 *  (Telegram ріже на 4096, а клавіатура лишається лише на останній частині).
 *  У прогін іде ПОВНИЙ текст із voice_pending. */
const VOICE_PREVIEW_MAX_CHARS = 700;
// Не експортуються свідомо (ревʼю PR-3): споживачів назовні немає, а export
// сигналив би «на це хтось спирається».
// Перший статус - до того, як модель зробила хоч крок: ядро ще не знає, про
// що запит, і «Думаю…» тут не інформація, а заповнювач (скарга власника
// 08.09). «Беруся» каже правду: запит прийнято, робота почалась. Далі його
// заміняє мозок - назвою того, що САМЕ ЗАРАЗ робить (brain/tools/status-words).
const STATUS_DRAFT = '▸ Беруся…';
const START_MAX_ATTEMPTS = 3;
const STOP_RE = /^стоп[.!]?$/i;
/** «Відміни останнє» (PR-7 §3.5) - лише УЗАГАЛЬНЕНІ форми.
 *
 * ⚠️ Навмисно вузько (ревʼю релізу). Ширший шаблон пускав будь-яке слово
 * після «останнє», і «скасуй останнє нагадування» перехоплювалось тут, а
 * відкочувався останній рядок `undo:%` треду - ним могла бути подія в
 * календарі. Прохання зняти нагадування видаляло подію. Усе, що називає
 * ПРЕДМЕТ, тепер іде в мозок: він знає, що саме шукати.
 *
 * Форми без предмета перелічені явно, включно з «відкотити» й «останню» -
 * другий прохід ревʼю показав, що звуження зачепило й їх, і кожна така фраза
 * коштувала повного прогону мозку.
 */
const UNDO_LAST_RE =
  /^(?:відмін(?:и|ити)|скасуй|скасувати|відкоти(?:ти)?)\s+(?:останн(?:є|ю|ій)(?:\s+(?:дію|запис|зміну))?|це)\s*[.!]?$/i;
/** Скільки найновіших рішень по пропозиціях іде в дайджест входу моделі. */
const DECISIONS_MAX = 8;
/** Запас до початку події поверх ETA і фолбек, коли маршрут не порахувався. */
const DEPARTURE_BUFFER_MIN = 10;
const DEPARTURE_FALLBACK_MIN = 30;
/**
 * Що зрізати з назви дії, яку писала модель: керівні символи, форматні й
 * роздільники рядка - саме ними підробляють повідомлення (U+2028/U+2029 у
 * \p{Cc}\p{Cf} не входять, але рядок рвуть так само).
 *
 * ⚠️ ZWJ (U+200D) - виняток. Формально він \p{Cf}, але саме він тримає «👨‍💻»
 * одним емодзі: без нього назва «👨‍💻 Робота» показувалась би як «👨 💻
 * Робота» (другий прохід ревʼю). Різниця множин `[…--[…]]` вимагала б
 * прапорця `v`, тобто target ES2024 на весь проєкт заради одного регекса -
 * тому виняток зроблено передпереглядом.
 */
const SANITIZE_RE = /(?:(?!‍)[\p{Cc}\p{Cf}\s])+/gu;

const MODELS = {
  chat: 'claude-sonnet-5',
  quick: 'claude-haiku-4-5',
  'weekly-review': 'claude-sonnet-5',
  'day-planner': 'claude-sonnet-5',
  // Дайджест чатів (етап 6 PR-4, 07 §5): Haiku з єдиним inbox.search.
  'inbox-digest': 'claude-haiku-4-5',
};
/** Імʼя інструкції в D1 за маршрутом (дзеркало INSTRUCTION_NAME_BY_PROFILE мозку). */
const INSTRUCTION_BY_ROUTE = {
  chat: 'persona',
  quick: 'quick',
  'weekly-review': 'weekly-review',
  'day-planner': 'day-planner',
  // 07 §5: «persona + правило дайджесту» - правило їде в тексті задачі, тож
  // окремої інструкції в D1 (і рядка в sync-instructions) не заводимо.
  'inbox-digest': 'persona',
};
/** @typedef {'chat' | 'quick' | 'weekly-review' | 'day-planner' | 'inbox-digest'} RunRoute */

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

/**
 * Команди нового шляху. null = не наша - падає в легасі (07 §10).
 *
 * ⚠️ ЗВІДКИ ЦЕЙ СПИСОК (реліз 08.09, скарги 2 і 12). Реєстр розрісся до
 * шістнадцяти команд, половина з яких дублювала Mini App або вільний текст, а
 * `/plan` узагалі ходив старим шляхом і відповідав не те. Лишились вісім - ті,
 * що або роблять щось, чого текстом не скажеш (`/clear`, `/new`), або є
 * входом у небезпечне (`/forget`), або відповідають швидше за прогін
 * (`/status`, `/help`). Решта живе вільним текстом і в Mini App.
 *
 * @param {string} text
 */
export function parseNewCommand(text) {
  // parseCommand розбирає і «/x args», і ЛЕЙБЛИ reply-клавіатури («⏰
  // Нагадування») - без нього тап по паду йшов би в мозок вільним текстом і
  // коштував прогону там, де є детермінована відповідь.
  const parsed = parseCommand(text);
  if (!parsed || !NEW_COMMAND_NAMES.has(parsed.cmd)) return null;
  return { cmd: parsed.cmd, args: parsed.args.trim() };
}

/** Вісім команд і те, що вони роблять - джерело і для /help, і для меню Telegram. */
export const NEW_COMMANDS = [
  { command: 'help', description: 'Що я вмію' },
  { command: 'plan', description: 'План на день' },
  { command: 'remind', description: 'Нагадування: список або нове' },
  { command: 'brief', description: 'Ранковий брифінг зараз' },
  { command: 'status', description: 'Чи все живе' },
  { command: 'clear', description: 'Прибрати останні повідомлення' },
  { command: 'new', description: 'Почати розмову з чистого аркуша' },
  { command: 'forget', description: 'Стерти дані' },
];

/** Швидкий відсів для parseNewCommand: рівно ті, що обробляє новий шлях. */
const NEW_COMMAND_NAMES = new Set(['help', 'plan', 'remind', 'status', 'new', 'forget']);

const HELP_TEXT = [
  'Пиши як людині - командою майже нічого не треба.',
  '',
  '⏰ «нагадай через 20 хв полити квіти»',
  '🗓 «постав зустріч із Марком завтра о 15:00»',
  '💡 «збережи ідею: …» · 🎁 «хочу …» · 💸 «куди пішли гроші в серпні»',
  '✉️ «що там у пошті» · 📍 «як доїхати до …» · 🖼 «намалюй …»',
  '',
  'Команди - лише там, де текст не підходить:',
  ...NEW_COMMANDS.map((c) => `/${c.command} - ${c.description}`),
  '',
  'Решта - у Mini App: статистика, вакансії, збережене, роадмеп, налаштування.',
].join(String.fromCharCode(10));

/**
 * Головний вхід з worker.js. true = оброблено новим шляхом (легасі не чіпати).
 * @param {Env} env
 * @param {{ kind?: string, chatId?: number | null, threadId?: number | string | null, text?: unknown, messageId?: number | null, fromId?: number | string | null, voice?: { fileId: string, durationS: number, fileSize: number | null } | null, document?: { fileId: string, fileName: string, mimeType: string | null, fileSize: number | null } | null }} parsed
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

  // Документ (S-2-6): експорт історії чату з Telegram Desktop. Файл САМ по
  // собі нічого не запускає, крім цього ланцюга - і лише .json від власника у
  // темі асистента. У shadow не працює: ланцюг пише в бойову базу.
  if (parsed.document && mode === 'on') {
    if (await handleExportDocument(env, target, parsed.document, nowMs)) return true;
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

  // ⚠️ Лейбл пада, що веде в ЛЕГАСІ (напр. «🔄 Брифінг»), новий шлях НЕ бере
  // (ревʼю релізу). Інакше він не збігався б із parseNewCommand, не починався
  // б зі «/», і йшов би в мозок текстом - тобто прогін заради команди, яку
  // легасі виконує миттєво.
  const legacy = parseCommand(text);
  if (legacy && !NEW_COMMAND_NAMES.has(legacy.cmd)) return false;

  const cmd = parseNewCommand(text);
  if (cmd) {
    if (cmd.cmd === 'help') {
      await send(HELP_TEXT);
      return true;
    }
    if (cmd.cmd === 'new') {
      await resetThreadSession(env, threadKey, nowMs);
      // ⚠️ Одразу кажемо, ЩО саме зникло: власник читав «/new» як «стерти
      // памʼять» і не розумів, навіщо це в чаті з історією (скарга 7).
      await send('Почали з чистого аркуша. Факти й памʼять розмов лишились - зникла лише нитка.');
      return true;
    }
    if (cmd.cmd === 'status') {
      await send(await systemStatusLine(env, target));
      return true;
    }
    // /plan і /remind - той самий шлях, що вільний текст: інакше вони жили б
    // у легасі й відповідали не тим, чим асистент (скарга 12 прогону 08.09).
    if (cmd.cmd === 'plan') {
      await startOrQueueThreadText(
        env,
        target,
        threadKey,
        cmd.args ? `План на день: ${cmd.args}` : 'Склади план на день.',
        'chat',
        nowMs,
      );
      return true;
    }
    if (cmd.cmd === 'remind') {
      if (!cmd.args) {
        await sendRemindersList(env, target, nowMs);
        return true;
      }
      await startOrQueueThreadText(env, target, threadKey, `Нагадай ${cmd.args}`, 'quick', nowMs);
      return true;
    }
    // /forget (S-0-5): меню T2 - колекції, чати, «усе».
    await sendForgetMenu(env, target, nowMs);
    return true;
  }
  // Інші /-команди - легасі (07 §10: «лишаються як є»).
  if (text.startsWith('/')) return false;

  // «Відміни останнє» (PR-7 §3.5): відкат словом, без кнопки - і після того,
  // як вікно «↩» минуло. Детерміновано, без прогону: модель не мусить
  // угадувати, яка саме дія була останньою.
  if (UNDO_LAST_RE.test(text)) {
    await sendUndoLast(env, target, threadKey, nowMs);
    return true;
  }

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
 * «Відміни останнє»: відкат останньої дії треду, з чесним словом про вікно.
 * @param {Env} env @param {ThreadTarget} target @param {string} threadKey @param {number} nowMs
 */
async function sendUndoLast(env, target, threadKey, nowMs) {
  const out = await undoLastInThread(env, threadKey, nowMs).catch((/** @type {any} */ e) => {
    console.error('prerouter: «відміни останнє» впало', e?.message);
    return { ok: /** @type {const} */ (false), reason: /** @type {const} */ ('failed') };
  });
  if (out.ok) {
    const what = lowerFirst(actionPhrase(out.kind, '', 'done'));
    await reply(
      env,
      target,
      out.late
        ? `↩ Відкотив: ${what}. Вікно «↩» вже минуло, тож це не «нічого не було», а окрема дія назад.`
        : `↩ Відкотив: ${what}.`,
      nowMs,
    );
    return;
  }
  const why =
    out.reason === 'none'
      ? 'Нема чого відкочувати - остання дія або вже відкочена, або відкату не має.'
      : out.reason === 'no-undo'
        ? 'Цю дію назад не забрати.'
        : `Не вийшло: ${'error' in out ? out.error : 'збій'}`;
  await reply(env, target, why, nowMs);
}

/**
 * Список активних нагадувань із кнопками скасування - «/remind» без аргументів.
 * ⚠️ Прийшло сюди з окремої команди /reminders (реліз 08.09): дві команди на
 * одну тему власник плутав, а список був порожній, бо читав самий KV.
 * @param {Env} env @param {ThreadTarget} target @param {number} nowMs
 */
async function sendRemindersList(env, target, nowMs) {
  const list = await activeRemindersForList(env);
  const keyboard = buildRemindersKeyboard(list);
  await reply(env, target, formatRemindersListMessage(list), nowMs, {
    parse_mode: 'HTML',
    ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
  });
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
  // Чати з Business (S-2-8) - у тому ж меню: «забути» для власника одне
  // поняття, а те, що всередині це різні цілі forget, його не обходить.
  const chats = await listInboxChats(env, 5).catch((/** @type {any} */ e) => {
    console.error('prerouter: список чатів для /forget не зібрано', e?.message);
    return [];
  });
  // «Усе» (етап 7 PR-4) є ЗАВЖДИ - навіть коли ні колекцій, ні чатів немає:
  // забути можна ще й факти, ідеї, гроші, плани, памʼять. Тому меню більше
  // не буває порожнім, і рядок «забувати нічого» пішов разом із ним.
  const rows = [
    ...collections
      .slice(0, 10)
      .map((c) => [{ text: `🗑 ${c.name} (${c.records})`, callback_data: `m:fg:${c.id}` }]),
    ...chats.map((c) => [
      { text: `🗑 чат ${c.title} (${c.messages})`, callback_data: `m:fgc:${c.id}` },
    ]),
    [{ text: '☠️ УСЕ - стерти всі мої дані', callback_data: 'm:fga' }],
  ];
  await reply(
    env,
    target,
    [
      'Що забути? Це T2 - після кнопки попрошу слово.',
      '«Усе» стирає всі дані власника безповоротно; спершу варто попросити експорт.',
    ].join('\n'),
    nowMs,
    { reply_markup: { inline_keyboard: rows } },
  );
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
  // Дешевий відсів за формою слова («ВИКОНАТИ-7K3»): «дякую» чи «привіт» не
  // мають ходити в базу перед кожним прогоном.
  if (!T2_WORD_RE.test(word)) return false;
  // ⚠️ Слово - це ІДЕНТИФІКАТОР пропозиції, а не її тип (security-ревʼю етапу
  // 7). Доти запит брав «останню відкриту T2 з таким словом», а слів було
  // чотири - модель могла створити кілька пропозицій поспіль, показати
  // власнику невинну й підсунути під його напис іншу, аж до forget=all.
  // Випадковий суфікс робить збіг непідбірним, а сама модель слова не бачить.
  let row;
  try {
    row = /** @type {{ id: string } | null} */ (
      await env.DB.prepare(
        `SELECT id FROM proposals WHERE status = 'open' AND level = 'T2' AND word = ?
         AND thread_id = ? ORDER BY created_at DESC LIMIT 1`,
      )
        .bind(word, threadKey)
        .first()
    );
  } catch (/** @type {any} */ e) {
    // База не відповіла - слово НЕ йде далі в модель як звичайний текст:
    // другий фактор не має перетворюватись на репліку в чаті.
    console.error('prerouter: пошук T2-слова впав', e?.message);
    await reply(env, target, 'Не дістав, чого стосується слово - напиши ще раз.', nowMs);
    return true;
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
  // Статусник ДО claim (S-0-2, ревʼю PR-3): при старті стане «▸ Беруся…»
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
      claim.queued === -1
        ? 'Черга повна - спробуй трохи пізніше.'
        : `▸ Дійду за ${claim.queued} - зараз зайнятий`;
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
      ? (await buildWeeklyReviewInput(env, nowMs)).text
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
  // «▸ Черга: N» цього запису стає першим статусом його прогону.
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
 * @param {{ data?: unknown, chatId?: number | null, messageId?: number | null,
 *   threadId?: number | string | null, replyMarkup?: unknown }} parsed - replyMarkup
 *   потрібен, щоб на місці знятих кнопок лишити напис натиснутої
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
      const undone = await resolveUndo(env, policy.id, nowMs);
      // ⚠️ Клавіатуру знімаємо на БУДЬ-якому вирішеному результаті: кнопка
      // витрачена (прогін 08.09 - після «↩» вона лишалась живою). У тред
      // пишемо лише коли справді відкотили: тост зникає за секунди.
      if (undone.ok) {
        await clearKeyboard(env, parsed);
        if ('status' in undone && undone.status === 'undone') {
          await reply(
            env,
            { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null },
            '↩ Відкотив.',
            nowMs,
          );
        }
      }
      return undoToast(undone);
    }
    const res = await resolveProposal(env, { id: policy.id, choice: policy.choice }, nowMs);
    // T2 після ✅: слово називає ЯДРО (модель його більше не бачить) і тут же
    // запамʼятовує, до якої саме пропозиції воно належить.
    if (!res.ok && res.error === 'word-required' && policy.choice === 'ok') {
      const asked = await askT2Word(env, parsed, policy.id);
      if (!asked) {
        // Слово не дістали - але тиша в треді тут неприпустима: тост зникає
        // за секунди, і власник лишився б із враженням «нічого не сталося»
        // (той самий дефект, що фіксували на прийманні 05.09).
        await reply(
          env,
          { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null },
          `⚠️ ${proposalToast(res)}`,
          nowMs,
        );
        return proposalToast(res);
      }
      // ⚠️ У ТРЕД, не лише тостом (ревʼю етапу 7). Тост зникає за секунди й в
      // історію не потрапляє, а слово тепер знає лише ядро - без цього рядка
      // власник не мав би де його прочитати. Тут же ЯДРО називає саму дію:
      // модель у своєму тексті може написати що завгодно, а стерти базу
      // безповоротно можна рівно одним словом.
      // Обсяг рахуємо ДО слова: «стерти все» і «стерти 1 240 рядків» - два
      // різні рішення, і власник має право ухвалювати друге (A2 прогону 08.09).
      const volume = await proposalVolume(
        env,
        asked.kind,
        /** @type {Record<string, unknown>} */ (asked.payload ?? {}),
      );
      await reply(
        env,
        { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null },
        [
          `⚠️ ${humanAction(asked.kind, asked.payload, 'ask')}${volume ? ` - ${volume}` : ''}.`,
          `Це незворотно. Щоб виконати, напиши слово: ${asked.word} (діє 10 хв).`,
        ].join(String.fromCharCode(10)),
        nowMs,
      );
      return `Напиши слово ${asked.word}`;
    }
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
        undefined,
        true,
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
  const wm = data.match(
    /^m:w:([A-Za-z0-9-]{1,40}):(short|tone|md|next|draft|src|week|cal|spend|more)$/,
  );
  if (wm) {
    return workerResultToast(
      env,
      parsed,
      /** @type {string} */ (wm[1]),
      /** @type {keyof typeof WORKER_FOLLOWUPS | 'md'} */ (wm[2]),
      nowMs,
      defer,
    );
  }
  // Містки між можливостями (PR-6 §2): один тап веде з дії в наступну.
  const dep = data.match(/^m:dep:([A-Za-z0-9-]{1,40})$/);
  if (dep) return departureToast(env, parsed, /** @type {string} */ (dep[1]), nowMs, defer);
  const it = data.match(/^m:it:([A-Za-z0-9-]{1,40})$/);
  if (it) return ideaTaskToast(env, parsed, /** @type {string} */ (it[1]), nowMs, defer);
  const wr = data.match(/^m:wr:(carry|idea)$/);
  if (wr) {
    return linkFollowupToast(env, parsed, /** @type {'carry' | 'idea'} */ (wr[1]), nowMs, defer);
  }
  const buy = data.match(/^m:buy:([A-Za-z0-9-]{1,40})$/);
  if (buy) return boughtToast(env, parsed, /** @type {string} */ (buy[1]), nowMs, defer);
  // m:done - чип на місці знятої клавіатури (скарга 14): тапати нема куди,
  // але Telegram однаково шле callback, і мовчати на нього не можна.
  if (data === 'm:done') return 'Це вже вирішено.';
  // m:ia:<ideaId> - «Все одно запустити» під кешованим аналізом (S-3-4, етап 4
  // PR-2): повторний прогін по коду попри кеш; T0 через policy, як і з чату.
  const ia = data.match(/^m:ia:([A-Za-z0-9-]{1,40})$/);
  if (ia) return ideaRerunToast(env, parsed, /** @type {string} */ (ia[1]), nowMs, defer);
  // m:fg:<id> - меню /forget (S-0-5): пропозиція T2 forget(collection) зі
  // словом; слово власник пише текстом, prerouter його впізнає (resolveT2Word).
  const fg = data.match(/^m:fg:([A-Za-z0-9-]{1,40})$/);
  if (fg) return forgetMenuToast(env, parsed, { collection: /** @type {string} */ (fg[1]) }, nowMs);
  // m:fgc:<chatId> - те саме для чату з Business (S-2-8): та сама T2 зі словом.
  const fgc = data.match(/^m:fgc:(-?[A-Za-z0-9_]{1,40})$/);
  if (fgc) return forgetMenuToast(env, parsed, { chat: /** @type {string} */ (fgc[1]) }, nowMs);
  // m:fga - «усе» (S-0-5, етап 7 PR-4): та сама T2 зі словом, ціль all.
  if (data === 'm:fga') return forgetMenuToast(env, parsed, { all: true }, nowMs);
  // m:fx:<txId>:<choice> - кнопки під незвичною покупкою (S-4-2, S-4-4, етап 6
  // PR-1). Повідомлення будує ядро без моделі; модель вмикається лише тут,
  // коли власник САМ попросив («Перевірити ціни», «Категорія»).
  const fx = data.match(/^m:fx:([A-Za-z0-9_=-]{1,44}):(price|ok|cat|dupy|trip)$/);
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
  // m:fs:<id>:cancel - «Скасувати підписку в обліку» (S-4-6): T0 через policy,
  // як і з чату, тож «↩» повертає статус на місце.
  const fs = data.match(/^m:fs:([A-Za-z0-9_-]{1,44}):cancel$/);
  if (fs) return subscriptionCancelToast(env, parsed, /** @type {string} */ (fs[1]), nowMs);
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
 * Позначка сесії треду для дій, які запускає ТАП, а не прогін.
 *
 * ⚠️ Навіщо (security-ревʼю релізу). Містки (`m:dep:`, `m:it:`, `m:buy:`)
 * кличуть applyPolicy, а кнопку з таким `callback_data` модель може
 * намалювати сама - простір `m:` для неї відкритий. Жорсткий `tainted:false`
 * робив би з такої кнопки шлях повз білий список taint. FAIL-SAFE той самий,
 * що в router.readThreadTaint: збій - вважаємо забрудненою.
 * @param {Env} env
 * @param {{ threadId?: number | string | null }} parsed
 * @param {number} nowMs
 */
async function threadTainted(env, parsed, nowMs) {
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  try {
    const sess = await readSession(env, threadKey, nowMs);
    return sess.tainted === true;
  } catch (/** @type {any} */ e) {
    console.error('prerouter: taint треду не прочитано - вважаємо забрудненим', e?.message);
    return true;
  }
}

/**
 * Знімок дії з рядка undo - джерело для містків (PR-6). null - рядка немає
 * або він побитий; кнопка тоді чесно каже, що вже пізно.
 * @param {Env} env @param {string} undoId
 */
async function undoSnapshot(env, undoId) {
  if (!env.DB) return null;
  try {
    const row = /** @type {{ payload_json?: string } | null} */ (
      // ⚠️ Лише рядки `undo:` (ревʼю релізу): id у callback приходить від
      // моделі, і без цієї умови місток читав би payload будь-якої пропозиції.
      await env.DB.prepare("SELECT payload_json FROM proposals WHERE id = ? AND kind LIKE 'undo:%'")
        .bind(undoId)
        .first()
    );
    return row ? JSON.parse(String(row.payload_json ?? '{}')) : null;
  } catch (/** @type {any} */ e) {
    console.error('prerouter: знімок дії не прочитано', e?.message);
    return null;
  }
}

/**
 * 2.1 «Коли виходити»: ETA від останньої локації власника до місця події,
 * плюс запас - і нагадування на цей час.
 *
 * ⚠️ Маршрут може не порахуватись (немає свіжої локації, Maps мовчить, місце
 * не розпізнане). Тоді ставимо нагадування за пів години до початку і КАЖЕМО
 * про це: мовчазний фолбек на кругле число виглядав би як порахований ETA.
 * @param {Env} env
 * @param {CallbackParsed} parsed
 * @param {string} undoId @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer
 */
async function departureToast(env, parsed, undoId, nowMs, defer) {
  const snap = await undoSnapshot(env, undoId);
  const startMs = Date.parse(String(snap?.startIso ?? ''));
  const place = String(snap?.location ?? '').trim();
  if (!Number.isFinite(startMs) || !place) return 'Про цю подію я вже не памʼятаю деталей.';
  if (startMs <= nowMs) return 'Подія вже почалась.';
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  await dropTappedButton(env, parsed);
  const work = async () => {
    /** @type {number | null} */
    let etaMin = null;
    try {
      const from = await resolveWaypoint(env, 'here', nowMs);
      const eta = await routesEta(
        env,
        { from, to: { address: place }, mode: 'transit', departAtMs: null },
        nowMs,
      );
      etaMin = eta?.duration_min ?? null;
    } catch (/** @type {any} */ e) {
      console.error('prerouter: ETA до події не порахувався', e?.message);
    }
    const leadMin = etaMin == null ? DEPARTURE_FALLBACK_MIN : etaMin + DEPARTURE_BUFFER_MIN;
    const whenMs = startMs - leadMin * 60_000;
    if (whenMs <= nowMs) {
      await reply(env, target, `Виходити треба вже зараз - дорога ~${leadMin} хв.`, nowMs);
      return;
    }
    const out = await applyPolicy(
      env,
      {
        kind: 'reminders.create',
        // when лишаємо порожнім: точний момент рахує ЯДРО і передає його
        // окремим каналом (internal), а не фразою через парсер.
        payload: { text: `Виходити: ${snap?.title ?? place}` },
        internal: { dueAtMs: whenMs },
        threadId: parsed.threadId ?? null,
        chatId: parsed.chatId ?? null,
        tainted: await threadTainted(env, parsed, nowMs),
      },
      nowMs,
    );
    const how =
      etaMin == null
        ? 'маршрут не порахувався, тож за пів години до початку'
        : `дорога ~${etaMin} хв плюс ${DEPARTURE_BUFFER_MIN} хв запасу`;
    if (out.mode === 'proposed') {
      await reply(
        env,
        target,
        `⏰ Нагадати про вихід о ${kyivClock(whenMs)} (${how})? Потрібне ✅.`,
        nowMs,
        { reply_markup: { inline_keyboard: out.proposal.buttons } },
      );
      return;
    }
    await reply(
      env,
      target,
      `⏰ Нагадаю о ${kyivClock(whenMs)} - ${how}.`,
      nowMs,
      out.mode === 'executed' && out.undo
        ? { reply_markup: { inline_keyboard: out.undo.buttons } }
        : undefined,
    );
  };
  if (defer) {
    defer(() =>
      work().catch((/** @type {any} */ e) =>
        console.error('prerouter: нагадування про вихід впало', e?.message),
      ),
    );
  } else await work();
  return 'Рахую дорогу';
}

/**
 * 2.3 «У задачі»: ідея їде в Google Tasks заголовком. T0 з «↩», як і сама
 * ідея - другого підтвердження на власний список задач не треба.
 * @param {Env} env @param {CallbackParsed} parsed
 * @param {string} undoId @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer
 */
async function ideaTaskToast(env, parsed, undoId, nowMs, defer) {
  const snap = await undoSnapshot(env, undoId);
  const ideaId = String(snap?.id ?? '');
  if (!ideaId) return 'Про цю ідею я вже не памʼятаю деталей.';
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  const idea = await findIdea(env, ideaId).catch((/** @type {any} */ e) => {
    console.error('prerouter: ідея для задачі не прочиталась', e?.message);
    return null;
  });
  if (!idea) return 'Ідеї вже немає.';
  await dropTappedButton(env, parsed);
  // ⚠️ У defer, як решта містків (ревʼю релізу): до відповіді тут інакше
  // встигали б OAuth-токен і POST у Google Tasks, а callback_query Telegram
  // інвалідує за секунди - власник бачив би тап без жодної реакції.
  const work = async () => {
    /** @type {any} */
    const out = await applyPolicy(
      env,
      {
        kind: 'tasks.create',
        payload: { title: idea.title, notes: idea.next_action ?? undefined },
        threadId: parsed.threadId ?? null,
        chatId: parsed.chatId ?? null,
        // ⚠️ Позначка сесії, не false (security-ревʼю релізу): кнопку `m:it:`
        // модель може намалювати сама, і жорстке false робило б із неї шлях
        // повз `tasks.create ∈ TAINT_ESCALATES`.
        tainted: await threadTainted(env, parsed, nowMs),
      },
      nowMs,
    ).catch((/** @type {any} */ e) => ({ mode: 'error', error: String(e?.message ?? '') }));
    // ⚠️ ГІЛКА «proposed» ОБОВʼЯЗКОВА (другий прохід ревʼю). У забрудненій
    // сесії `tasks.create` - T1, і без цієї гілки власник читав дослівно
    // «Задача не створилась: proposed», а сама пропозиція лежала open без
    // кнопок: тап уже зняв натиснуту, а нових ніхто не слав.
    if (out.mode === 'proposed') {
      await reply(
        env,
        target,
        `📋 Поставити задачу «${idea.title}»? Сесія з зовнішнім вмістом - потрібне ✅.`,
        nowMs,
        { reply_markup: { inline_keyboard: out.proposal.buttons } },
      );
      return;
    }
    if (out.mode !== 'executed') {
      await reply(env, target, `⚠️ Задача не створилась: ${out.error ?? out.mode}.`, nowMs);
      return;
    }
    await reply(
      env,
      target,
      `📋 Поставив задачу «${idea.title}».`,
      nowMs,
      out.undo ? { reply_markup: { inline_keyboard: out.undo.buttons } } : undefined,
    );
  };
  if (defer) {
    defer(() =>
      work().catch((/** @type {any} */ e) =>
        console.error('prerouter: задача з ідеї впала', e?.message),
      ),
    );
  } else await work();
  return 'Ставлю задачу';
}

/**
 * 2.5 Кнопки під тижневим звітом: підказка йде в тред тим самим шляхом, що
 * текст власника - модель бачить її як звичайне прохання.
 * @param {Env} env @param {CallbackParsed} parsed
 * @param {'carry' | 'idea'} choice @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer
 */
async function linkFollowupToast(env, parsed, choice, nowMs, defer) {
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  if (target.chatId == null) return 'Невідомий чат.';
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  await clearKeyboard(env, parsed);
  const work = () =>
    startOrQueueThreadText(env, target, threadKey, LINK_FOLLOWUPS[choice], 'chat', nowMs).then(
      () => undefined,
    );
  if (defer) {
    defer(() =>
      work().catch((/** @type {any} */ e) =>
        console.error('prerouter: кнопка звіту впала', e?.message),
      ),
    );
  } else await work();
  return choice === 'carry' ? 'Переношу' : 'Роблю ідею';
}

/**
 * 2.6 «Купив»: бажання закрите, відстеження ціни зупинено, а сама покупка
 * прийде в гроші звичайним шляхом Mono - вигадувати транзакцію ядро не буде.
 * @param {Env} env @param {CallbackParsed} parsed
 * @param {string} wishId @param {number} nowMs
 * @param {((work: () => Promise<void>) => void) | null} defer
 */
async function boughtToast(env, parsed, wishId, nowMs, defer) {
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  await dropTappedButton(env, parsed);
  const work = async () => {
    /** @type {any} */
    const out = await applyPolicy(
      env,
      {
        kind: 'wishes.update',
        payload: { id: wishId, status: 'done' },
        threadId: parsed.threadId ?? null,
        chatId: parsed.chatId ?? null,
        tainted: await threadTainted(env, parsed, nowMs),
      },
      nowMs,
    ).catch((/** @type {any} */ e) => ({ mode: 'error', error: String(e?.message ?? '') }));
    if (out.mode === 'proposed') {
      await reply(env, target, '🎁 Закрити бажання? Потрібне ✅.', nowMs, {
        reply_markup: { inline_keyboard: out.proposal.buttons },
      });
      return;
    }
    if (out.mode !== 'executed') {
      await reply(env, target, '⚠️ Бажання не закрилось - подивись у списку.', nowMs);
      return;
    }
    await reply(
      env,
      target,
      '🎁 Закрив бажання. Покупку побачу в Mono сам - записувати руками не треба.',
      nowMs,
      out.undo ? { reply_markup: { inline_keyboard: out.undo.buttons } } : undefined,
    );
  };
  if (defer) {
    defer(() =>
      work().catch((/** @type {any} */ e) =>
        console.error('prerouter: кнопка «Купив» впала', e?.message),
      ),
    );
  } else await work();
  return 'Вітаю';
}

/**
 * Тап у меню /forget: створити T2-пропозицію і сказати слово. Тред пропозиції
 * - тред кнопки, щоб слово з того ж треду її знайшло.
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {{ collection?: string, chat?: string, all?: boolean }} pick
 * @param {number} nowMs
 */
async function forgetMenuToast(env, parsed, pick, nowMs) {
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  const payload = pick.all
    ? { target: 'all' }
    : pick.chat
      ? { target: 'chat', chat: pick.chat }
      : { target: 'collection', collection: pick.collection };
  const out = await applyPolicy(
    env,
    {
      kind: 'forget',
      payload,
      threadId: threadKey,
      chatId: parsed.chatId ?? null,
      tainted: false,
    },
    nowMs,
  );
  if (out.mode !== 'proposed')
    return `Не вийшло: ${out.mode === 'error' ? out.error : 'без пропозиції'}`;
  await clearKeyboard(env, parsed);
  const what = pick.all
    ? 'УСІ дані власника - факти, ідеї, гроші, чати, плани, памʼять'
    : pick.chat
      ? 'усі збережені повідомлення чату і дайджести про нього'
      : 'колекцію з усіма записами';
  await reply(
    env,
    target,
    `Щоб стерти ${what}, напиши слово: ${out.proposal.word} (діє 10 хв).`,
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
          // ⚠️ Позначка сесії, не false (другий прохід ревʼю). Аналіз по коду -
          // 40-хвилинний прогін Actions, тобто гроші, і від 08.09 він у
          // TAINT_ESCALATES. Простір `m:` відкритий моделі, тож жорстке false
          // робило б із цієї кнопки шлях повз барʼєр.
          tainted: await threadTainted(env, parsed, nowMs),
        },
        nowMs,
      );
      if (out.mode === 'proposed') {
        await reply(env, target, 'Запустити аналіз по коду ще раз? Потрібне ✅.', nowMs, {
          reply_markup: { inline_keyboard: out.proposal.buttons },
        });
        return;
      }
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
 * Надісланий документ (S-2-6, S-2-7). Беремо лише .json: усе інше власник міг
 * прислати просто так, і мовчазний старт розбору був би несподіванкою.
 * Повертає true, якщо апдейт оброблено тут.
 * @param {Env} env @param {ThreadTarget} target
 * @param {{ fileId: string, fileName: string, mimeType: string | null, fileSize: number | null }} doc
 * @param {number} nowMs
 */
async function handleExportDocument(env, target, doc, nowMs) {
  const json = /\.json$/i.test(doc.fileName) || doc.mimeType === 'application/json';
  if (!json) return false;
  if (doc.fileSize != null && doc.fileSize > FILE_MAX_BYTES) {
    await reply(env, target, tooBig(doc.fileSize), nowMs);
    return true;
  }
  try {
    await startInboxExport(
      env,
      {
        fileId: doc.fileId,
        fileName: doc.fileName,
        chatId: target.chatId,
        threadId: target.threadId == null ? THREAD_DM : String(target.threadId),
      },
      nowMs,
    );
  } catch (/** @type {any} */ e) {
    console.error('prerouter: імпорт експорту не стартував', e?.message);
    await reply(env, target, `Не вийшло почати імпорт: ${String(e?.message ?? e)}`, nowMs);
    return true;
  }
  await reply(env, target, 'Читаю експорт - скажу, коли завантажу.', nowMs);
  return true;
}

/**
 * «Скасувати підписку в обліку» (S-4-6): статус `cancelled` через policy - той
 * самий шлях, що з чату, тож і «↩» тут справжня.
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} subscriptionId @param {number} nowMs
 */
async function subscriptionCancelToast(env, parsed, subscriptionId, nowMs) {
  const threadKey = parsed.threadId == null ? THREAD_DM : String(parsed.threadId);
  /** @type {ThreadTarget} */
  const target = { chatId: parsed.chatId ?? null, threadId: parsed.threadId ?? null };
  /** @type {Awaited<ReturnType<typeof applyPolicy>>} */
  let out;
  try {
    out = await applyPolicy(
      env,
      {
        kind: 'subscriptions.update',
        payload: { id: subscriptionId, status: 'cancelled' },
        threadId: threadKey,
        chatId: parsed.chatId ?? null,
        tainted: false,
      },
      nowMs,
    );
  } catch (/** @type {any} */ e) {
    console.error('prerouter: скасування підписки впало', e?.message);
    return 'Не вийшло - спробуй текстом.';
  }
  if (out.mode !== 'executed') {
    return `Не вийшло: ${out.mode === 'error' ? out.error : 'без пропозиції'}`;
  }
  await clearKeyboard(env, parsed);
  const merchant = String(/** @type {any} */ (out.result)?.merchant ?? 'підписку');
  await reply(
    env,
    target,
    `Прибрав ${merchant} з обліку підписок.`,
    nowMs,
    out.undo ? { reply_markup: { inline_keyboard: out.undo.buttons } } : undefined,
  );
  return 'Прибрав з обліку';
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
 * @param {string} txId @param {'price' | 'ok' | 'cat' | 'dupy' | 'trip'} choice @param {number} nowMs
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
    choice === 'price'
      ? `перевір ціни по покупці ${txId}`
      : choice === 'trip'
        ? `ця покупка ${txId} - частина поїздки; спитай про дати й заведи поїздку`
        : `зміни категорію покупки ${txId}`;
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
  return choice === 'price'
    ? 'Шукаю ціни'
    : choice === 'trip'
      ? 'Питаю про поїздку'
      : 'Слухаю категорію';
}

/** Тост під кожну кнопку працівника - щоб власник бачив, що саме прийнято.
 *  @type {Record<string, string>} */
const WORKER_TOASTS = {
  short: 'Скорочую',
  tone: 'Міняю тон',
  next: 'Дивлюсь далі',
  draft: 'Складаю чернетку',
  src: 'Піднімаю джерела',
  week: 'Рахую по тижнях',
  cal: 'Готую подію',
  spend: 'Розкладаю по категоріях',
  more: 'Готую ще питань',
};

/**
 * Кнопки під результатом працівника (S-7-1): набір залежить від САМОГО
 * працівника (worker-results.mjs), бо «Коротше / Інший тон» під тріажем пошти
 * - кнопки не про той зміст (скарга 15 прогону 08.09). Вибір іде підказкою в
 * тред як текст власника (chat-сесія памʼятає задачу й результат), «.md» -
 * файл із бази. Клавіатуру не знімаємо: кнопки можна тиснути кілька разів.
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} id @param {keyof typeof WORKER_FOLLOWUPS | 'md'} choice @param {number} nowMs
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
  return WORKER_TOASTS[choice] ?? 'Беруся';
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

/**
 * Прочитати слово пропозиції з бази й запамʼятати її як «тред чекає слово».
 * Слово живе в `proposals`, і показує його ЯДРО - у відповіді інструмента
 * мозку його немає (security-ревʼю етапу 7: доки модель бачила слово, вона
 * могла підбирати колізію й підміняти пропозицію під написом власника).
 * @param {Env} env
 * @param {{ chatId?: number | null, threadId?: number | string | null }} parsed
 * @param {string} id
 * @returns {Promise<{ word: string, kind: string, payload: unknown } | null>}
 */
async function askT2Word(env, parsed, id) {
  if (!env.DB) return null;
  try {
    const row = /** @type {{ word?: string, kind?: string, payload_json?: string } | null} */ (
      await env.DB.prepare(
        "SELECT word, kind, payload_json FROM proposals WHERE id = ? AND status = 'open'",
      )
        .bind(id)
        .first()
    );
    const word = String(row?.word ?? '');
    if (!word) return null;
    /** @type {unknown} */
    let payload = null;
    try {
      payload = JSON.parse(String(row?.payload_json ?? 'null'));
    } catch {
      // кривий payload - опишемо саму дію без деталей
    }
    return { word, kind: String(row?.kind ?? ''), payload };
  } catch (/** @type {any} */ e) {
    console.error('prerouter: слово T2 не дістали', e?.message);
    return null;
  }
}

/**
 * Зняти інлайн-клавіатуру й лишити на її місці слід вибору.
 *
 * ⚠️ ЧОМУ СЛІД, А НЕ ПРОСТО ЗНЯТТЯ (скарга 14 прогону 08.09: «стан
 * повідомлення має оновитись, а кнопки зникнути»). Голе зняття лишає
 * повідомлення точно таким, яким воно було ДО тапу: власник не бачить, що
 * саме він обрав, і за пів години в історії це нерозрізненно. Текст
 * повідомлення переписати не можна - Telegram віддає його в callback вже без
 * розмітки, і editMessageText зʼїв би жирний і посилання. Тому на місці
 * клавіатури лишається один нетапабельний на ділі рядок-чип із написом тієї
 * кнопки, яку натиснули; його callback (`m:done`) лише каже «вже вирішено».
 *
 * Best-effort: тост і сама дія важливіші за косметику.
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, data?: unknown,
 *   replyMarkup?: unknown }} parsed
 */
async function clearKeyboard(env, parsed) {
  if (parsed.messageId == null || parsed.chatId == null) return;
  const label = tappedButtonLabel(parsed);
  await tgCall(env, 'editMessageReplyMarkup', {
    chat_id: parsed.chatId,
    message_id: parsed.messageId,
    ...(label
      ? { reply_markup: { inline_keyboard: [[{ text: label, callback_data: 'm:done' }]] } }
      : {}),
  }).catch(() => {});
}

/**
 * Прибрати РІВНО натиснуту кнопку, лишивши решту живими.
 *
 * ⚠️ Навіщо окремо від clearKeyboard (ревʼю релізу). Під подією календаря
 * стоять «🚶 Коли виходити» і «↩». Зняття всієї клавіатури після містка
 * забирало б і «↩» - тобто відкотити подію кнопкою вже нема як. Тут зникає
 * лише та кнопка, що вже спрацювала; коли живих не лишилось, кладемо чип із
 * її написом, як і clearKeyboard.
 * @param {Env} env
 * @param {{ chatId?: number | null, messageId?: number | null, data?: unknown,
 *   replyMarkup?: unknown }} parsed
 */
async function dropTappedButton(env, parsed) {
  if (parsed.messageId == null || parsed.chatId == null) return;
  const data = String(parsed.data ?? '');
  const rows = /** @type {any} */ (parsed.replyMarkup)?.inline_keyboard;
  if (!Array.isArray(rows)) return clearKeyboard(env, parsed);
  const label = tappedButtonLabel(parsed);
  // Натиснутої кнопки в розмітці немає (повідомлення вже переписали) - зняти
  // клавіатуру цілком: інакше editMessageReplyMarkup був би no-op, і кнопка
  // лишалась тапабельною (другий прохід ревʼю).
  if (!label) return clearKeyboard(env, parsed);
  // Замість натиснутої - ЧИП із її написом, решта лишається живою: без чипа
  // повідомлення виглядало б точно як до тапу (скарга 14, заради якої сліди
  // й робили).
  const left = rows
    .map((row) =>
      Array.isArray(row)
        ? row.map((b) => (b?.callback_data === data ? { text: label, callback_data: 'm:done' } : b))
        : [],
    )
    .filter((row) => row.length > 0);
  if (left.length === 0) return clearKeyboard(env, parsed);
  await tgCall(env, 'editMessageReplyMarkup', {
    chat_id: parsed.chatId,
    message_id: parsed.messageId,
    reply_markup: { inline_keyboard: left },
  }).catch(() => {});
}

/** Напис натиснутої кнопки з розмітки самого повідомлення - Telegram присилає
 *  її в callback_query. Не знайшли - null: вигадувати підпис не будемо.
 *  @param {{ data?: unknown, replyMarkup?: unknown }} parsed */
function tappedButtonLabel(parsed) {
  const data = String(parsed.data ?? '');
  const rows = /** @type {any} */ (parsed.replyMarkup)?.inline_keyboard;
  if (!data || !Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    for (const btn of row) {
      if (btn?.callback_data !== data) continue;
      const text = String(btn?.text ?? '').trim();
      // Кнопка вже могла бути чипом (подвійний тап) - другого «✅» не ліпимо.
      if (!text) return null;
      return text.startsWith('✅ ') ? text : `✅ ${text}`.slice(0, 64);
    }
  }
  return null;
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
  const result = 'result' in res ? res.result : null;
  const fromResult = res.status === 'approved' ? proposalLabel(res.kind, result).label : '';
  const source = fromResult ? result : payload;
  // Одне емодзі на рядок (персона): у виконаному воно тематичне, у відмові й
  // простроченому - статусне, інакше в рядку опинялись би два підряд.
  if (res.status === 'approved') {
    const icon = actionIcon(res.kind);
    const body = humanAction(res.kind, source, 'done', Boolean(fromResult));
    return icon ? `${icon} ${body}.` : `${body}.`;
  }
  const what = lowerFirst(humanAction(res.kind, source, 'ask'));
  if (res.status === 'rejected') return `❌ Не буду: ${what}.`;
  return `⌛ Час вийшов: ${what} - попроси ще раз, якщо ще актуально.`;
}

/**
 * Впізнаваний ключ дії з payload/result: назва, дата, файл, короткий текст.
 * Спільна основа і для дайджесту МОДЕЛІ (describeProposal), і для рядка
 * ВЛАСНИКУ (humanAction) - щоб одна дія не звалась у двох місцях по-різному.
 * @param {unknown} obj
 * @param {string} kind
 * @returns {{ label: string, guests: string[], link: string | null }}
 */
function proposalLabel(kind, obj) {
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
  // Керівні символи, форматні й роздільники рядка - геть (ними підробляють
  // повідомлення), але ZWJ лишається: без нього «👨‍💻» розпадається на два
  // окремі емодзі просто в назві дії (другий прохід ревʼю).
  const clean = String(label ?? '')
    .replace(SANITIZE_RE, ' ')
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
  // Адреса результату (Drive: webViewLink) - лише http(s) і лише з РЕЗУЛЬТАТУ
  // виконавця: payload пише модель, і «посилання» звідти вело б куди завгодно.
  const raw = typeof o.link === 'string' ? o.link : '';
  const link = /^https:\/\/[\w.-]+\//.test(raw) ? raw : null;
  return { label: clean, guests, link };
}

/**
 * Коротко про дію ДЛЯ МОДЕЛІ: технічний kind + впізнаваний ключ. Саме kind
 * тут і потрібен - дайджест рішень читає модель, і їй треба знати, яку саме
 * дію ядро вже виконало, щоб не повторювати.
 * @param {string} kind @param {unknown} obj
 */
export function describeProposal(kind, obj) {
  const { label, guests } = proposalLabel(kind, obj);
  const tail = guests.length ? ` (гості: ${guests.join(', ')})` : '';
  return label ? `${kind} «${label}»${tail}` : `${kind}${tail}`;
}

/**
 * Те саме ДЛЯ ВЛАСНИКА: людською назвою й з емодзі теми. Технічного kind тут
 * бути не має - скарга власника 08.09: «мені не потрібно бачити внутрішню
 * кухню» («✅ Виконано: collection.export «ТЕСТ-Сервіси»»).
 * @param {string} kind @param {unknown} obj @param {'done' | 'ask'} [mode]
 * @param {boolean} [fromResult] - obj прийшов із РЕЗУЛЬТАТУ виконавця, не з payload
 */
export function humanAction(kind, obj, mode = 'done', fromResult = false) {
  const { label, guests, link: raw } = proposalLabel(kind, obj);
  // ⚠️ Посилання - ЛИШЕ з результату виконавця (security-ревʼю релізу).
  // Доти `proposalLabel` брав `link` із будь-чого, а `decisionText` для ❌/⌛
  // передавав туди PAYLOAD моделі - і ядро своїм голосом ставило клікабельне
  // посилання, яке склала модель.
  const link = fromResult ? raw : null;
  const tail = guests.length ? ` (гості: ${guests.join(', ')})` : '';
  // Посилання - у тексті, не голим URL і не назвою файла (скарги 5 і 16
  // прогону 08.09). Дужки в назві екрануємо: інакше «]» закрив би підпис
  // раніше часу й адреса поїхала б у видимий текст.
  const shown = link ? `[${label.replace(/[[\]]/g, ' ')}](${link})` : label;
  return `${actionPhrase(kind, shown, mode)}${tail}`;
}

/** З малої: фраза словника стоїть після двокрапки, а не на початку речення.
 *  @param {string} s */
function lowerFirst(s) {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
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

/** Розібраний callback: те, що дає parseUpdate для тапу по кнопці.
 *  @typedef {{ chatId?: number | null, messageId?: number | null,
 *    threadId?: number | string | null, data?: unknown, replyMarkup?: unknown }} CallbackParsed */

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

/**
 * /status: чи все живе - одним повідомленням.
 *
 * ⚠️ Сюди ж переїхала діагностика /whereami (реліз 08.09): окрема команда
 * заради двох чисел, які потрібні раз на рік, не варта рядка в меню.
 * @param {Env} env
 * @param {{ chatId?: number | null, threadId?: number | string | null }} [where]
 */
async function systemStatusLine(env, where = {}) {
  const threads = await registryThreadsSnapshot(env);
  const active = Object.values(threads).filter((t) => t.activeRunId != null).length;
  const queued = Object.values(threads).reduce((n, t) => n + t.queue.length, 0);
  const expected = await readExpected(env);
  const instructions = await instructionsStatusLine(env);
  const brainOk = Boolean(expected?.gitSha);
  const alive = brainOk && !instructions.includes('НЕМАЄ') && env.ASSISTANT_V2 === 'on';
  const lines = [
    alive ? '✅ Усе живе.' : '⚠️ Щось не так - подробиці нижче.',
    active || queued ? `Зараз роблю: ${active}, чекає: ${queued}` : 'Черга порожня.',
    instructions,
    `Мозок: ${brainOk ? String(expected?.gitSha).slice(0, 8) : 'не відповідає'} · режим ${env.ASSISTANT_V2}`,
  ];
  if (where.chatId != null) {
    lines.push(`Чат: ${where.chatId}${where.threadId != null ? ` · тема ${where.threadId}` : ''}`);
  }
  return lines.join(String.fromCharCode(10));
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
 *  extra - додаткові поля payload (reply_markup кнопок v:, ADR-040);
 *  md - текст із розміткою ядра (посилання, жирний).
 *  @param {Env} env @param {ThreadTarget} parsed @param {string} text
 *  @param {number} nowMs @param {Record<string, unknown>} [extra] */
async function reply(env, parsed, text, nowMs, extra = undefined, md = false) {
  if (parsed.chatId == null) return;
  // md=true - рядок склало ЯДРО і в ньому є розмітка (посилання, жирний).
  // За замовчуванням false: більшість службових рядків - голий текст, і
  // проганяти їх через конвертер означало б ловити випадкові «_» і «*».
  const parts = md ? renderMdParts(text) : undefined;
  await enqueueOutbox(
    env,
    {
      chatId: parsed.chatId,
      threadId: parsed.threadId == null ? null : parsed.threadId,
      kind: 'send',
      payload: { text, ...(extra ?? {}) },
      ...(parts ? { parts } : {}),
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
