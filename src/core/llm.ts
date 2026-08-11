// LLMClient через `claude -p` на Pro-підписці (НЕ платний API, §2). Пін моделі,
// таймаут, стеля викликів за ран (§8). spawn з масивом аргументів — без shell і
// без склейки рядків (§19.7). Промпт — через stdin (без ліміту довжини аргументу).
//
// Неінтерактивність (§2.1): brief.yml пресідить ~/.claude.json
// (hasCompletedOnboarding) перед першим викликом, інакше CI висне на trust-промпті.
//
// БЕЗПЕКА (security-рев'ю): оркестратор годує в модель НЕДОВІРЕНИЙ контент —
// тіла листів (mail-тріаж) і RSS (jobs) контролює будь-хто, хто напише на пошту
// чи опублікує вакансію. А сам процес крутиться в GitHub Actions поряд із
// найпотужнішими секретами (GOOGLE_REFRESH_TOKEN, CF_API_TOKEN, TELEGRAM_BOT_TOKEN).
// Тому дзеркалимо локдаун VPS-хоста (host/llm-host-core.buildClaudeArgs):
//   1. `--tools ''` — модель НЕ отримує жодного інструменту (лише текст-відповідь).
//      Прибирає весь клас «інʼєкція в листі -> виклик Bash/WebFetch -> витік env».
//   2. вичищене оточення дочірнього процесу — без секретів, які claude не треба
//      (defense-in-depth: навіть якби зʼявився шлях до інструмента, красти нічого).

import { spawn } from 'node:child_process';
import type { LLMClient, Logger } from './types.js';

/**
 * Аргументи claude CLI. `--tools ''` — головна межа безпеки (див. шапку файлу):
 * модель тут потрібна лише для тексту (JSON-класифікація/скоринг), жоден модуль
 * інструментів не потребує. Той самий прийом, що на VPS-хості з тим самим піном
 * CLI (@anthropic-ai/claude-code 2.1.195), тож поведінка вже доведена.
 */
export function buildClaudeArgs(model: string): string[] {
  return ['-p', '--tools', '', '--model', model];
}

/**
 * Секрети кроку `run briefing` (brief.yml), яких дочірньому claude НЕ треба.
 * Лишаємо все системне (PATH/HOME) і CLAUDE_CODE_OAUTH_TOKEN (авторизація CLI),
 * викидаємо реальні креденшели. ⚠️ Додаєш секрет-креденшел у brief.yml -> додай
 * і сюди (тест scrubSecretsFromEnv стереже перелік).
 */
export const SENSITIVE_ENV_KEYS = [
  'CF_API_TOKEN',
  'CF_ACCOUNT_ID',
  'GOOGLE_CLIENT_ID',
  'GOOGLE_CLIENT_SECRET',
  'GOOGLE_REFRESH_TOKEN',
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_BOT_USERNAME',
  'WEATHER_API_KEY',
  'NEWSDATA_API_KEY',
  // Доїхав у brief.yml разом із перекладом world-новин (28f35d3) — і лишався в
  // оточенні дочірнього claude, який читає тіла листів і RSS вакансій, тобто
  // рівно недовірений контент (B3). Тепер перелік стереже тест, що парсить
  // сам env-блок workflow, а не список, переписаний вручну.
  'GOOGLE_TRANSLATE_API_KEY',
] as const;

/** Копія оточення без секретів із SENSITIVE_ENV_KEYS (defense-in-depth поверх
 *  `--tools ''`). Спред+delete, не мутуємо process.env. */
export function scrubSecretsFromEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of SENSITIVE_ENV_KEYS) delete out[k];
  return out;
}

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
    const child = spawn('claude', buildClaudeArgs(model), {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Дочірній процес НЕ успадковує креденшели, які йому не потрібні (див.
      // шапку файлу): недовірений лист-контент розмовляє з claude, у якого в
      // env немає ні refresh-токена, ні CF-токена, ні bot-токена.
      env: scrubSecretsFromEnv(process.env),
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
        const out = stdout.trim();
        // ⚠️ Вичерпаний ліміт підписки — це ПОМИЛКА, хоч CLI вийшов успішно.
        // claude -p не має машинного коду для лімітів: він друкує людський текст
        // («You've hit your session limit…») і повертає exit 0. Без цієї гілки
        // такий текст ішов у модуль як звичайна відповідь — і мовчки ставав
        // «нічого не знайдено»: пошта позначала листи прочитаними й губила
        // запрошення на співбесіду назавжди, а «⚠️ Система» не спрацьовувала,
        // бо у failures() нічого не писалось. Тепер це throw -> модуль деградує
        // чесно, дедуп не позначається, і власник бачить попередження.
        if (isUsageLimitError(out)) {
          const diag = out.slice(0, 200);
          log?.warn(`claude -p: ліміт підписки (exit 0, людський текст): ${diag}`);
          reject(new Error(`claude -p: ліміт підписки вичерпано — ${diag}`));
          return;
        }
        resolve(out);
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

export interface LlmFailure {
  /** Хто саме викликав (opts.tag модуля) — щоб попередження назвало РЕАЛЬНО
   *  деградовані блоки, а не константний список. */
  tag: string;
  message: string;
}

/** Клієнт, що ще й памʼятає впалі виклики цього рану (A3). Модулі ловлять свої
 *  помилки самі (jobs -> порядок за свіжістю, fact/mock/mail -> блок відсутній),
 *  тож брифінг однаково приходить — просто тихо бідніший. Оркестратор читає цей
 *  список у кінці й один раз попереджає в «⚠️ Система», щоб деградація не була
 *  невидимою. */
export interface RecordingLLMClient extends LLMClient {
  failures(): LlmFailure[];
}

// Ліміт підписки Claude CLI віддає лише людським текстом (машинного коду немає).
// Дзеркало host/llm-host-core.mjs і web/agent-core.mjs USAGE_LIMIT_RE — src/, host/
// і web/ навмисно не шарять код (різні деплої), тому це свідомий копі. Щоб копії не
// розʼїхались (ревʼю A: одна вже народилась із втраченою гілкою), паритет усіх трьох
// стереже спільний фікстур-набір у tests/usage-limit-fixtures.ts.
const USAGE_LIMIT_RE =
  /(usage limit reached|hit your (?:session|weekly|usage) limit|(?:session|weekly|5-hour) limit reached|limit will reset|upgrade to increase your usage limit)/i;

export function isUsageLimitError(text: string): boolean {
  return USAGE_LIMIT_RE.test(text);
}

// Людські назви блоків для попередження — краще за константний список у тексті
// (ревʼю A: старий рядок мовчав про пошту, а це найдорожча деградація — зникає
// пропозиція «додати співбесіду в календар»; і навпаки, називав факт/питання, які
// в типовий день узагалі не викликають LLM, бо живуть із батч-кешу).
const MODULE_LABELS: Record<string, string> = {
  jobs: 'вакансії (скоринг релевантності)',
  mail: 'пошта (тріаж + пропозиції співбесід)',
  fact: 'факт дня',
  mock: 'питання дня',
};

/** Попередження в «⚠️ Система» про деградацію рану; null — якщо все пройшло. */
export function formatLlmDegradedMessage(failures: LlmFailure[]): string | null {
  if (failures.length === 0) return null;
  const limit = failures.some((f) => isUsageLimitError(f.message));
  const affected = [...new Set(failures.map((f) => MODULE_LABELS[f.tag] ?? f.tag))];
  const head = limit
    ? `⚠️ Svitanok: ліміти Claude вичерпані — ${failures.length} LLM-виклик(ів) впало.`
    : `⚠️ Svitanok: LLM недоступний — ${failures.length} виклик(ів) впало.`;
  return [
    head,
    `Брифінг надіслано, але деградували: ${affected.join(', ')}.`,
    ...failures.slice(0, 2).map((f) => `• ${f.tag}: ${f.message.slice(0, 160)}`),
  ].join('\n');
}

export function createLLMClient(opts: LLMOptions): RecordingLLMClient {
  let calls = 0;
  const failed: LlmFailure[] = [];
  return {
    async complete(prompt, callOpts): Promise<string> {
      // maxCallsPerRun — НАША стеля, а не збій LLM: кидаємо, але у failures не
      // пишемо (інакше «LLM недоступний» звучало б там, де LLM цілком живий).
      if (calls >= opts.maxCallsPerRun) {
        throw new Error(`LLM maxCallsPerRun (${opts.maxCallsPerRun}) перевищено`);
      }
      calls += 1;
      const timeoutMs = callOpts?.timeoutMs ?? opts.defaultTimeoutMs;
      try {
        return await runClaude(prompt, opts.model, timeoutMs, opts.log);
      } catch (e) {
        failed.push({
          tag: callOpts?.tag ?? 'llm',
          message: e instanceof Error ? e.message : String(e),
        });
        throw e; // поведінка модулів не змінюється — лише лишаємо слід
      }
    },
    failures: () => [...failed],
  };
}
