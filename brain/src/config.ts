// Конфігурація мозку (01-architecture §2.2). Джерело - process.env (systemd
// EnvironmentFile=/opt/svitanok-brain/.env). Помилка конфігурації - явний
// виняток на старті з ІМЕНЕМ змінної; значення секретів сюди не потрапляють:
// CLAUDE_CODE_OAUTH_TOKEN лише перевіряється на наявність (його читає SDK сам).

export interface BrainConfig {
  host: string;
  port: number;
  /** База internal API ядра, без хвостового слеша. */
  internalApiUrl: string;
  /** 1-2 ключі HMAC (основний + вікно ротації), уже trim-нуті. */
  hmacKeys: string[];
  accessClientId: string | null;
  accessClientSecret: string | null;
}

const REQUIRED = ['CLAUDE_CODE_OAUTH_TOKEN', 'INTERNAL_HMAC_KEY', 'INTERNAL_API_URL'] as const;

export function loadConfig(env: Record<string, string | undefined>): BrainConfig {
  const missing = REQUIRED.filter((name) => !String(env[name] ?? '').trim());
  if (missing.length > 0) {
    throw new Error(`конфігурація: не задано ${missing.join(', ')}`);
  }

  const internalApiUrl = String(env.INTERNAL_API_URL).trim().replace(/\/+$/, '');
  let apiUrl: URL;
  try {
    apiUrl = new URL(internalApiUrl);
  } catch {
    throw new Error('конфігурація: INTERNAL_API_URL не є URL');
  }
  // Інцидент 24.08: адреса *.workers.dev вимкнена (workers_dev:false), хост
  // «висів» на 202 без відповіді. Канон - лише кастомний домен.
  if (apiUrl.hostname.endsWith('.workers.dev')) {
    throw new Error('конфігурація: INTERNAL_API_URL на *.workers.dev - лише кастомний домен');
  }
  // База зі шляхом дала б підпис по '/internal/…', а ядро звіряє повний
  // pathname ('/api/internal/…') - кожен запит бився б 401 у проді. Краще
  // гучно на старті (знахідка ревʼю).
  if (apiUrl.pathname !== '/' || apiUrl.search !== '') {
    throw new Error('конфігурація: INTERNAL_API_URL мусить бути лише origin, без шляху і query');
  }

  // Trim - задокументована пастка проєкту (\r\n із панелі/вставки).
  const hmacKeys = [env.INTERNAL_HMAC_KEY, env.INTERNAL_HMAC_KEY_NEXT]
    .map((k) => String(k ?? '').trim())
    .filter(Boolean);

  const accessClientId = String(env.BRAIN_ACCESS_CLIENT_ID ?? '').trim();
  const accessClientSecret = String(env.BRAIN_ACCESS_CLIENT_SECRET ?? '').trim();
  // Пара або цілком, або ніяк (локальний dev без Access): половина пари - це
  // завжди помилка розкладання секретів, її треба чути одразу.
  if (Boolean(accessClientId) !== Boolean(accessClientSecret)) {
    throw new Error('конфігурація: BRAIN_ACCESS_CLIENT_ID/SECRET - задано лише один із пари');
  }

  const port = Number(String(env.PORT ?? '8788').trim());
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('конфігурація: PORT не є портом');
  }

  return {
    host: String(env.HOST ?? '127.0.0.1').trim(),
    port,
    internalApiUrl,
    hmacKeys,
    accessClientId: accessClientId || null,
    accessClientSecret: accessClientSecret || null,
  };
}
