// Цикл прогону (01 §3.1 кроки 5-6): системний промпт → рушій (SDK за
// інʼєкцією RunEngine - тести ганяють мок, бойову реалізацію дає
// sdk/engine.ts) → інструменти через ядро → стрімінг у статус → deliver.
//
// Тут же барʼєри мозку (01 §4.2, перша половина подвійного барʼєра; другу
// тримає policy ядра): стеля викликів інструментів профілю, блок
// write-інструментів у tainted-сесії, taint від відповіді ядра.

import type { CoreClient, ToolCallOutcome } from './core-client.js';
import type { RunRequest } from './server.js';
import { PROFILES, buildSystemPrompt, type RunProfile } from './profiles.js';
import { TOOL_BY_CORE_NAME, type BrainToolDef } from './tools/schemas.js';

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
  abortSignal: AbortSignal;
  onToolCall: (mcpName: string, args: unknown) => Promise<ToolExecution>;
  onPartialText: (text: string) => void;
}

export interface EngineOutcome {
  /** Фінальний текст результату; null - рушій завершився без result. */
  finalText: string | null;
}

/** Рушій прогону: бойовий - Agent SDK (sdk/engine.ts), у тестах - мок. */
export interface RunEngine {
  run: (opts: EngineRunOptions, inputText: string) => Promise<EngineOutcome>;
}

export interface RunnerDeps {
  client: Pick<CoreClient, 'callTool' | 'deliver' | 'status' | 'reportRuns'>;
  engine: RunEngine;
  now?: () => number;
  /** Мін. інтервал оновлень статусу; ядро й так троттлить (07 §3). */
  statusIntervalMs?: number;
}

const DELIVER_MAX_CHARS = 65_000;
const ESCALATE_PREFIX = 'ESCALATE:';

const MCP_TOOLS: ReadonlyMap<string, BrainToolDef> = new Map(
  [...TOOL_BY_CORE_NAME.values()].map((t) => [t.mcpName, t]),
);

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
      const def = MCP_TOOLS.get(mcpName);
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
      void deps.client.status(req.run_id, req.status_message_id, clip(text, 3900));
    };

    try {
      const outcome = await deps.engine.run(
        {
          systemPrompt: buildSystemPrompt(profile, startedMs),
          model: profile.model,
          maxTurns: profile.maxTurns,
          toolNames: profile.toolNames,
          abortSignal: abort.signal,
          onToolCall,
          onPartialText,
        },
        req.input.text,
      );

      const finalText = (outcome.finalText ?? '').trim();
      if (profile.name === 'quick' && finalText.startsWith(ESCALATE_PREFIX)) {
        // Ескалацію вирішує ядро (07 §5, prerouter - етап 2 PR-3); мозок лише
        // чесно звітує і НЕ доставляє службовий рядок власнику.
        pushStep({ kind: 'reply', name: 'escalate', ms: now() - startedMs, ok: true });
        return;
      }
      const delivered =
        finalText === '' ? '(порожня відповідь моделі)' : clip(finalText, DELIVER_MAX_CHARS);
      await deps.client.deliver(req.run_id, delivered);
      pushStep({ kind: 'reply', name: 'deliver', ms: now() - startedMs, ok: finalText !== '' });
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

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function shortError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}
