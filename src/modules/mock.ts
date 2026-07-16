// mock (consumer). «Питання дня» для підготовки до співбесіди — LLM, але
// ЕКОНОМНО: батч-кеш. Коли state.mockCache порожній, один claude -p генерує
// batchSize пар питання+відповідь+тема під стек; далі щодня одну без LLM.
// Розкриття в дашборді показує відповідь + самооцінку (легко/важко, Блок F) +
// кнопку «Вивчити» (детермінований пошук теми). Самооцінка на слабких темах
// підвищує їх вагу (mockWeights, KV `state`) -> наступний батч генерує більше
// питань саме з них («інтервальне повторення» тем, не конкретних питань).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';

const MOCK_PRIORITY = 58; // після вакансій (55)

// Фіксований список тем — щоб вага теми (mockWeights) не фрагментувалась між
// батчами через довільні LLM-формулювання. Безпека/AI-LLM додано 2026-07,
// щоб словник тем перекликався з новими темами роадмепу (web/roadmap-data.mjs:
// security, ai-dev) — той самий «інтерв'ю ↔ навчання» словник без окремої
// логіки синхронізації (mockWeights і roadmapProgress лишаються незалежними
// стейтами; звʼязок лише на рівні назв тем).
// F4: 8 -> 13. Кожна тема роадмепу тепер має свою mock-тему (доти
// tools/ecosystem/testing-adv/perf-a11y не мали жодної, тож «тема тижня» з них
// не могла сісти батч питань). TypeScript відділено від 'Мова': профіль скрізь
// TS, і спільна вага з ванільним JS ховала, що саме кульгає.
// ⚠️ Дзеркалиться в web/mastery-core.mjs MOCK_TO_ROADMAP — тест пришпилює,
// що списки не розʼїхались.
export const MOCK_TOPICS = [
  'Мова',
  'TypeScript',
  'Фреймворк',
  'HTTP',
  'Бази даних',
  'Алгоритми',
  'Патерни',
  'Безпека',
  'AI/LLM',
  'Тестування',
  'Git/CI',
  'Тулінг',
  'Продуктивність',
];

export interface MockQA {
  q: string;
  a: string;
  topic?: string;
}

// --- mockWeights (памʼять слабких тем із самооцінки: інтервальне повторення) ---
export type MockWeights = Record<string, number>;
export const MOCK_WEIGHT_MIN = 0.5;
export const MOCK_WEIGHT_MAX = 2.0;
const MOCK_WEIGHT_STEP = 0.2;

const clampMockWeight = (w: number) => Math.min(MOCK_WEIGHT_MAX, Math.max(MOCK_WEIGHT_MIN, w));

/** rating='hard' -> тема «слабша», вага росте (частіше в наступному батчі); 'easy' -> спадає. */
export function updateMockWeight(
  weights: MockWeights,
  topic: string,
  rating: 'easy' | 'hard',
): MockWeights {
  if (!topic) return weights;
  const cur = weights[topic] ?? 1.0;
  const next = clampMockWeight(cur + (rating === 'hard' ? MOCK_WEIGHT_STEP : -MOCK_WEIGHT_STEP));
  return { ...weights, [topic]: next };
}

// «Тема тижня» з роадмепу (A4): Worker пише state.masteryFocus (web/mastery-core.mjs
// themeOfWeek — дзеркало ФОРМИ, не логіки; src/ web-код не імпортує). Тут лише
// читаємо готові рядки й сідимо ними наступний батч.
export interface MasteryFocus {
  week: string;
  topicId: string;
  title: string;
  done: number;
  total: number;
  mockTopics: string[];
}

/** Валідний фокус із mock-темами зі словника; інакше null (батч без зсуву). */
export function sanitizeMasteryFocus(raw: unknown): MasteryFocus | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Partial<MasteryFocus>;
  if (typeof f.title !== 'string' || !f.title) return null;
  const topics = (Array.isArray(f.mockTopics) ? f.mockTopics : []).filter(
    (t): t is string => typeof t === 'string' && MOCK_TOPICS.includes(t),
  );
  if (topics.length === 0) return null; // roadmap-only тема (tools/ecosystem) — без зсуву
  return {
    week: typeof f.week === 'string' ? f.week : '',
    topicId: typeof f.topicId === 'string' ? f.topicId : '',
    title: f.title,
    done: Number(f.done) || 0,
    total: Number(f.total) || 0,
    mockTopics: topics,
  };
}

/** Слабкі теми (вага>1.0), спадаюче за вагою — та сама логіка, що buildMockPrompt
 *  і Фаза A stats-core weakTopics; тепер спільна точка (нема дублювання). */
export function weakMockTopics(weights?: MockWeights): string[] {
  if (!weights) return [];
  return Object.entries(weights)
    .filter(([, w]) => w > 1.0)
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t);
}

export function buildMockPrompt(
  n: number,
  profile: string,
  weights?: MockWeights,
  focus?: MasteryFocus | null,
): string {
  const weak = weakMockTopics(weights);
  return [
    `Згенеруй рівно ${n} пар «питання–відповідь» для технічної співбесіди.`,
    `Профіль кандидата: ${profile}.`,
    `Теми лише з цього списку: ${MOCK_TOPICS.join(', ')}.`,
    weak.length ? `Приділи більше уваги слабким темам кандидата: ${weak.join(', ')}.` : '',
    focus
      ? `Тема тижня з навчального роадмепу: «${focus.title}» — включи 2–3 питання з тем: ${focus.mockTopics.join(', ')}.`
      : '',
    'Питання — одне речення. Відповідь — 1–2 речення, стисло й точно, українською.',
    "Поверни ЛИШЕ валідний JSON-масив об'єктів без прози:",
    '[{"q":"питання","a":"відповідь","topic":"одна з тем зі списку"}, ...]',
  ]
    .filter(Boolean)
    .join(' ');
}

/** Розпарсити масив {q,a,topic?} з відповіді LLM; малформат/порожні -> відкидаємо. */
export function parseMockCache(text: string): MockQA[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return [];
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is { q: string; a?: unknown; topic?: unknown } =>
          !!x && typeof x === 'object' && typeof (x as { q?: unknown }).q === 'string',
      )
      .map((x) => ({
        q: x.q.trim(),
        a: typeof x.a === 'string' ? x.a.trim() : '',
        topic: typeof x.topic === 'string' && x.topic.trim() ? x.topic.trim() : undefined,
      }))
      .filter((x) => x.q.length > 0 && x.a.length > 0); // лише повні пари
  } catch {
    return [];
  }
}

/**
 * Ключ питання для дедупу батчів (F4). Нормалізуємо, щоб перефразоване тим
 * самим змістом («Що таке замикання?» / «що таке замикання») не проскакувало
 * як нове: нижній регістр, злиті пробіли, геть пунктуацію по краях.
 * Хеш — FNV-1a у base36: короткий і стабільний між ранами.
 */
export function questionKey(q: string): string {
  const norm = q
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < norm.length; i++) {
    h ^= norm.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

// Скільки ключів заданих питань памʼятаємо. ~batchSize×8 — вистачає, щоб
// наступні кілька батчів не повторювались, і стан не росте безмежно.
const ASKED_CAP = 120;

export const mockModule: Module<AppConfig> = {
  id: 'mock',
  kind: 'consumer',
  enabled: (config) => config.modules.mock.enabled,

  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const cfg = ctx.config.modules.mock;
    // Лишаємо лише ПОВНІ пари {q,a}. Старий string[]-кеш і мігровані порожні
    // {q,a:''} відкидаються -> регенеруємо з відповідями.
    const raw = ctx.state.get<unknown[]>('mockCache') ?? [];
    let cache: MockQA[] = (Array.isArray(raw) ? raw : []).filter(
      (x): x is MockQA =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as MockQA).q === 'string' &&
        (x as MockQA).q.length > 0 &&
        typeof (x as MockQA).a === 'string' &&
        (x as MockQA).a.length > 0,
    );

    // F4: ключі вже заданих питань — LLM схильна повторювати класику
    // («що таке замикання?») з батчу в батч, і без цього фільтра одне й те саме
    // питання прилітало раз на тиждень. Промпту хеші не покажеш, тож
    // відсіюємо ПІСЛЯ генерації.
    const asked: string[] = (ctx.state.get<unknown[]>('mockAsked') ?? []).filter(
      (x): x is string => typeof x === 'string',
    );
    const askedSet = new Set(asked);

    if (cache.length === 0) {
      // mockWeights (Блок F): слабкі теми з самооцінки -> LLM генерує більше з них.
      const weights = ctx.state.get<MockWeights>('mockWeights');
      // masteryFocus (A4): «тема тижня» з роадмепу (пише Worker) сідить батч.
      const focus = sanitizeMasteryFocus(ctx.state.get<unknown>('masteryFocus'));
      try {
        const out = await ctx.llm.complete(
          buildMockPrompt(cfg.batchSize, cfg.profile, weights, focus),
          { timeoutMs: ctx.config.llm.timeoutMs, tag: 'mock' },
        );
        cache = parseMockCache(out);
      } catch (e) {
        ctx.log.warn(`mock: генерація не вдалася: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      const fresh = cache.filter((x) => !askedSet.has(questionKey(x.q)));
      // Якщо ВЕСЬ батч — повтори, беремо його як є: краще старе питання, ніж
      // порожня картка. Інакше — лише свіжі.
      if (fresh.length > 0) cache = fresh;
      else if (cache.length > 0) ctx.log.warn('mock: батч цілком із повторів — беру як є');
      if (cache.length === 0) return null;
    }

    const item = cache.shift()!;
    ctx.state.set('mockCache', cache);
    ctx.state.set('mockAsked', [...asked, questionKey(item.q)].slice(-ASKED_CAP));
    return {
      id: 'mock',
      title: 'Питання дня',
      icon: '🎤',
      summary: item.q,
      data: {
        question: item.q,
        answer: item.a || undefined,
        // resourceUrl прибрано (F4): це був google.com/search за текстом
        // питання — тобто зізнання, що ми не знаємо, куди відправити.
        // «Вивчити» тепер веде в курований матеріал роадмепу (stats.mockMaterials).
        topic: item.topic,
      },
      inMessage: false, // глибина — в дашборді; повідомлення лаконічне
      priority: MOCK_PRIORITY,
    };
  },
};
