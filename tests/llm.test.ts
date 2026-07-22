import { describe, it, expect } from 'vitest';
import {
  formatLlmDegradedMessage,
  isUsageLimitError,
  buildClaudeArgs,
  scrubSecretsFromEnv,
  SENSITIVE_ENV_KEYS,
} from '../src/core/llm.js';
import { USAGE_LIMIT_TEXTS, NON_LIMIT_TEXTS } from './usage-limit-fixtures.js';

describe('buildClaudeArgs (security — локдаун інструментів у CI)', () => {
  it('передає --tools "" (окремим argv-слотом), як VPS-хост', () => {
    const args = buildClaudeArgs('claude-haiku-4-5');
    const i = args.indexOf('--tools');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe(''); // порожній рядок — окремий елемент, не склейка
    expect(args).toContain('-p');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-haiku-4-5');
  });
});

describe('scrubSecretsFromEnv (security — недовірений контент не бачить креденшели)', () => {
  it('викидає КОЖЕН секрет із SENSITIVE_ENV_KEYS', () => {
    const env = Object.fromEntries(SENSITIVE_ENV_KEYS.map((k) => [k, 'секрет']));
    const out = scrubSecretsFromEnv(env);
    for (const k of SENSITIVE_ENV_KEYS) expect(out[k], k).toBeUndefined();
  });

  it('лишає системне оточення й токен авторизації CLI', () => {
    const out = scrubSecretsFromEnv({
      PATH: '/usr/bin',
      HOME: '/home/runner',
      CLAUDE_CODE_OAUTH_TOKEN: 'oauth',
      GOOGLE_REFRESH_TOKEN: 'секрет',
    });
    expect(out.PATH).toBe('/usr/bin');
    expect(out.HOME).toBe('/home/runner');
    expect(out.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth'); // claude без цього не автентифікується
    expect(out.GOOGLE_REFRESH_TOKEN).toBeUndefined();
  });

  it('не мутує вхідний обʼєкт (спред, не delete на process.env)', () => {
    const env = { GOOGLE_REFRESH_TOKEN: 'секрет', PATH: '/usr/bin' };
    scrubSecretsFromEnv(env);
    expect(env.GOOGLE_REFRESH_TOKEN).toBe('секрет'); // оригінал недоторканий
  });

  it('перелік креденшелів покриває реальні секрети brief.yml (регрес — не забути новий)', () => {
    // Дзеркало env кроку `run briefing`: якщо додав креденшел у workflow, додай і
    // в SENSITIVE_ENV_KEYS. Топіки/URL/namespace-id свідомо не тут (не креденшели).
    for (const k of [
      'GOOGLE_REFRESH_TOKEN',
      'GOOGLE_CLIENT_SECRET',
      'CF_API_TOKEN',
      'TELEGRAM_BOT_TOKEN',
      'NEWSDATA_API_KEY',
      'WEATHER_API_KEY',
    ]) {
      expect(SENSITIVE_ENV_KEYS).toContain(k);
    }
  });
});

describe('isUsageLimitError (A3) — паритет із host/ і web/', () => {
  it('упізнає ВСІ тексти ліміту зі спільного фікстур-набору', () => {
    for (const t of USAGE_LIMIT_TEXTS) expect(isUsageLimitError(t), t).toBe(true);
  });

  it('решта помилок — не ліміт (таймаут, впав процес, наша стеля викликів)', () => {
    for (const t of NON_LIMIT_TEXTS) expect(isUsageLimitError(t), t).toBe(false);
  });
});

describe('formatLlmDegradedMessage (A3)', () => {
  it('нічого не впало -> null (тиша в «⚠️ Система»)', () => {
    expect(formatLlmDegradedMessage([])).toBeNull();
  });

  it('ліміт підписки -> явно про ліміти', () => {
    const msg = formatLlmDegradedMessage([
      { tag: 'jobs', message: 'claude -p exit 1: Claude AI usage limit reached|1752620400' },
      { tag: 'mail', message: 'claude -p exit 1: Claude AI usage limit reached|1752620400' },
    ]);
    expect(msg).toContain('ліміти Claude вичерпані');
    expect(msg).toContain('2 LLM-виклик(ів) впало');
    expect(msg).toContain('Брифінг надіслано'); // ран не впав — деградував
  });

  it('називає РЕАЛЬНО впалі блоки, а не константний список', () => {
    // Ревʼю A: старий текст завжди казав «вакансії/факт/питання дня» — мовчав про
    // пошту (а це зникла пропозиція співбесіди) і брехав про факт/питання, які в
    // типовий день живуть із батч-кешу й LLM узагалі не викликають.
    const msg = formatLlmDegradedMessage([{ tag: 'mail', message: 'claude -p таймаут 150000ms' }])!;
    expect(msg).toContain('пошта');
    expect(msg).toContain('співбесід');
    expect(msg).not.toContain('факт дня');
    expect(msg).not.toContain('вакансії');
  });

  it('інші збої -> нейтральний текст «LLM недоступний»', () => {
    const msg = formatLlmDegradedMessage([{ tag: 'jobs', message: 'claude -p таймаут 150000ms' }]);
    expect(msg).toContain('LLM недоступний');
    expect(msg).not.toContain('ліміти Claude');
  });

  it('довгий список -> лише 2 рядки причин (не спамимо в чат), але всі блоки названі', () => {
    const msg = formatLlmDegradedMessage([
      { tag: 'jobs', message: 'a' },
      { tag: 'mail', message: 'b' },
      { tag: 'fact', message: 'c' },
      { tag: 'mock', message: 'd' },
    ])!;
    expect(msg.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(2);
    expect(msg).toContain('4 виклик(ів) впало');
    for (const label of ['вакансії', 'пошта', 'факт дня', 'питання дня']) {
      expect(msg).toContain(label);
    }
  });
});
