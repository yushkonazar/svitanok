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

import type { CoreClient, DeliverWorker, RunOutcome, ToolCallOutcome } from './core-client.js';
import type { RunRequest } from './server.js';
import {
  INSTRUCTION_NAME_BY_PROFILE,
  PROFILES,
  TRANSCRIPT_MAX_CHARS,
  buildSystemPrompt,
  buildWorkerPrompt,
  type RunProfile,
} from './profiles.js';
import { verifyInstruction } from './instructions.js';
import { TOOL_BY_MCP_NAME, type BrainToolDef } from './tools/schemas.js';
import { toolStatusWord } from './tools/status-words.js';
import { routeChatTools } from './tool-routing.js';
import { tripBriefCard } from './trip-card.js';
import {
  DELEGATE_WORKERS,
  QUICK_WORKER,
  WORKERS,
  runWorker,
  workerInput,
  type WorkerEffort,
} from './workers.js';

/** Виконання інструмента з погляду рушія: текст для моделі + прапор помилки. */
export interface ToolExecution {
  text: string;
  isError: boolean;
}

export interface EngineRunOptions {
  systemPrompt: string;
  model: string;
  /** Назва профілю для provider-router-а та безпечного canary. */
  profileName?: string;
  /** Клас OpenAI-моделі; Claude runtime його ігнорує. */
  openAiModelTier?: 'fast' | 'standard' | 'advanced';
  /** Стеля відповіді одного Responses-виклику; не замінює maxTurns. */
  maxOutputTokens?: number;
  /** Стабільний внутрішній ідентифікатор власника; provider хешує його сам. */
  safetyIdentifier: string;
  maxTurns: number;
  toolNames: string[];
  /** Вбудовані інструменти SDK, дозволені цьому прогону (лише працівники:
   *  WebSearch/WebFetch у Дослідника, 01 §2.2); не задано - жодного. */
  builtinTools?: string[];
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
  /** Час у API моделі (duration_api_ms результату SDK); решта ms кроку -
   *  накладні CLI/сесії. Не задано - рушій не звітує. */
  apiMs?: number | null;
  /** Runtime називає себе, але не повертає credentials чи повний API-вивід. */
  provider?: 'claude' | 'openai';
  model?: string | null;
  responseId?: string | null;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  /** Estimated only when the deployment configured its own model prices. */
  estimatedCostUsd?: number | null;
  /** Read-only OpenAI comparison. It never contains generated text, prompts,
   * arguments, or Core results and is present only when the owner enabled an
   * explicitly scoped shadow lane. */
  shadow?: {
    provider: 'openai';
    model?: string | null;
    responseId?: string | null;
    apiMs?: number | null;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
    toolCalls: number;
    error?: string;
  } | null;
}

/** «api 12.3 с» для нотатки кроку; undefined - без нотатки (JSON її відкине). */
export function apiNote(apiMs: number | null | undefined): string | undefined {
  return typeof apiMs === 'number' ? `api ${(apiMs / 1000).toFixed(1)} с` : undefined;
}

/**
 * Рушій зупинився не результатом (стеля ходів, збій виконання): subtype SDK
 * і частковий текст, який модель встигла написати. Для chat це збій прогону,
 * для працівника на стелі ходів - «не вклався - ось що встиг» (S-7-5).
 */
export class EngineStopError extends Error {
  constructor(
    readonly subtype: string,
    readonly partialText: string,
  ) {
    super(`SDK: ${subtype}`);
    this.name = 'EngineStopError';
  }
}

/** Рушій прогону: бойовий - Agent SDK (sdk/engine.ts), у тестах - мок. */
export interface ModelRuntime {
  run: (opts: EngineRunOptions, inputText: string) => Promise<EngineOutcome>;
  /** Транскрипт сесії з локального сховища SDK (для згортки); null - нема. */
  readTranscript: (sessionId: string) => Promise<string | null>;
}

/** Сумісний псевдонім для поступової міграції існуючих Claude-викликів. */
export type RunEngine = ModelRuntime;

export interface RunnerDeps {
  client: Pick<
    CoreClient,
    'callTool' | 'deliver' | 'status' | 'reportRuns' | 'session' | 'instruction' | 'taint'
  >;
  engine: ModelRuntime;
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
/** Текст працівника в deliver (DELIVER_SCHEMA.worker.text ядра, парність тестом);
 *  байти його їдуть у тому ж тілі - deliver-текст ріжеться з резервом на нього. */
export const DELIVER_WORKER_MAX_CHARS = 19_000;
export const STATUS_MAX_CHARS = 3_900;
/** Має збігатися з RUN_REQUEST_SCHEMA.input.text у server.ts. */
const CHAT_INPUT_MAX_CHARS = 30_000;
/** Доки часткова відповідь коротша за це, у чернетку її не шлемо: на прийманні
 *  30.08 власник бачив, як «▸ Думаю…» на мить ставало «В», «П» або «Не про» -
 *  це мигання, а не прогрес. Коротка відповідь тепер просто заміняє чернетку
 *  цілою. */
export const STATUS_MIN_CHARS = 60;
/** І приріст між оновленнями: без цього довга відповідь давала ~40 редагувань
 *  поспіль (по одному на секунду), кожне - ряд у черзі й виклик Telegram.
 *  Абзац за раз читається не гірше, а коштує вчетверо менше. */
export const STATUS_MIN_GROWTH = 200;

const ESCALATE_PREFIX = 'ESCALATE:';

interface Step {
  n: number;
  at: string;
  kind: 'tool' | 'subagent' | 'reply' | 'error' | 'model';
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
    // Результат останнього працівника - у deliver (S-7-1: кнопки «Коротше /
    // Інший тон / .md» будує ядро, бо воно ж тримає текст у базі).
    // Обʼєкт, не let: присвоєння йде з колбека, і TS звузив би let до null.
    const last: { worker: DeliverWorker | null; tripBrief: unknown } = {
      worker: null,
      tripBrief: null,
    };
    let lastStatusMs = 0;
    let statusesClosed = false;
    let statusTail: Promise<void> = Promise.resolve();
    const queueStatus = (text: string): void => {
      if (statusesClosed || req.status_message_id == null) return;
      statusTail = statusTail
        .then(() => deps.client.status(req.run_id, req.status_message_id!, text))
        .catch(() => undefined);
    };
    const finishStatuses = async (): Promise<void> => {
      statusesClosed = true;
      await statusTail;
    };
    let lastStatusLen = 0;
    let escalateOutcome: RunOutcome | undefined;
    // `chat` gets a deterministic minimum surface for this particular turn;
    // service profiles retain their reviewed static allowlists. Core's static
    // profile gate below remains defence in depth for malformed/test engines.

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
      pushToolStatus(def.coreName);
      if (toolCalls > profile.maxToolCalls) {
        // Стеля профілю (07 §4): далі інструментів не буде. Хід не рвемо -
        // моделі лишається шанс відповісти з наявного; страхує таймаут профілю.
        return fail(
          `Стеля інструментів профілю (${profile.maxToolCalls}) вичерпана - сформулюй відповідь із того, що вже є.`,
          'tool-cap',
        );
      }
      // Внутрішні інструменти (07 §4 «(внутр.)») в ядро не йдуть - їх виконує
      // сам мозок. Єдиний такий - delegate (етап 4): працівник = окремий прогін
      // SDK зі своєю інструкцією з D1 (через ядро, з хешем), моделлю, стелею
      // й інструментами з реєстру; назад - лише текст.
      if (def.internal) {
        const parsed = def.args.safeParse(args);
        if (!parsed.success) return fail(`Аргументи ${mcpName} не за контрактом.`, 'bad-args');
        const out = await delegate(
          String(parsed.data.worker ?? ''),
          String(parsed.data.task ?? ''),
          String(parsed.data.format ?? ''),
          t0,
        );
        if (out.worker) last.worker = out.worker;
        return { text: out.text, isError: out.isError };
      }
      const r = await callCore(def, args, { okName: def.coreName, failName: mcpName, t0 });
      if (r.proposalId) proposalId = r.proposalId;
      if (r.undoId) undoId = r.undoId;
      if (def.coreName === 'trip.brief' && !r.isError && !r.proposalId) {
        try {
          last.tripBrief = JSON.parse(r.text);
        } catch {
          last.tripBrief = null;
        }
      }
      return { text: r.text, isError: r.isError };
    };

    /**
     * Спільний хвіст виклику інструмента ядра (профіль і працівник): крок у
     * телеметрії, відмова, ескалація policy (mode='proposed' - запис НЕ
     * виконано, створено пропозицію під ✅; без цієї гілки модель бачила б
     * "null" і брехала «Записав»), текст результату. Кнопки (proposalId/undoId)
     * бере лише профільний виклик.
     */
    const callCore = async (
      def: BrainToolDef,
      args: unknown,
      names: { okName: string; failName: string; t0: number },
    ): Promise<ToolExecution & { proposalId?: string; undoId?: string }> => {
      const outcome: ToolCallOutcome = await deps.client.callTool(req.run_id, def.coreName, args);
      if (!outcome.ok) {
        pushStep({
          kind: 'tool',
          name: names.failName,
          ms: now() - names.t0,
          ok: false,
          note: outcome.error,
        });
        return { text: `Інструмент ${def.coreName} відмовив: ${outcome.error}.`, isError: true };
      }
      if (outcome.mode === 'proposed') {
        pushStep({
          kind: 'tool',
          name: names.okName,
          ms: now() - names.t0,
          ok: true,
          note: 'proposed',
        });
        const proposalId = callbackId(outcome.proposal);
        return {
          text: `Запис НЕ виконано: створено пропозицію, що чекає підтвердження власника (✅). Деталі: ${JSON.stringify(outcome.proposal ?? null)}. Скажи власнику, що потрібне підтвердження.`,
          isError: false,
          ...(proposalId ? { proposalId } : {}),
        };
      }
      pushStep({
        kind: 'tool',
        name: names.okName,
        ms: now() - names.t0,
        ok: true,
        ...(searchNote(def.coreName, args) ? { note: searchNote(def.coreName, args) } : {}),
      });
      const undoId = callbackId(outcome.undo);
      return {
        text:
          typeof outcome.result === 'string'
            ? outcome.result
            : JSON.stringify(outcome.result ?? null),
        isError: false,
        ...(undoId ? { undoId } : {}),
      };
    };

    /**
     * delegate (07 §4, S-7-1…5): інструкція працівника з D1 ядра → свіжий
     * прогін SDK → текст. Інструменти працівника йдуть у ядро тим самим run_id
     * (taint від mail.* тощо ядро ставить само); tainted_output працівника -
     * окремий /internal/taint, fail-closed: без персистованого прапорця
     * результат моделі не видається. Стеля ходів - «не вклався - ось що
     * встиг» із частковим текстом. Усі відмови - текстом моделі + крок.
     */
    // Інструкції працівників у межах прогону (ревʼю PR-3): другий delegate до
    // того самого працівника не ходить у ядро й D1 ще раз; відмову теж
    // памʼятаємо - інакше кожна спроба моделі давала б новий алерт власнику.
    const instructionCache = new Map<string, { body: string } | { error: string; note: string }>();
    const workerInstruction = async (worker: string) => {
      const cached = instructionCache.get(worker);
      if (cached) return cached;
      const ins = await deps.client.instruction(req.run_id, worker);
      let out: { body: string } | { error: string; note: string };
      if (!ins.ok) out = { error: ins.error, note: `worker-instruction:${ins.error.slice(0, 60)}` };
      else {
        try {
          out = { body: verifyInstruction(ins, `worker:${worker}`, worker) };
        } catch (e) {
          out = {
            error: e instanceof Error ? e.message : String(e),
            note: 'worker-instruction:hash',
          };
        }
      }
      instructionCache.set(worker, out);
      return out;
    };

    const delegate = async (
      worker: string,
      task: string,
      format: string,
      t0: number,
    ): Promise<ToolExecution & { worker?: DeliverWorker }> => {
      const stepFail = (text: string, note: string): ToolExecution => {
        pushStep({ kind: 'subagent', name: worker || 'delegate', ms: now() - t0, ok: false, note });
        return { text, isError: true };
      };
      const specDef = DELEGATE_WORKERS.includes(worker) ? WORKERS[worker] : undefined;
      if (!specDef) {
        return stepFail(
          `Невідомий працівник «${worker}». Доступні: ${DELEGATE_WORKERS.join(', ')}.`,
          `worker-unknown:${worker}`,
        );
      }
      if (!task.trim()) return stepFail('delegate: порожня задача.', 'bad-args');
      // Інструкція - з D1 через ядро (S-7-3: немає рядка = «не налаштований»,
      // алерт шле ядро); хеш перераховується тут, як для персони.
      const ins = await workerInstruction(worker);
      if ('error' in ins) {
        return stepFail(
          `Працівник «${worker}» не налаштований (${ins.error}). Зроби задачу сам або скажи власнику прямо.`,
          ins.note,
        );
      }
      const body = ins.body;
      // Інструменти працівника - лише його власні (front-matter) з описаних;
      // стеля - його max_steps, окремо від стелі профілю (07 §5).
      const toolNames = specDef.toolNames.filter((n) => TOOL_BY_MCP_NAME.has(n));
      let workerCalls = 0;
      const workerToolCall = async (name: string, wargs: unknown): Promise<ToolExecution> => {
        const wt0 = now();
        const wdef = TOOL_BY_MCP_NAME.get(name);
        const wfail = (text: string, note: string): ToolExecution => {
          pushStep({ kind: 'tool', name: `${worker}/${name}`, ms: now() - wt0, ok: false, note });
          return { text, isError: true };
        };
        if (!wdef || wdef.internal || !toolNames.includes(name)) {
          return wfail(`Інструмент ${name} недоступний працівнику ${worker}.`, 'not-in-worker');
        }
        workerCalls += 1;
        if (workerCalls > specDef.maxSteps) {
          return wfail(
            `Стеля інструментів працівника (${specDef.maxSteps}) вичерпана - віддай, що є.`,
            'worker-cap',
          );
        }
        const r = await callCore(wdef, wargs, {
          okName: `${worker}/${wdef.coreName}`,
          failName: `${worker}/${name}`,
          t0: wt0,
        });
        return { text: r.text, isError: r.isError };
      };
      let text: string;
      let partial = false;
      let workerApi: string | undefined;
      try {
        const out = await runWorker(
          deps.engine,
          { ...specDef, toolNames, prompt: buildWorkerPrompt(body, now()) },
          workerInput(task, format),
          {
            abortSignal: abort.signal,
            onToolCall: workerToolCall,
            onPartialText: () => {},
            // Partials потрібні не для статусу, а щоб на стелі ходів лишився
            // частковий текст (EngineStopError.partialText).
            streamPartials: true,
            profileName: 'worker',
          },
        );
        text = (out.finalText ?? '').trim();
        workerApi = apiNote(out.apiMs);
        // Each delegated model call has its own latency and usage. Keep only
        // allowlisted provider metadata; never log the task or output.
        if (out.provider === 'openai') {
          pushStep({
            kind: 'model',
            name: `worker:${worker}:openai:${safeTelemetry(out.model, 96) ?? 'unknown'}`,
            ms: out.apiMs ?? now() - t0,
            ok: true,
            note: openAiTelemetryNote(out),
          });
        }
      } catch (e) {
        // Стеля ходів із текстом - частковий результат (S-7-5), решта - збій.
        if (
          e instanceof EngineStopError &&
          e.subtype === 'error_max_turns' &&
          e.partialText.trim()
        ) {
          text = e.partialText.trim();
          partial = true;
        } else {
          const detail = shortError(e);
          return stepFail(
            `${userFacingError(e, abort.signal.reason)}`,
            `worker-failed:${detail.slice(0, 60)}`,
          );
        }
      }
      if (!text)
        return stepFail(`Працівник «${worker}» повернув порожній результат.`, 'worker-empty');
      // tainted_output (01 §4.2): прапорець у ядрі ПЕРЕД видачею тексту моделі;
      // не персистувався - результат не видається (той самий fail-closed, що
      // в ядра для tainting-інструментів).
      let visible = text;
      if (specDef.taintedOutput) {
        if (!(await deps.client.taint(req.run_id, `worker:${worker}`))) {
          return stepFail(
            `Результат працівника «${worker}» не видано: не вдалося позначити сесію (taint). Скажи власнику, що потрібно повторити.`,
            'taint-not-persisted',
          );
        }
        visible = `<external source="worker:${worker}">\n${neutralizeExternalTags(text)}\n</external>`;
      }
      pushStep({
        kind: 'subagent',
        name: worker,
        ms: now() - t0,
        ok: true,
        note: `${partial ? 'partial ' : ''}${text.length} симв., ${workerCalls} інстр.${workerApi ? `, ${workerApi}` : ''}`,
      });
      const cardContext = workerCardContext(worker, task, req.input.text);
      const cardName =
        cardContext === 'price-search' || cardContext === 'place-search' ? cardContext : worker;
      return {
        text: `${partial ? 'Частину результату вже підготовлено' : 'Ось підготовлений результат'}:\n${visible}`,
        isError: false,
        // Під кап DELIVER_SCHEMA.worker.text: довший результат ядро відкинуло б
        // 400 разом з усією відповіддю (ревʼю PR-3).
        // Результат Дослідника з явною задачею про ціну має окремий UI: ядро
        // витягне лише allowlisted сторінки магазинів і додасть кнопки вибору.
        // Це не довіра до назви з вебу, а тип нашого внутрішнього сценарію.
        worker: {
          name: cardName,
          ...(cardContext ? { context: cardContext } : {}),
          text: clipHead(text, DELIVER_WORKER_MAX_CHARS),
        },
      };
    };

    /** Статус «що я зараз роблю» - за інструментом, який модель викликає.
     *  Троттлиться тим самим таймером, що й часткова відповідь: після нього
     *  однаково піде текст, і два edit-и підряд у ту саму секунду - зайві. */
    const pushToolStatus = (coreName: string): void => {
      if (req.status_message_id == null) return;
      const word = toolStatusWord(coreName);
      if (!word) return; // невідомий інструмент - лишаємо попередній статус
      const t = now();
      if (t - lastStatusMs < statusIntervalMs) return;
      lastStatusMs = t;
      // lastStatusLen НЕ чіпаємо: він міряє довжину ЧАСТКОВОЇ ВІДПОВІДІ, і
      // статус інструмента не має скидати її поріг приросту.
      queueStatus(`▸ ${word}…`);
    };

    const onPartialText = (text: string): void => {
      if (req.status_message_id == null) return;
      if (text.length < STATUS_MIN_CHARS) return;
      if (lastStatusLen > 0 && text.length - lastStatusLen < STATUS_MIN_GROWTH) return;
      const t = now();
      if (t - lastStatusMs < statusIntervalMs) return;
      lastStatusMs = t;
      lastStatusLen = text.length;
      // Хвіст, не голова: інформативний саме поточний шматок роботи, а голова
      // після 3 900 символів замерзала б у байт-у-байт однакові edit-и.
      queueStatus(clipStatusTail(text));
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
            INSTRUCTION_NAME_BY_PROFILE[profile.name],
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
        const firstPartyTranscript = req.session?.transcript_md?.trim() ?? '';
        if (!sid && !firstPartyTranscript) {
          pushStep({ kind: 'error', name: 'summarize', ms: 0, ok: false, note: 'no-session' });
          console.error(`run ${req.run_id}: summarize без transcript`);
          return;
        }
        const transcript =
          firstPartyTranscript || (sid ? await deps.engine.readTranscript(sid) : null);
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

      // OpenAI Responses тут навмисно stateless (store:false), отже коротка
      // наступна репліка на кшталт «18:00» сама по собі не каже, на яке
      // уточнення вона відповідає. Core уже веде first-party transcript у D1;
      // додаємо його тільки до chat-входу, залишаючи місце для нової репліки.
      if (profile.name === 'chat' && req.session?.transcript_md?.trim()) {
        inputText = chatInputWithTranscript(req.session.transcript_md, req.input.text);
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
      const safetyIdentifier = req.chat_id
        ? `${req.chat_id}:${req.thread_id === 'dm' ? 'default' : req.thread_id}`
        : `internal:${req.thread_id}`;
      const activeToolNames =
        profile.name === 'chat'
          ? routeChatTools(req.input.text, profile.toolNames, Boolean(req.session?.transcript_md))
          : profile.toolNames;
      const runCtx = {
        abortSignal: abort.signal,
        onToolCall,
        onPartialText,
        streamPartials: req.status_message_id != null,
        profileName: profile.name,
      };
      const outcome =
        profile.name === 'quick'
          ? await runWorker(deps.engine, { ...QUICK_WORKER, prompt: systemPrompt }, inputText, {
              ...runCtx,
              safetyIdentifier,
            })
          : await deps.engine.run(
              {
                systemPrompt,
                model: profile.model,
                openAiModelTier: profile.openAiModelTier,
                maxOutputTokens: profile.maxOutputTokens,
                // Topic ID сам по собі не унікальний між супергрупами, а `dm`
                // спільний для всіх чатів без topics. Router бачить лише цей
                // складений, підписаний Core-ом Telegram target.
                safetyIdentifier,
                maxTurns: profile.maxTurns,
                toolNames: activeToolNames,
                ...(profile.builtinTools?.length
                  ? { builtinTools: [...profile.builtinTools] }
                  : {}),
                ...(profile.effort ? { effort: profile.effort } : {}),
                resumeSessionId:
                  profile.name === 'chat' ? (req.session?.sdk_session_id ?? null) : null,
                ...runCtx,
              },
              inputText,
            );

      await finishStatuses();
      const finalText = (outcome.finalText ?? '').trim();

      // Provider-telemetry is deliberately a tiny allowlist, not an API dump:
      // it lets D1 show response/model/usage/latency while keeping prompts,
      // outputs and function arguments out of operational logs.
      if (outcome.provider === 'openai') {
        pushStep({
          kind: 'model',
          name: `openai:${safeTelemetry(outcome.model, 96) ?? 'unknown'}`,
          ms: outcome.apiMs ?? now() - startedMs,
          ok: true,
          note: openAiTelemetryNote(outcome),
        });
      }
      if (outcome.shadow) {
        pushStep({
          kind: 'model',
          name: `shadow:openai:${safeTelemetry(outcome.shadow.model, 96) ?? 'unknown'}`,
          ms: outcome.shadow.apiMs ?? now() - startedMs,
          ok: !outcome.shadow.error && outcome.shadow.toolCalls === 0,
          note: `${openAiTelemetryNote(outcome.shadow)} shadow_tools=${outcome.shadow.toolCalls}${outcome.shadow.error ? ` error=${safeTelemetry(outcome.shadow.error, 80) ?? 'unknown'}` : ''}`,
        });
      }

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
          // Після успішного запису summary first-party transcript уже не
          // потрібен. Старі Claude SDK sessions не чіпаємо цим прапорцем.
          ...(req.session?.transcript_md ? { clear_transcript: true } : {}),
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

      // Денний працівник (етап 3 PR-8): вихід - подія `worker` у ланцюг через
      // outcome.chain, БЕЗ deliver у чат (ланцюг сам пише власнику). chain_id і
      // mode - з JSON задачі у вході; json-режим - розібраний обʼєкт, chat -
      // текст як є. Кривий вхід або порожній вихід - error-крок, ланцюг
      // дочекається таймауту і піде резервом (formatDraft / наївний розбір).
      // price-check (етап 5 PR-3) - той самий контракт ланцюга: звіт Дослідника
      // текстом (format chat) → подія worker; ціни парсить ядро.
      if (profile.name === 'day-planner' || profile.name === 'price-check') {
        const task = parseTaskInput(req.input.text);
        if (!task) {
          pushStep({
            kind: 'error',
            name: profile.name,
            ms: now() - startedMs,
            ok: false,
            note: 'bad-task',
          });
          return;
        }
        const output = task.format === 'json' ? parseJsonOutput(finalText) : finalText;
        if (output == null || output === '') {
          pushStep({
            kind: 'error',
            name: profile.name,
            ms: now() - startedMs,
            ok: false,
            note: 'empty-output',
          });
          return;
        }
        escalateOutcome = {
          chain: { id: task.chain_id, event: 'worker', payload: { mode: task.mode, output } },
        };
        pushStep({
          kind: 'reply',
          name: 'chain',
          ms: now() - startedMs,
          ok: true,
          note: task.mode,
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
      // Текст працівника їде в тому ж тілі /internal/deliver - deliver-текст
      // ріжеться з резервом на його байти, інакше 128 KiB ядра рвалися б.
      const lastWorker = last.worker;
      const reserve = lastWorker ? Buffer.byteLength(lastWorker.text, 'utf8') + 256 : 0;
      const generated =
        finalText === ''
          ? '(порожня відповідь моделі)'
          : clipDeliver(finalText, DELIVER_MAX_BYTES - reserve);
      const actionButtons = confirmButtons(proposalId, undoId);
      // Для контрольованого питання з варіантами показуємо одну стійку
      // картку з брифу. Вільний текст моделі не може змінити callback_data.
      const tripCard = actionButtons.length === 0 ? tripBriefCard(last.tripBrief) : null;
      const delivered = tripCard?.text ?? generated;
      // Короткі передбачувані уточнення не змушують власника друкувати окреме
      // повідомлення. Не змішуємо їх із діями policy: у пропозиції її власні
      // ✅/❌ завжди важливіші за допоміжні варіанти.
      const buttons = [
        ...actionButtons,
        ...(tripCard?.buttons ?? contextualQuickReplyButtons(delivered, actionButtons.length > 0)),
      ];
      // Додаткові аргументи лише коли є що показати: deliver без кнопок і без
      // працівника лишається тим самим викликом, що й був.
      if (lastWorker && !tripCard)
        await deps.client.deliver(req.run_id, delivered, buttons, lastWorker);
      else if (buttons.length > 0) await deps.client.deliver(req.run_id, delivered, buttons);
      else await deps.client.deliver(req.run_id, delivered);
      pushStep({
        kind: 'reply',
        name: 'deliver',
        ms: now() - startedMs,
        ok: finalText !== '',
        note: apiNote(outcome.apiMs),
      });

      // Сесія для Claude resume та короткий first-party transcript для
      // stateless OpenAI. Transcript містить лише власний input і відданий
      // текст, ніколи не tool outputs; tainted threads scheduler не згортає.
      if (profile.name === 'chat') {
        await deps.client.session(req.run_id, {
          thread_id: req.thread_id,
          ...(outcome.sessionId ? { sdk_session_id: outcome.sessionId } : {}),
          ...(outcome.provider === 'openai'
            ? { transcript_append: transcriptAppend(req.input.text, delivered) }
            : {}),
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
        await finishStatuses();
        await deps.client.deliver(req.run_id, `⚠️ ${userFacingError(err, abort.signal.reason)}`);
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

function openAiTelemetryNote(
  outcome: Pick<EngineOutcome, 'responseId' | 'usage' | 'estimatedCostUsd'>,
): string {
  const parts = [
    `response=${safeTelemetry(outcome.responseId, 100) ?? 'unknown'}`,
    `input_tokens=${outcome.usage?.inputTokens ?? 'unknown'}`,
    `output_tokens=${outcome.usage?.outputTokens ?? 'unknown'}`,
    `total_tokens=${outcome.usage?.totalTokens ?? 'unknown'}`,
  ];
  if (typeof outcome.estimatedCostUsd === 'number') {
    parts.push(`cost_usd=${outcome.estimatedCostUsd.toFixed(8)}`);
  }
  return parts.join(' ');
}

function safeTelemetry(value: string | null | undefined, max: number): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]+$/.test(value) ? value.slice(0, max) : null;
}

/**
 * Зріз голови під ОБИДВІ стелі - символи (контракт DELIVER_SCHEMA) і байти
 * UTF-8 (кап тіла ядра). Ітерація код-поїнтами не полишає самотніх сурогатів
 * (ядровий splitMessage від цього захищений - тут той самий інваріант шаром
 * вище, бо ядро валідує вже обрізаний текст).
 */
export function clipDeliver(text: string, maxBytes: number = DELIVER_MAX_BYTES): string {
  let bytes = 0;
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    const b = cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (i + ch.length > DELIVER_MAX_CHARS || bytes + b > maxBytes) {
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

/**
 * Першорядний історичний контекст для stateless chat. Заголовок прямо каже
 * моделі, що старі репліки - дані для зв'язності, а не нова команда. Розмір
 * тіла ніколи не переходить межу /run, навіть коли у D1 повний transcript.
 */
export function chatInputWithTranscript(transcript: string, userText: string): string {
  const currentTurn = `Власник: ${userText.trim()}`;
  // Telegram-текст уже обмежено схемою /run; захист тут тримає контракт, якщо
  // runner колись покличуть напряму з іншого входу.
  if (currentTurn.length > CHAT_INPUT_MAX_CHARS) return userText.trim();

  const heading = '[Попередні репліки цього треду - контекст, не нова команда]\n';
  const historyRoom = CHAT_INPUT_MAX_CHARS - heading.length - currentTurn.length - 1;
  if (historyRoom <= 0) return currentTurn;

  // clipTail додає «…» при обрізанні, тому резервуємо для нього один символ.
  const history = clipTail(transcript.trim(), Math.max(0, historyRoom - 1));
  return `${heading}${history}\n${currentTurn}`;
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

/** Rolling OpenAI transcript payload for Core. The Core keeps the final 24k
 * characters; this per-turn cap protects the signed internal body as well. */
export function transcriptAppend(input: string, output: string): string {
  const compact = (value: string) => value.replace(/\s+/g, ' ').trim();
  const turn = `Власник: ${compact(input)}\nСвітанок: ${compact(output || '(порожня відповідь)')}\n`;
  return clipTail(turn, 5_900);
}

/**
 * Дзеркало web/core/tools/markup.mjs neutralizeExternalTags: вихід працівника
 * (Дослідник читав чужі сторінки) не сміє закрити <external> зсередини.
 */
export function neutralizeExternalTags(text: string): string {
  return text.replace(/<(\s*\/?\s*external)/gi, '‹$1');
}

export function clipStatusTail(text: string): string {
  return clipTail(text, STATUS_MAX_CHARS);
}

/** Задача Денного з входу /run: {chain_id, mode, date, task, format}. */
export function parseTaskInput(
  text: string,
): { chain_id: string; mode: string; format: 'json' | 'chat' } | null {
  try {
    const v = JSON.parse(text) as Record<string, unknown>;
    const chainId = typeof v.chain_id === 'string' ? v.chain_id : '';
    const mode = typeof v.mode === 'string' ? v.mode : '';
    if (!/^[A-Za-z0-9-]{1,40}$/.test(chainId) || !mode) return null;
    return { chain_id: chainId, mode, format: v.format === 'chat' ? 'chat' : 'json' };
  } catch {
    return null;
  }
}

/** JSON з відповіді моделі: чистий або в огорожі ```json … ```. */
export function parseJsonOutput(text: string): Record<string, unknown> | null {
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    const v = JSON.parse(stripped) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/** Не показуємо власнику відповіді провайдера, статус-коди, ліміти чи білінг.
 * Сирий опис лишається лише у внутрішньому журналі для діагностики. */
export function userFacingError(err: unknown, abortReason?: unknown): string {
  const detail = shortError(err).toLowerCase();
  if (
    /spend_limit_exceeded|usage_limit_exceeded|insufficient_quota|credit_balance_exhausted/u.test(
      detail,
    )
  )
    return 'Досягнуто ліміт витрат або вичерпано кредит OpenAI API. Перевір бюджет і баланс проєкту.';
  if (abortReason === 'timeout' || /timeout|timed out|таймаут/u.test(detail)) {
    return 'Запит затягнувся. Спробуй ще раз трохи пізніше.';
  }
  if (
    /\b(402|429)\b/u.test(detail) ||
    /rate.?limit|too many requests|quota|credits? depleted|prepayment|billing|resource_exhausted/u.test(
      detail,
    )
  ) {
    return 'Сервіс тимчасово обмежив запити. Спробуй трохи пізніше.';
  }
  return 'Не вдалося завершити запит. Спробуй ще раз.';
}

/** Класифікує лише набір кнопок картки; справжнє імʼя працівника лишається
 * незмінним для оцінювання якості й журналу його запусків. */
export function workerCardContext(
  worker: string,
  task: string,
  userRequest = '',
): DeliverWorker['context'] | null {
  const intent = `${task}\n${userRequest}`;
  if (worker === 'researcher' && /(?:ціна|цін[ауиі]|магазин|товар|грн|відстеж)/iu.test(intent))
    return 'price-search';
  if (
    worker === 'researcher' &&
    /(?:ресторан|кафе|заклад|столик|місце\s+на\s+вечерю)/iu.test(intent)
  )
    return 'place-search';
  if (
    ['analyst', 'finance'].includes(worker) &&
    /(?:витрат|витратив|списан|платеж|покупк|бюджет)/iu.test(intent)
  )
    return 'finance-summary';
  if (
    ['planner', 'researcher'].includes(worker) &&
    /(?:поїзд|подорож|мандрів|готел|туризм|подорожув)/iu.test(intent)
  )
    return 'trip-plan';
  return null;
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

/**
 * Кнопки лише для питання, де відповідь має невеликий і безпечний набір
 * очевидних варіантів. Вони не підміняють вільний текст: «Інше» лишає людині
 * можливість написати точну тривалість. Callback `m:q:*` обробляє ядро й
 * кладе відповідь у той самий діалоговий контекст.
 */
export function contextualQuickReplyButtons(
  text: string,
  hasActionButtons = false,
): Array<Array<{ text: string; callback_data: string }>> {
  if (hasActionButtons) return [];
  const normalized = text.toLowerCase().replace(/\s+/g, ' ');
  const asksDuration =
    /(?:на скільки|скільки) часу/.test(normalized) || /(?:яка|вкажи) тривалість/.test(normalized);
  const isCalendarContext = /(?:поді[яї]|зустріч|запрошенн|календар|запланув)/.test(normalized);
  if (asksDuration && isCalendarContext) {
    return [
      [
        { text: '🕐 30 хв', callback_data: 'm:q:30' },
        { text: '🕐 1 год', callback_data: 'm:q:60' },
      ],
      [
        { text: '🕐 1,5 год', callback_data: 'm:q:90' },
        { text: '✏️ Інше', callback_data: 'm:q:custom' },
      ],
    ];
  }
  // A small pair of clock times in a planning question is another case where
  // typing a separate reply adds no information. Keep an "other" path because
  // the owner may choose a time between the two suggestions.
  if (!/(?:робот|план|поді[яї]|зустріч|закінч|почат)/u.test(normalized)) return [];
  const match = normalized.match(
    /(?:^|\s)(?:о|до|з|на)?\s*(\d{1,2})(?::([0-5]\d))?\s*(?:чи|або)\s*(?:о|до|з|на)?\s*(\d{1,2})(?::([0-5]\d))?(?=$|[?.!,\s])/u,
  );
  if (!match) return [];
  const firstHour = Number(match[1]);
  const secondHour = Number(match[3]);
  if (firstHour > 23 || secondHour > 23) return [];
  const first = `${String(firstHour).padStart(2, '0')}${match[2] ?? '00'}`;
  const second = `${String(secondHour).padStart(2, '0')}${match[4] ?? '00'}`;
  if (first === second) return [];
  return [
    [first, second].map((time) => ({
      text: `🕒 ${time.slice(0, 2)}:${time.slice(2)}`,
      callback_data: `m:qh:${time}`,
    })),
    [{ text: '✏️ Інше', callback_data: 'm:qh:custom' }],
  ];
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
