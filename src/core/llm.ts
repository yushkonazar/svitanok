// LLMClient через `claude -p` на Pro-підписці (НЕ платний API, §2). Пін моделі,
// таймаут, стеля викликів за ран (§8). spawn з масивом аргументів — без shell і
// без склейки рядків (§19.7). Промпт — через stdin (без ліміту довжини аргументу).
//
// Неінтерактивність (§2.1): brief.yml пресідить ~/.claude.json
// (hasCompletedOnboarding) перед першим викликом, інакше CI висне на trust-промпті.

import { spawn } from 'node:child_process';
import type { LLMClient, Logger } from './types.js';

export interface LLMOptions {
  model: string;
  defaultTimeoutMs: number;
  maxCallsPerRun: number;
  log?: Logger;
}

function runClaude(
  prompt: string,
  model: string,
  timeoutMs: number,
  log?: Logger,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', ['-p', '--model', model], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`claude -p таймаут ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        // stderr часто порожній — додаємо stdout для діагностики (напр. trust-діалог).
        const diag = (stderr || stdout).trim().slice(0, 500) || '(порожній вивід)';
        log?.warn(`claude -p exit ${code}: ${diag}`);
        reject(new Error(`claude -p exit ${code}: ${diag}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

/** Клієнт, що ще й памʼятає впалі виклики цього рану (A3). Модулі ловлять свої
 *  помилки самі (jobs -> порядок за свіжістю, fact/mock -> блок відсутній), тож
 *  брифінг однаково приходить — просто тихо бідніший. Оркестратор читає цей
 *  список у кінці й один раз попереджає в «⚠️ Система», щоб деградація не була
 *  невидимою. */
export interface RecordingLLMClient extends LLMClient {
  failures(): string[];
}

// Ліміт підписки Claude CLI віддає лише людським текстом (машинного коду немає).
// Дзеркало host/llm-host-core.mjs USAGE_LIMIT_RE — src/ і host/ навмисно не
// шарять код (різні деплої), тому це свідомий копі, а не забутий рефактор.
const USAGE_LIMIT_RE =
  /(usage limit reached|hit your (?:session|weekly|usage) limit|(?:session|weekly|5-hour) limit reached|limit will reset)/i;

export function isUsageLimitError(text: string): boolean {
  return USAGE_LIMIT_RE.test(text);
}

/** Попередження в «⚠️ Система» про деградацію рану; null — якщо все пройшло. */
export function formatLlmDegradedMessage(failures: string[]): string | null {
  if (failures.length === 0) return null;
  const limit = failures.some(isUsageLimitError);
  const head = limit
    ? `⚠️ Svitanok: ліміти Claude вичерпані — ${failures.length} LLM-виклик(ів) впало.`
    : `⚠️ Svitanok: LLM недоступний — ${failures.length} виклик(ів) впало.`;
  return [
    head,
    'Брифінг надіслано, але блоки, що залежать від LLM (вакансії/факт/питання дня), деградували.',
    ...failures.slice(0, 3).map((f) => `• ${f.slice(0, 160)}`),
  ].join('\n');
}

export function createLLMClient(opts: LLMOptions): RecordingLLMClient {
  let calls = 0;
  const failed: string[] = [];
  return {
    async complete(prompt, callOpts): Promise<string> {
      if (calls >= opts.maxCallsPerRun) {
        throw new Error(`LLM maxCallsPerRun (${opts.maxCallsPerRun}) перевищено`);
      }
      calls += 1;
      const timeoutMs = callOpts?.timeoutMs ?? opts.defaultTimeoutMs;
      try {
        return await runClaude(prompt, opts.model, timeoutMs, opts.log);
      } catch (e) {
        failed.push(e instanceof Error ? e.message : String(e));
        throw e; // поведінка модулів не змінюється — лише лишаємо слід
      }
    },
    failures: () => [...failed],
  };
}
