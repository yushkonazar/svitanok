// Бойовий рушій - Claude Agent SDK. ЄДИНЕ місце імпорту SDK: agent.ts і
// кореневі тести бачать лише інтерфейс RunEngine (мок), а типи цього файлу
// перевіряє tsc -p brain своїми node_modules.
//
// Інструменти - in-process MCP-сервер `svitanok` (01 §2.2): кожен tool()
// делегує в opts.onToolCall, де agent.ts тримає стелю, taint-барʼєр і маршрут
// у /internal/tool ядра. Вбудовані інструменти SDK вимкнені (07 §4).

import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import type { EngineOutcome, EngineRunOptions, RunEngine } from '../agent.js';
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

export function createSdkEngine(): RunEngine {
  return {
    async run(opts: EngineRunOptions, inputText: string): Promise<EngineOutcome> {
      const active = BRAIN_TOOLS.filter((t) => opts.toolNames.includes(t.mcpName));
      const server = createSdkMcpServer({
        name: 'svitanok',
        tools: active.map((t) =>
          tool(t.mcpName, t.description, t.args.shape, async (args) => {
            const out = await opts.onToolCall(t.mcpName, args);
            return { content: [{ type: 'text' as const, text: out.text }], isError: out.isError };
          }),
        ),
      });

      // Міст сигналів: agent.ts тримає таймаут профілю на AbortSignal, SDK
      // хоче власний AbortController.
      const abortController = new AbortController();
      const onAbort = () => abortController.abort();
      if (opts.abortSignal.aborted) abortController.abort();
      else opts.abortSignal.addEventListener('abort', onAbort, { once: true });

      let finalText: string | null = null;
      let partial = '';
      try {
        const q = query({
          prompt: inputText,
          options: {
            systemPrompt: opts.systemPrompt,
            model: opts.model,
            maxTurns: opts.maxTurns,
            abortController,
            includePartialMessages: true,
            mcpServers: active.length > 0 ? { svitanok: server } : {},
            allowedTools: active.map((t) => `mcp__svitanok__${t.mcpName}`),
            disallowedTools: SDK_BUILTIN_TOOLS_OFF,
          },
        });
        for await (const message of q) {
          if (message.type === 'stream_event') {
            const event = message.event;
            if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
              partial += event.delta.text;
              opts.onPartialText(partial);
            }
          } else if (message.type === 'result') {
            if (message.subtype === 'success') {
              finalText = message.result;
            } else {
              // 'error_max_turns' | 'error_during_execution' | usage-limit -
              // явна помилка прогону, agent.ts доставить її власнику чесно.
              throw new Error(`SDK: ${message.subtype}`);
            }
          }
        }
      } finally {
        opts.abortSignal.removeEventListener('abort', onAbort);
      }
      return { finalText };
    },
  };
}
