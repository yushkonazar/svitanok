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
        log?.warn(`claude -p exit ${code}`);
        reject(new Error(`claude -p exit ${code}: ${stderr.slice(0, 500)}`));
      }
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}

export function createLLMClient(opts: LLMOptions): LLMClient {
  let calls = 0;
  return {
    async complete(prompt, callOpts): Promise<string> {
      if (calls >= opts.maxCallsPerRun) {
        throw new Error(`LLM maxCallsPerRun (${opts.maxCallsPerRun}) перевищено`);
      }
      calls += 1;
      const timeoutMs = callOpts?.timeoutMs ?? opts.defaultTimeoutMs;
      return runClaude(prompt, opts.model, timeoutMs, opts.log);
    },
  };
}
