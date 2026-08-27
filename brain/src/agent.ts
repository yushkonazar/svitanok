// Цикл прогону (01 §3.1 кроки 5-6): системний промпт → рушій (SDK за
// інʼєкцією RunEngine - тести ганяють мок, бойову реалізацію дає
// sdk/engine.ts) → інструменти через ядро → стрімінг у статус → deliver.
//
// Тут же барʼєри мозку (01 §4.2, перша половина подвійного барʼєра; другу
// тримає policy ядра): стеля викликів інструментів профілю, блок
// write-інструментів у tainted-сесії, taint від відповіді ядра.

import type { CoreClient, ToolCallOutcome } from './core-client.js';
import type { RunRequest } from './server.js';
import { PROFILES, TRANSCRIPT_MAX_CHARS, buildSystemPrompt, type RunProfile } from './profiles.js';
import { TOOL_BY_MCP_NAME } from './tools/schemas.js';

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

const ESCALATE_PREFIX = 'ESCALATE:';

interface Step {
  n: number;
  at: string;
  kind: 'tool' | 'reply' | 'error';
  name: string;
  ms: number;
  ok: boolean;
  note?: string;
}

/** Збудувати Runner для server.ts: один виклик = один прогін профілю. */
export function makeRunner(deps: RunnerDeps): (req: RunRequest) => Promise<void> {
  const now = deps.now ?? Date.now;
  const statusIntervalMs = deps.statusIntervalMs ?? 1000;

  return async function run(req: RunRequest): Promise<void> {
    const profile: RunProfile = PROFILES[req.profile];
    const startedMs = now();
    const steps: Step[] = [];
    let tainted = req.tainted ?? false;
    let toolCalls = 0;
    let lastStatusMs = 0;

    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort('timeout'), profile.timeoutMs);

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
      if (tainted && def.write) {
        // Перша половина подвійного барʼєра: у tainted-сесії прямий запис
        // заборонено ще ДО ядра; policy ядра - друга половина.
        return fail(
          'Сесія містить зовнішній вміст: прямий запис заборонено. Поясни власнику, що потрібне підтвердження.',
          'taint-blocked',
        );
      }
      const outcome: ToolCallOutcome = await deps.client.callTool(req.run_id, def.coreName, args);
      if (!outcome.ok) {
        return fail(`Інструмент ${def.coreName} відмовив: ${outcome.error}.`, outcome.error);
      }
      tainted = tainted || outcome.tainted;
      // Ескалація policy ядра: mode='proposed' означає, що запис НЕ виконано -
      // створено пропозицію під ✅ власника. Без цієї гілки модель бачила б
      // "null" з isError:false і брехала власнику «Записав» (знахідка ревʼю).
      if (outcome.mode === 'proposed') {
        pushStep({ kind: 'tool', name: def.coreName, ms: now() - t0, ok: true, note: 'proposed' });
        return {
          text: `Запис НЕ виконано: створено пропозицію, що чекає підтвердження власника (✅). Деталі: ${JSON.stringify(outcome.proposal ?? null)}. Скажи власнику, що потрібне підтвердження.`,
          isError: false,
        };
      }
      pushStep({ kind: 'tool', name: def.coreName, ms: now() - t0, ok: true });
      const text =
        typeof outcome.result === 'string'
          ? outcome.result
          : JSON.stringify(outcome.result ?? null);
      return { text, isError: false };
    };

    const onPartialText = (text: string): void => {
      if (req.status_message_id == null) return;
      const t = now();
      if (t - lastStatusMs < statusIntervalMs) return;
      lastStatusMs = t;
      // Хвіст, не голова: інформативний саме поточний шматок роботи, а голова
      // після 3 900 символів замерзала б у байт-у-байт однакові edit-и.
      void deps.client.status(req.run_id, req.status_message_id, clipStatusTail(text));
    };

    try {
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

      const outcome = await deps.engine.run(
        {
          systemPrompt: buildSystemPrompt(profile, startedMs, {
            summary: profile.name === 'chat' ? (req.session?.summary_md ?? null) : null,
          }),
          model: profile.model,
          maxTurns: profile.maxTurns,
          toolNames: profile.toolNames,
          resumeSessionId: profile.name === 'chat' ? (req.session?.sdk_session_id ?? null) : null,
          streamPartials: req.status_message_id != null,
          abortSignal: abort.signal,
          onToolCall,
          onPartialText,
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

      if (profile.name === 'quick' && finalText.startsWith(ESCALATE_PREFIX)) {
        // Ескалацію вирішує ядро (07 §5, prerouter - етап 2 PR-3); мозок лише
        // чесно звітує і НЕ доставляє службовий рядок власнику.
        // ⚠️ Відомий борг (знахідка ревʼю): надійний канал ескалації (не
        // best-effort /internal/runs) - обовʼязковий пункт PR-3.
        pushStep({ kind: 'reply', name: 'escalate', ms: now() - startedMs, ok: true });
        return;
      }
      const delivered = finalText === '' ? '(порожня відповідь моделі)' : clipDeliver(finalText);
      await deps.client.deliver(req.run_id, delivered);
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
      await deps.client.reportRuns(req.run_id, steps);
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
