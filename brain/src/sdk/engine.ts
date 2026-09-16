// Бойовий рушій - Claude Agent SDK. ЄДИНЕ місце імпорту SDK: agent.ts і
// кореневі тести бачать лише інтерфейс RunEngine (мок), а типи цього файлу
// перевіряє tsc -p brain своїми node_modules.
//
// Інструменти - in-process MCP-сервер `svitanok` (01 §2.2): кожен tool()
// делегує в opts.onToolCall, де agent.ts тримає стелю, taint-барʼєр і маршрут
// у /internal/tool ядра. Вбудовані інструменти SDK вимкнені (07 §4).

import {
  createSdkMcpServer,
  deleteSession,
  getSessionMessages,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import {
  EngineStopError,
  type EngineOutcome,
  type EngineRunOptions,
  type RunEngine,
} from '../agent.js';
import { BRAIN_TOOLS } from '../tools/schemas.js';

const SDK_BUILTIN_TOOLS_OFF = [
  'Bash',
  'Write',
  'Edit',
  'Read',
  'NotebookEdit',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Task',
  'TodoWrite',
];

/**
 * Фізично прибрати локальні транскрипти SDK. `deleteSession` кидає для
 * відсутнього файла, а повтор T2 мусить бути ідемпотентним, тому «already
 * missing» — успіх. Будь-яка інша помилка залишає D1-посилання неочищеним і
 * змушує ядро повторити всю пачку.
 */
export async function deleteSdkSessions(
  sessionIds: string[],
): Promise<{ deleted: number; alreadyMissing: number }> {
  let deleted = 0;
  let alreadyMissing = 0;
  for (const sessionId of [...new Set(sessionIds)]) {
    try {
      await deleteSession(sessionId);
      deleted += 1;
    } catch (e) {
      if (isMissingSessionError(e)) {
        alreadyMissing += 1;
        continue;
      }
      throw new Error(`SDK session cleanup failed: ${String(e)}`, { cause: e });
    }
  }
  return { deleted, alreadyMissing };
}

/** SDK не експортує власний клас помилки: стабільний для file-store текст. */
function isMissingSessionError(e: unknown) {
  const text = String(e instanceof Error ? e.message : e).toLowerCase();
  return /not found|enoent|no such file|does not exist/.test(text);
}

export function createSdkEngine(): RunEngine {
  return {
    async run(opts: EngineRunOptions, inputText: string): Promise<EngineOutcome> {
      const active = BRAIN_TOOLS.filter((t) => opts.toolNames.includes(t.mcpName));
      // Вбудовані інструменти SDK - лише ті, що явно дозволені цьому прогону
      // (Дослідник: WebSearch/WebFetch); решта денайлисту лишається.
      const builtin = opts.builtinTools ?? [];
      const builtinOff = SDK_BUILTIN_TOOLS_OFF.filter((t) => !builtin.includes(t));
      // Сервер per-run: хендлери замикають onToolCall саме цього прогону.
      // Для профілю без інструментів (quick) не створюємо взагалі.
      const mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>> = {};
      if (active.length > 0) {
        mcpServers.svitanok = createSdkMcpServer({
          name: 'svitanok',
          tools: active.map((t) =>
            tool(t.mcpName, t.description, t.args.shape, async (args) => {
              const out = await opts.onToolCall(t.mcpName, args);
              return {
                content: [{ type: 'text' as const, text: out.text }],
                isError: out.isError,
              };
            }),
          ),
        });
      }

      // Міст сигналів: agent.ts тримає таймаут профілю на AbortSignal, SDK
      // хоче власний AbortController.
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (opts.abortSignal.aborted) abortController.abort();
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true });

      let finalText: string | null = null;
      let sessionId: string | null = null;
      let apiMs: number | null = null;
      let partial = '';
      try {
        const q = query({
          prompt: inputText,
          options: {
            systemPrompt: opts.systemPrompt,
            model: opts.model,
            maxTurns: opts.maxTurns,
            // Рівень зусиль профілю/працівника; не задано - дефолт SDK.
            ...(opts.effort ? { effort: opts.effort } : {}),
            // Resume сесії треду (01 §2.2, профіль chat); undefined - свіжа.
            resume: opts.resumeSessionId ?? undefined,
            abortController,
            // Партіали лише коли є куди стрімити (знахідка ревʼю: інакше
            // потік дельт з сабпроцеса викидався в порожній колбек).
            includePartialMessages: opts.streamPartials,
            mcpServers,
            // tools: [] - СТРОГИЙ гейт доступності вбудованих інструментів
            // (d.ts: allowedTools лише авто-апрувить дозволи, доступність
            // обмежує tools). Денайлист нижче - пояс до цих шлейок: новий
            // builtin майбутнього SDK не зʼявиться мовчки (знахідка ревʼю).
            tools: builtin,
            allowedTools: [...active.map((t) => `mcp__svitanok__${t.mcpName}`), ...builtin],
            disallowedTools: builtinOff,
          },
        });
        for await (const message of q) {
          // session_id несе кожне повідомлення SDK; для resume наступного
          // прогону потрібен актуальний (SDK може форкнути сесію).
          if ('session_id' in message && typeof message.session_id === 'string') {
            sessionId = message.session_id;
          }
          if (message.type === 'stream_event') {
            const event = message.event;
            // Нове повідомлення моделі - partial з нуля (ревʼю PR-3): інакше
            // «частковий результат» на стелі ходів був би склейкою всієї
            // нарації прогону, а статусник - хвостом усіх ходів разом.
            if (event.type === 'message_start') partial = '';
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              partial += event.delta.text;
              opts.onPartialText(partial);
            }
          } else if (message.type === 'result') {
            // Час у API моделі проти повного часу прогону (замір швидкості,
            // 06.09): різниця - накладні CLI/сесії, не генерація.
            if (typeof message.duration_api_ms === 'number') apiMs = message.duration_api_ms;
            if (message.subtype === 'success') {
              finalText = message.result;
            } else {
              // 'error_max_turns' | 'error_during_execution' | usage-limit -
              // явна помилка прогону: agent.ts доставить її власнику чесно, а
              // для працівника на стелі ходів віддасть частковий текст (S-7-5).
              throw new EngineStopError(message.subtype, partial);
            }
          }
        }
      } finally {
        opts.abortSignal.removeEventListener('abort', onAbort);
      }
      return { finalText, sessionId, apiMs };
    },

    // Транскрипт із локального сховища SDK (HOME=data на VPS) - для згортки
    // БЕЗ resume: службовий хід не бруднить сесію (ADR-038). null = чесна
    // відсутність (сесію вичищено/не знайдено) - викликач робить error-крок.
    async readTranscript(sessionId: string): Promise<string | null> {
      try {
        const messages = await getSessionMessages(sessionId, { limit: 400 });
        const lines: string[] = [];
        for (const m of messages) {
          if (m.type !== 'user' && m.type !== 'assistant') continue;
          const raw = m.message as { content?: unknown } | undefined;
          const text = extractText(raw?.content);
          if (!text) continue;
          lines.push(`${m.type === 'user' ? 'Власник' : 'Світанок'}: ${text}`);
        }
        return lines.length > 0 ? lines.join('\n') : null;
      } catch (err) {
        console.error(`readTranscript(${sessionId}): ${String(err)}`);
        return null;
      }
    },
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((block) =>
      block && typeof block === 'object' && (block as { type?: string }).type === 'text'
        ? String((block as { text?: unknown }).text ?? '')
        : '',
    )
    .filter(Boolean)
    .join('\n')
    .trim();
}
