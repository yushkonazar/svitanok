// Рання валідація КРИТИЧНИХ секретів (§4.1 п.0, §19.12). Без
// TELEGRAM_BOT_TOKEN/CHAT_ID навіть fail-notify німий, тож відмова стане тихою.
// Тому: кинути -> оркестратор гучно логує й завершується ненульовим кодом
// (видимий failed-ран замість тиші).

export class MissingSecretsError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Відсутні критичні секрети: ${missing.join(', ')}`);
    this.name = 'MissingSecretsError';
  }
}

export interface CriticalSecrets {
  botToken: string;
  chatId: string;
}

type Env = Record<string, string | undefined>;

/** Кидає MissingSecretsError, якщо немає bot token / chat id. */
export function requireCriticalSecrets(env: Env = process.env): CriticalSecrets {
  const botToken = env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = env.TELEGRAM_CHAT_ID?.trim();
  const missing: string[] = [];
  if (!botToken) missing.push('TELEGRAM_BOT_TOKEN');
  if (!chatId) missing.push('TELEGRAM_CHAT_ID');
  if (missing.length) throw new MissingSecretsError(missing);
  return { botToken: botToken!, chatId: chatId! };
}

/** Необов'язковий секрет (напр. WEATHER_API_KEY); порожній -> undefined. */
export function optionalSecret(name: string, env: Env = process.env): string | undefined {
  const v = env[name]?.trim();
  return v ? v : undefined;
}
