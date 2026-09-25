// Конфігурація мозку (01-architecture §2.2). Джерело - process.env (systemd
// EnvironmentFile=/opt/svitanok-brain-shared/brain.env). Помилка конфігурації - явний
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
  /** Провайдер runtime; hybrid лишає production на Claude, а OpenAI вмикає
   * лише для явно названих canary-тредів. */
  aiProvider: 'claude' | 'openai' | 'hybrid';
  /** Є лише при aiProvider=openai; ніколи не логується і не їде в Responses. */
  openAiApiKey: string | null;
  /** Моделі Responses за класом задачі. Значення ніколи не є секретами. */
  openAiModels: { fast: string; standard: string; advanced: string } | null;
  openAiReasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  /** Безпечний cutover: `canary` можливий лише разом із Claude fallback. */
  openAiRollout: 'canary' | 'full' | null;
  openAiCanaryThreadIds: readonly string[];
  openAiCanaryProfiles: readonly string[];
  /** Explicitly scoped, tool-free OpenAI comparison while Claude still
   * delivers the answer. Empty means shadow traffic is impossible. */
  openAiShadowThreadIds: readonly string[];
  openAiShadowProfiles: readonly string[];
}

const REQUIRED = ['INTERNAL_HMAC_KEY', 'INTERNAL_API_URL'] as const;
const OPENAI_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function loadConfig(env: Record<string, string | undefined>): BrainConfig {
  const missing: string[] = REQUIRED.filter((name) => !String(env[name] ?? '').trim());
  const configuredProvider = String(env.AI_PROVIDER ?? 'claude')
    .trim()
    .toLowerCase();
  if (!['claude', 'openai', 'hybrid'].includes(configuredProvider)) {
    throw new Error('конфігурація: AI_PROVIDER має бути claude, openai або hybrid');
  }
  const aiProvider = configuredProvider as BrainConfig['aiProvider'];
  const csv = (value: string | undefined) =>
    String(value ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  const openAiCanaryThreadIds = csv(env.OPENAI_CANARY_THREAD_IDS);
  const openAiCanaryProfiles = csv(env.OPENAI_CANARY_PROFILES);
  const openAiShadowThreadIds = csv(env.OPENAI_SHADOW_THREAD_IDS);
  const openAiShadowProfiles = csv(env.OPENAI_SHADOW_PROFILES);
  if (Boolean(openAiShadowThreadIds.length) !== Boolean(openAiShadowProfiles.length)) {
    throw new Error(
      'конфігурація: OPENAI_SHADOW_THREAD_IDS і OPENAI_SHADOW_PROFILES задаються парою',
    );
  }
  const shadowEnabled = openAiShadowThreadIds.length > 0;
  const needsClaude = aiProvider === 'claude' || aiProvider === 'hybrid' || shadowEnabled;
  const needsOpenAi = aiProvider === 'openai' || aiProvider === 'hybrid' || shadowEnabled;
  if (needsClaude && !String(env.CLAUDE_CODE_OAUTH_TOKEN ?? '').trim()) {
    missing.unshift('CLAUDE_CODE_OAUTH_TOKEN');
  }
  const openAiApiKey = String(env.OPENAI_API_KEY ?? '').trim();
  if (needsOpenAi && !openAiApiKey) missing.unshift('OPENAI_API_KEY');
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

  const configuredEffort = String(env.OPENAI_REASONING_EFFORT ?? 'high')
    .trim()
    .toLowerCase();
  if (needsOpenAi && !OPENAI_EFFORTS.has(configuredEffort)) {
    throw new Error('конфігурація: OPENAI_REASONING_EFFORT має бути low|medium|high|xhigh|max');
  }
  // OPENAI_MODEL лишається fallback для уже розгорнутих інсталяцій. Нові
  // змінні дозволяють quick/summarize не платити за advanced модель.
  const legacyModel = String(env.OPENAI_MODEL ?? '').trim();
  const openAiModels = {
    fast: String(env.OPENAI_MODEL_FAST ?? 'gpt-6-luna').trim(),
    standard: String(env.OPENAI_MODEL_STANDARD ?? legacyModel ?? 'gpt-6-sol').trim() || 'gpt-6-sol',
    advanced: String(env.OPENAI_MODEL_ADVANCED ?? 'gpt-6-astra').trim(),
  };
  if (needsOpenAi && Object.values(openAiModels).some((model) => !model)) {
    throw new Error('конфігурація: OPENAI_MODEL_FAST/STANDARD/ADVANCED не можуть бути порожніми');
  }
  const configuredRollout = String(env.OPENAI_ROLLOUT ?? 'canary')
    .trim()
    .toLowerCase();
  if (needsOpenAi && configuredRollout !== 'canary' && configuredRollout !== 'full') {
    throw new Error('конфігурація: OPENAI_ROLLOUT має бути canary або full');
  }
  if (aiProvider === 'openai' && configuredRollout !== 'full') {
    throw new Error('конфігурація: AI_PROVIDER=openai потребує OPENAI_ROLLOUT=full');
  }
  if (
    aiProvider === 'hybrid' &&
    configuredRollout === 'canary' &&
    openAiCanaryThreadIds.length === 0
  ) {
    throw new Error('конфігурація: OPENAI_CANARY_THREAD_IDS потрібен для hybrid canary');
  }

  return {
    host: String(env.HOST ?? '127.0.0.1').trim(),
    port,
    internalApiUrl,
    hmacKeys,
    accessClientId: accessClientId || null,
    accessClientSecret: accessClientSecret || null,
    aiProvider,
    openAiApiKey: needsOpenAi ? openAiApiKey : null,
    openAiModels: needsOpenAi ? openAiModels : null,
    openAiReasoningEffort: needsOpenAi
      ? (configuredEffort as 'low' | 'medium' | 'high' | 'xhigh' | 'max')
      : null,
    openAiRollout: needsOpenAi ? (configuredRollout as 'canary' | 'full') : null,
    openAiCanaryThreadIds,
    openAiCanaryProfiles,
    openAiShadowThreadIds,
    openAiShadowProfiles,
  };
}
