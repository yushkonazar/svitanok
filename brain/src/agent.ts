// Цикл прогону (01 §3.1 кроки 5-6): системний промпт → рушій (SDK за
// інʼєкцією RunEngine - тести ганяють мок, бойову реалізацію дає
// sdk/engine.ts) → інструменти через ядро → стрімінг у статус → deliver.
//
// Барʼєр мозку тут один - стеля викликів інструментів профілю. Рівень
// підтвердження в tainted-сесії визначає ЯДРО: 01 §4.2 каже «навіть якщо хук
// обійдено, policy… не виконує T0-запис без пропозиції», а 01 §4.3 відносить
// «усе T0 у tainted-сесії» до T1 (одне ✅/❌). Мозок прямого запису не має
// взагалі - усе йде через /internal/tool, - тож власна заборона тут нічого не
// додавала до безпеки, зате робила недосяжною саму пропозицію: власник діставав
// «не можу записати» замість кнопки підтвердження (приймання етапу 2, 30.08).

import type { CoreClient, ToolCallOutcome } from './core-client.js';
import type { RunRequest } from './server.js';
import { PROFILES, TRANSCRIPT_MAX_CHARS, buildSystemPrompt, type RunProfile } from './profiles.js';
import { verifyInstruction } from './instructions.js';
import { TOOL_BY_MCP_NAME } from './tools/schemas.js';
import { QUICK_WORKER, runWorker, type WorkerEffort } from './workers.js';

/** Виконання інструмента з погляду рушія: текст для моделі + прапор помилки. */
export interface ToolExecution {
  text: string;
  isError: boolean;
}

export interface EngineRunOptions {
  systemPrompt: string;
  model: string;
  maxTurns: number;
  toolNames: string[];
  /** Рівень зусиль моделі; не задано - дефолт SDK ('high'). */
  effort?: WorkerEffort;
  /** Сесія SDK для resume (профіль chat); null - свіжа сесія. */
  resumeSessionId: string | null;
  /** Чи потрібні часткові тексти (є куди стрімити статус). */
  streamPartials: boolean;
  abortSignal: AbortSignal;
  onToolCall: (mcpName: string, args: unknown) => Promise<ToolExecution>;
  onPartialText: (text: string) => void;
}

export interface EngineOutcome {
  /** Фінальний текст результату; null - рушій завершився без result. */
  finalText: string | null;
  /** Ідентифікатор sdk-сесії прогону (для resume наступного) - null, якщо
   *  рушій його не побачив. */
  sessionId: string | null;
}

/** Рушій прогону: бойовий - Agent SDK (sdk/engine.ts), у тестах - мок. */
export interface RunEngine {
  run: (opts: EngineRunOptions, inputText: string) => Promise<EngineOutcome>;
  /** Транскрипт сесії з локального сховища SDK (для згортки); null - нема. */
  readTranscript: (sessionId: string) => Promise<string | null>;
}

export interface RunnerDeps {
  client: Pick<CoreClient, 'callTool' | 'deliver' | 'status' | 'reportRuns' | 'session'>;
  engine: RunEngine;
  now?: () => number;
  /** Мін. інтервал оновлень статусу; ядро й так троттлить (07 §3). */
  statusIntervalMs?: number;
  /** Реєстр активних прогонів для POST /abort (ADR-039): runId → controller.
   *  Заповнює runner, читає обробник /abort у server/index. */
  aborts?: Map<string, AbortController>;
}

// Стелі deliver/status - тіньові копії ядрових меж, парність тримає тест
// «парність стель» у tests/brain-tool-parity.test.ts:
//  - символи: DELIVER_SCHEMA text ≤ 65 536, STATUS_SCHEMA text ≤ 4 096;
//  - байти: кап сирого тіла /internal/* = 128 KiB ДО підпису (router.mjs) -
//    тому deliver ріжеться і по байтах UTF-8, із запасом на JSON-обгортку
//    та екранування.
export const DELIVER_MAX_CHARS = 65_000;
export const DELIVER_MAX_BYTES = 100_000;
export const STATUS_MAX_CHARS = 3_900;
/** Доки часткова відповідь коротша за це, у чернетку її не шлемо: на прийманні
 *  30.08 власник бачив, як «▸ Думаю…» на мить ставало «В», «П» або «Не про» -
 *  це мигання, а не прогрес. Коротка відповідь тепер просто заміняє чернетку
 *  цілою. */
export const STATUS_MIN_CHARS = 60;

const ESCALATE_PREFIX = 'ESCALATE:';

interface Step {
  n: number;
  at: string;
  kind: 'tool' | 'reply' | 'error';
  name: string;
  ms: number;
  ok: boolean;
  note?: string;
  /** Лише крок escalate (ADR-039): статусник для «Думаю довше…» ядра. */
  status_message_id?: number;
}

/** Збудувати Runner для server.ts: один виклик = один прогін профілю. */
export function makeRunner(deps: RunnerDeps): (req: RunRequest) => Promise<void> {
  const now = deps.now ?? Date.now;
  const statusIntervalMs = deps.statusIntervalMs ?? 1000;

  return async function run(req: RunRequest): Promise<void> {
    const profile: RunProfile = PROFILES[req.profile];
    const startedMs = now();
    const steps: Step[] = [];
    let toolCalls = 0;
    // Що прогін лишив власникові на тап: пропозиція чекає ✅, виконаний T0 -
    // вікно «↩». Кнопки будує мозок, бо лише він знає, ЩО сталось у прогоні;
    // ядро валідує префікси (07 §9).
    let proposalId: string | null = null;
    let undoId: string | null = null;
    let lastStatusMs = 0;
    let escalateOutcome: { escalate: { text: string; status_message_id?: number } } | undefined;

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort('timeout'), profile.timeoutMs);
    deps.aborts?.set(req.run_id, abort);

    const pushStep = (s: Omit<Step, 'n' | 'at'>) =>
      steps.push({ n: steps.length + 1, at: new Date(now()).toISOString(), ...s });

    const onToolCall = async (mcpName: string, args: unknown): Promise<ToolExecution> => {
      const t0 = now();
      const def = TOOL_BY_MCP_NAME.get(mcpName);
      const fail = (text: string, note: string): ToolExecution => {
        pushStep({ kind: 'tool', name: mcpName, ms: now() - t0, ok: false, note });
        return { text, isError: true };
      };
      // Неописаний інструмент - відмова (01 §2.2), хай навіть рушій його знає.
      if (!def) return fail(`Інструмент ${mcpName} не описаний.`, 'unknown-tool');
      if (!profile.toolNames.includes(mcpName)) {
        return fail(
          `Інструмент ${mcpName} недоступний у профілі ${profile.name}.`,
          'not-in-profile',
        );
      }
      toolCalls += 1;
      if (toolCalls > profile.maxToolCalls) {
        // Стеля профілю (07 §4): далі інструментів не буде. Хід не рвемо -
        // моделі лишається шанс відповісти з наявного; страхує таймаут профілю.
        return fail(
          `Стеля інструментів профілю (${profile.maxToolCalls}) вичерпана - сформулюй відповідь із того, що вже є.`,
          'tool-cap',
        );
      }
      // Внутрішні інструменти (07 §4 «(внутр.)») в ядро не йдуть - їх виконує
      // сам мозок. Єдиний такий зараз - delegate: файли працівників приїдуть
      // на етапі 4, тож поки чесна відмова з іменем працівника в нотатці
      // кроку - run_steps покажуть, кого модель кличе насправді, і етап 4
      // почнеться з фактів, а не з припущень.
      if (def.internal) {
        const parsed = def.args.safeParse(args);
        if (!parsed.success) return fail(`Аргументи ${mcpName} не за контрактом.`, 'bad-args');
        const worker = String(parsed.data.worker ?? '');
        return fail(
          `Працівника «${worker}» ще не підключено. Зроби цю задачу сам у цій самій відповіді або скажи власнику прямо, що вона поки не автоматизована; delegate більше не викликай.`,
          `worker-unavailable:${worker}`,
        );
      }
      const outcome: ToolCallOutcome = await deps.client.callTool(req.run_id, def.coreName, args);
      if (!outcome.ok) {
        return fail(`Інструмент ${def.coreName} відмовив: ${outcome.error}.`, outcome.error);
      }
      // Ескалація policy ядра: mode='proposed' означає, що запис НЕ виконано -
      // створено пропозицію під ✅ власника. Без цієї гілки модель бачила б
      // "null" з isError:false і брехала власнику «Записав» (знахідка ревʼю).
      if (outcome.mode === 'proposed') {
        proposalId = callbackId(outcome.proposal) ?? proposalId;
        pushStep({ kind: 'tool', name: def.coreName, ms: now() - t0, ok: true, note: 'proposed' });
        return {
          text: `Запис НЕ виконано: створено пропозицію, що чекає підтвердження власника (✅). Деталі: ${JSON.stringify(outcome.proposal ?? null)}. Скажи власнику, що потрібне підтвердження.`,
          isError: false,
        };
      }
      if (outcome.undo) undoId = callbackId(outcome.undo) ?? undoId;
      pushStep({
        kind: 'tool',
        name: def.coreName,
        ms: now() - t0,
        ok: true,
        ...(searchNote(def.coreName, args) ? { note: searchNote(def.coreName, args) } : {}),
      });
      const text =
        typeof outcome.result === 'string'
          ? outcome.result
          : JSON.stringify(outcome.result ?? null);
      return { text, isError: false };
    };

    const onPartialText = (text: string): void => {
      if (req.status_message_id == null) return;
      if (text.length < STATUS_MIN_CHARS) return;
      const t = now();
      if (t - lastStatusMs < statusIntervalMs) return;
      lastStatusMs = t;
      // Хвіст, не голова: інформативний саме поточний шматок роботи, а голова
      // після 3 900 символів замерзала б у байт-у-байт однакові edit-и.
      void deps.client.status(req.run_id, req.status_message_id, clipStatusTail(text));
    };

    try {
      // Інструкція профілю (PR-5): текст із D1 ядра, хеш перерахований тут.
      // Розбіжність або відсутність - прогін не стартує: замовчувати це
      // означало б відповідати власнику від імені невідомо якої персони.
      let instructionBody: string | null = null;
      if (profile.name !== 'summarize') {
        try {
          instructionBody = verifyInstruction(
            req.instruction,
            profile.name,
            profile.name === 'chat' ? 'persona' : 'quick',
          );
        } catch (e) {
          const note = e instanceof Error ? e.message : String(e);
          pushStep({ kind: 'error', name: 'instruction', ms: now() - startedMs, ok: false, note });
          console.error(`run ${req.run_id}: ${note}`);
          // Тиша тут читалась би як «асистент завис»; deliver - best-effort.
          try {
            await deps.client.deliver(
              req.run_id,
              'Інструкції асистента не на місці - синк не відпрацював.',
            );
          } catch (deliverErr) {
            console.error(`run ${req.run_id}: deliver про інструкцію впав: ${String(deliverErr)}`);
          }
          return;
        }
      }

      // Summarize: вхід - НЕ текст запиту, а транскрипт сесії з локального
      // сховища SDK (ADR-038: без resume - службовий хід не бруднить сесію).
      let inputText = req.input.text;
      if (profile.name === 'summarize') {
        const sid = req.session?.sdk_session_id;
        if (!sid) {
          pushStep({ kind: 'error', name: 'summarize', ms: 0, ok: false, note: 'no-session' });
          console.error(`run ${req.run_id}: summarize без sdk_session_id`);
          return;
        }
        const transcript = await deps.engine.readTranscript(sid);
        if (!transcript) {
          pushStep({
            kind: 'error',
            name: 'summarize',
            ms: now() - startedMs,
            ok: false,
            note: 'transcript-unavailable',
          });
          console.error(`run ${req.run_id}: транскрипт сесії недоступний`);
          return;
        }
        // Хвіст: свіжі повідомлення важливіші за початок довгої сесії.
        inputText = clipTail(transcript, TRANSCRIPT_MAX_CHARS);
      }

      const systemPrompt = buildSystemPrompt(profile, startedMs, {
        summary: profile.name === 'chat' ? (req.session?.summary_md ?? null) : null,
        instruction: instructionBody,
      });
      // Швидка смуга - це працівник quick (07 §5), і йде вона ТИМ САМИМ
      // шляхом, яким на етапі 4 підуть решта десять: свіжа сесія, модель і
      // стеля ходів із front-matter файлу. Так шлях працівника перевіряється
      // в проді щодня, а не вперше на етапі 4.
      // Спільне для обох гілок: канал інструментів, статусу і скасування.
      const runCtx = {
        abortSignal: abort.signal,
        onToolCall,
        onPartialText,
        streamPartials: req.status_message_id != null,
      };
      const outcome =
        profile.name === 'quick'
          ? await runWorker(
              deps.engine,
              { ...QUICK_WORKER, prompt: systemPrompt },
              inputText,
              runCtx,
            )
          : await deps.engine.run(
              {
                systemPrompt,
                model: profile.model,
                maxTurns: profile.maxTurns,
                toolNames: profile.toolNames,
                ...(profile.effort ? { effort: profile.effort } : {}),
                resumeSessionId:
                  profile.name === 'chat' ? (req.session?.sdk_session_id ?? null) : null,
                ...runCtx,
              },
              inputText,
            );

      const finalText = (outcome.finalText ?? '').trim();

      if (profile.name === 'summarize') {
        // Вихід - у sessions.summary_md, НЕ власнику. Втрачена згортка не сміє
        // виглядати зробленою: невдача каналу = error-крок у телеметрії.
        if (finalText === '') {
          pushStep({
            kind: 'error',
            name: 'summarize',
            ms: now() - startedMs,
            ok: false,
            note: 'empty-summary',
          });
          return;
        }
        const saved = await deps.client.session(req.run_id, {
          thread_id: req.thread_id,
          // Кап схеми ядра 20 000; модель просили ≤1500, зріз - страховка.
          summary_md: clipHead(finalText, 19_000),
        });
        pushStep({
          kind: 'reply',
          name: 'summary',
          ms: now() - startedMs,
          ok: saved,
          ...(saved ? {} : { note: 'session-endpoint-failed' }),
        });
        return;
      }

      // Огорожа ```/лапки навколо службового рядка (ревʼю PR-5): quick.md
      // показує формат у код-блоці, і модель іноді відтворює саме його -
      // строгий startsWith тоді пропускав би «ESCALATE: …» власнику як
      // відповідь замість перезапуску chat.
      const escalateProbe = finalText.replace(/^[`'"\s]+/, '');
      if (profile.name === 'quick' && escalateProbe.startsWith(ESCALATE_PREFIX)) {
        // Канал ескалації (ADR-039, уточнено ревʼю PR-3): рішення їде
        // КОНТРАКТНИМ outcome у /internal/runs (ядро перезапустить chat тим
        // самим текстом у той самий статусник), а крок - лише журнальний слід
        // у run_steps. Мозок службовий рядок власнику НЕ доставляє.
        escalateOutcome = {
          escalate: {
            text: req.input.text,
            ...(req.status_message_id != null ? { status_message_id: req.status_message_id } : {}),
          },
        };
        pushStep({
          kind: 'reply',
          name: 'escalate',
          ms: now() - startedMs,
          ok: true,
          note: req.input.text,
          ...(req.status_message_id != null ? { status_message_id: req.status_message_id } : {}),
        });
        return;
      }
      const delivered = finalText === '' ? '(порожня відповідь моделі)' : clipDeliver(finalText);
      const buttons = confirmButtons(proposalId, undoId);
      // Третій аргумент лише коли є що показати: deliver без кнопок лишається
      // тим самим викликом, що й був.
      if (buttons.length > 0) await deps.client.deliver(req.run_id, delivered, buttons);
      else await deps.client.deliver(req.run_id, delivered);
      pushStep({ kind: 'reply', name: 'deliver', ms: now() - startedMs, ok: finalText !== '' });

      // Сесія для наступного resume (chat): best-effort - невдача означає лише
      // свіжу сесію наступного разу, і про це скаже warn клієнта.
      if (profile.name === 'chat' && outcome.sessionId) {
        await deps.client.session(req.run_id, {
          thread_id: req.thread_id,
          sdk_session_id: outcome.sessionId,
          turns_inc: 1,
        });
      }
    } catch (err) {
      // «стоп» власника (POST /abort, reason='stop') - НЕ збій: тишу розриває
      // ядро («Зупинив.»), а деліверити обірвану відповідь було б шумом.
      if (abort.signal.aborted && abort.signal.reason === 'stop') {
        pushStep({ kind: 'reply', name: 'stopped', ms: now() - startedMs, ok: true });
        return;
      }
      const reason = abort.signal.aborted ? 'таймаут профілю' : shortError(err);
      pushStep({
        kind: 'error',
        name: profile.name,
        ms: now() - startedMs,
        ok: false,
        note: reason,
      });
      console.error(`run ${req.run_id} (${profile.name}): ${reason}`);
      // Помилка видима (00-README п.6): власник має побачити збій, не тишу.
      try {
        await deps.client.deliver(req.run_id, `Прогін не вдався: ${reason}.`);
      } catch (deliverErr) {
        console.error(`run ${req.run_id}: deliver збою теж упав: ${String(deliverErr)}`);
      }
    } finally {
      clearTimeout(timeout);
      deps.aborts?.delete(req.run_id);
      await deps.client.reportRuns(req.run_id, steps, escalateOutcome);
    }
  };
}

/**
 * Зріз голови під ОБИДВІ стелі - символи (контракт DELIVER_SCHEMA) і байти
 * UTF-8 (кап тіла ядра). Ітерація код-поїнтами не полишає самотніх сурогатів
 * (ядровий splitMessage від цього захищений - тут той самий інваріант шаром
 * вище, бо ядро валідує вже обрізаний текст).
 */
export function clipDeliver(text: string): string {
  let bytes = 0;
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const b = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (i + ch.length > DELIVER_MAX_CHARS || bytes + b > DELIVER_MAX_BYTES) {
      return `${text.slice(0, i)}…`;
    }
    bytes += b;
    i += ch.length;
  }
  return text;
}

/** Хвіст тексту ≤ max символів із префіксом «…»; межа не лишає самотнього
 *  низького сурогата (той самий інваріант, що clipDeliver, але з кінця). */
export function clipTail(text: string, max: number): string {
  if (text.length <= max) return text;
  let start = text.length - max;
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return `…${text.slice(start)}`;
}

/** Голова тексту ≤ max символів із суфіксом «…»; межа не розрубує сурогатну
 *  пару (для summary_md у D1 - той самий клас, що clipDeliver у Telegram). */
export function clipHead(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
}

export function clipStatusTail(text: string): string {
  return clipTail(text, STATUS_MAX_CHARS);
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/** Id для callback-даних 07 §9: рівно те, що приймає parsePolicyCallback ядра.
 *  Чужий формат - кнопки не буде: мертва кнопка гірша за її відсутність. */
export function callbackId(source: unknown): string | null {
  const id = (source as { id?: unknown } | null)?.id;
  return typeof id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(id) ? id : null;
}

/**
 * Кнопки під відповіддю (07 §9): ✅/❌ для пропозиції, що чекає рішення, і
 * «↩» для щойно виконаного T0. Без них пропозиція лишалась у базі, а власник
 * бачив лише текст «потрібне підтвердження» і не мав, що натиснути
 * (приймання етапу 2, 01.09).
 */
export function confirmButtons(
  proposalId: string | null,
  undoId: string | null,
): Array<Array<{ text: string; callback_data: string }>> {
  const rows: Array<Array<{ text: string; callback_data: string }>> = [];
  if (proposalId) {
    rows.push([
      { text: '✅ Так', callback_data: `p:${proposalId}:ok` },
      { text: '❌ Ні', callback_data: `p:${proposalId}:no` },
    ]);
  }
  if (undoId) rows.push([{ text: '↩ Скасувати', callback_data: `u:${undoId}` }]);
  return rows;
}

/** Запит пошукового інструмента - у нотатку кроку. Без цього неможливо
 *  зʼясувати, ЧОМУ пошук нічого не знайшов: у телеметрії лишалось саме імʼя
 *  інструмента (діагностика пошти 01.09). Лише пошукові - у решти в
 *  аргументах особисті дані. */
export function searchNote(coreName: string, args: unknown): string {
  if (!['mail.search', 'drive.search', 'memory.search'].includes(coreName)) return '';
  const q = (args as { q?: unknown } | null)?.q;
  return typeof q === 'string' ? `q=${q.slice(0, 80)}` : 'q=(немає)';
}
