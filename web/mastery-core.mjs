// @ts-check
// Звʼязка mock↔roadmap (Фаза A4): ЯВНА таблиця мапінгу словника mock-тем
// (src/modules/mock.ts MOCK_TOPICS — вони ж ключі mockWeights) на СТАБІЛЬНІ id
// тем роадмепу (web/roadmap-data.mjs). Назви не рівні рядково (mock 'HTTP' vs
// roadmap '📡 HTTP / мережі (поглиблено)'), тож рівність назв — не механізм.
// Мапінг many-to-many. F4 закрив колишню прогалину: tools/ecosystem/testing-adv/
// perf-a11y не мали mock-теми, тож «тема тижня» з них не могла сісти батч
// питань. Тепер кожна тема роадмепу має свою mock-тему (тест це пришпилює).
// mockWeights і roadmapProgress ЛИШАЮТЬСЯ незалежними KV-стейтами; звʼязок —
// лише через ці чисті функції (жодної нової синхронізації станів).
//
// Споживачі: worker.js (handleStats -> stats.mastery для дашборда;
// scheduled -> state.masteryFocus для оркестратора). Оркестратор (mock.ts)
// web-код НЕ імпортує — читає готовий masteryFocus зі state (межа src/↔web/).

import { ROADMAP_TOPICS } from './roadmap-data.mjs';
import { findTopic, topicProgress, topicMaterials } from './roadmap-core.mjs';
import { weekStartKey } from './stats-core.mjs';

/** mock-тема (ключ MOCK_TOPICS/mockWeights) -> id тем роадмепу. */
/** @type {KvBlob} */
export const MOCK_TO_ROADMAP = {
  // 'Мова' віддала typescript окремій темі (F4): профіль скрізь TS, і зливати
  // його з ванільним JS в одну вагу означало ховати, що саме кульгає.
  Мова: ['frontend'],
  TypeScript: ['typescript'],
  Фреймворк: ['react'],
  HTTP: ['networking', 'backend'],
  'Бази даних': ['databases'],
  Алгоритми: ['algorithms'],
  Патерни: ['backend'],
  Безпека: ['security'],
  'AI/LLM': ['ai-dev'],
  // F4: теми, які роадмеп мав, а словник питань — ні.
  Тестування: ['testing-adv'],
  'Git/CI': ['tools'],
  Тулінг: ['ecosystem'],
  Продуктивність: ['perf-a11y'],
};

/** Зворотна мапа: id теми роадмепу -> mock-теми (порожньо для roadmap-only тем).
 *  Обидва входи — модульні константи, тож рахуємо раз і заморожуємо (Worker
 *  кличе це на кожен /api/stats). */
const ROADMAP_TO_MOCK = /** @type {KvBlob} */ (
  (() => {
    /** @type {KvBlob} */
    const out = {};
    for (const t of ROADMAP_TOPICS) out[t.id] = [];
    for (const [mockTopic, ids] of Object.entries(MOCK_TO_ROADMAP)) {
      for (const id of ids) if (out[id]) out[id].push(mockTopic);
    }
    for (const k of Object.keys(out)) Object.freeze(out[k]);
    return Object.freeze(out);
  })()
);

export function roadmapToMock() {
  return ROADMAP_TO_MOCK;
}

/**
 * mock-тема -> куровані матеріали повʼязаних тем роадмепу (F4 «Вивчити» + F5).
 *
 * Доти «Вивчити» вело на пошук Google за текстом питання — тобто зізнання, що
 * ми не знаємо, куди відправити. Тепер веде в конкретне джерело з роадмепу.
 * Живе тут, бо тут уже є місток mock↔roadmap; клієнт отримує готову мапу в
 * /api/stats і не дублює таблицю в себе.
 *
 * Обидва входи — модульні константи, тож рахуємо раз (Worker кличе на кожен
 * /api/stats) і заморожуємо.
 */
const MOCK_MATERIALS = (() => {
  /** @type {KvBlob} */
  const out = {};
  for (const [mockTopic, ids] of Object.entries(MOCK_TO_ROADMAP)) {
    /** @type {KvBlob[]} */
    const mats = [];
    for (const id of ids) {
      const t = findTopic(id);
      if (t) mats.push(...topicMaterials(t));
    }
    if (mats.length) out[mockTopic] = Object.freeze(mats);
  }
  return Object.freeze(out);
})();

export function mockMaterials() {
  return MOCK_MATERIALS;
}

/**
 * Підказки «куди вчитись» для слабких mock-тем (дашборд, C · Майстерність):
 * weakTopics = [{name, value}] з aggregateStats -> для кожної слабкої теми
 * повʼязані теми роадмепу з прогресом. Теми без мапінгу відпадають.
 */
export function masteryHints(
  /** @type {any[]|null|undefined} */ weakTopics,
  /** @type {KvBlob|null|undefined} */ progress,
) {
  const p = progress && typeof progress === 'object' ? progress : {};
  return (Array.isArray(weakTopics) ? weakTopics : [])
    .filter((/** @type {KvBlob} */ w) => w && typeof w.name === 'string')
    .map((/** @type {KvBlob} */ w) => ({
      mockTopic: w.name,
      themes: (MOCK_TO_ROADMAP[w.name] ?? [])
        .map((/** @type {string} */ id) => {
          const t = findTopic(id);
          if (!t) return null;
          const { done, total } = topicProgress(p, t);
          return { id, title: t.title, done, total };
        })
        .filter(Boolean),
    }))
    .filter((h) => h.themes.length > 0);
}

/**
 * Готовність по темах: прогрес роадмепу × статистика mock-питань, тема в тему.
 *
 * ⚠️ НАВІЩО. Блок «Майстерність» вимкнули з рендера 29.07 із вердиктом
 * власника «абсолютно не розумію, що мені показується»: три незалежні сутності
 * (роадмеп, mock, тема тижня) стояли поруч без жодного звʼязку. Звʼязок при
 * цьому ІСНУВАВ — MOCK_TO_ROADMAP просто вище, — але назовні не виходив:
 * дашборд бачив або загальний відсоток роадмепу, або all-time %невдалих по
 * mock-темах, і зіставити їх було нічим.
 *
 * Найцінніше, що дає зіставлення, — РОЗРИВ: тема відмічена пройденою, а
 * питання по ній даються погано. Це «ілюзія знання», і жоден із двох боків
 * окремо її показати не може.
 *
 * ⚠️ easePct = null, а НЕ 0, коли питань не було. Нуль тут читався б як «усе
 * складно», тобто найгірша можлива оцінка діставалась би темі лише за те, що
 * її жодного разу не питали. Клієнт мусить показати такі теми окремо («ще не
 * перевірено»), а не в одному рейтингу з реально слабкими.
 */
export function masteryTopics(
  /** @type {KvBlob|null|undefined} */ progress,
  /** @type {KvBlob|null|undefined} */ mockTopics,
) {
  const p = progress && typeof progress === 'object' ? progress : {};
  const m = mockTopics && typeof mockTopics === 'object' ? mockTopics : {};
  return ROADMAP_TOPICS.map((t) => {
    const { done, total } = topicProgress(p, t);
    let seen = 0;
    let weak = 0;
    // Одна mock-тема може мапитись на кілька тем роадмепу (HTTP -> networking
    // + backend) і навпаки (backend <- HTTP + Патерни). Обидва напрями
    // навмисні, тож лічильники СУМУЮТЬСЯ, а не перезаписуються.
    for (const name of ROADMAP_TO_MOCK[t.id] ?? []) {
      const v = m[name];
      if (!v || typeof v !== 'object') continue;
      seen += Number(v.seen) || 0;
      weak += Number(v.weak) || 0;
    }
    // clamp: weak > seen можливий на легасі-записах (до дедупу по qId лічильники
    // бампались на кожен POST), і відʼємна «легкість» намалювала б смугу назад.
    const easePct = seen > 0 ? Math.round((Math.max(0, seen - weak) / seen) * 100) : null;
    return { id: t.id, title: t.title, done, total, seen, weak, easePct };
  });
}

/**
 * «Тема тижня»: детермінована ротація НЕзавершених тем роадмепу за індексом
 * ISO-тижня (той самий результат для будь-якого dateKey одного тижня — тому
 * щоденний перезапис state.masteryFocus безпечний). Все завершено -> null.
 */
export function themeOfWeek(
  /** @type {KvBlob|null|undefined} */ progress,
  /** @type {string} */ dateKey,
) {
  const p = progress && typeof progress === 'object' ? progress : {};
  const week = weekStartKey(dateKey);
  const weekIdx = Math.round(Date.parse(week + 'T00:00:00Z') / 604800000);
  // Ротація по ПОВНОМУ списку тем (стала довжина!) з переходом до наступної
  // незавершеної. Модуль від кількості незавершених НЕ підходить: завершення
  // будь-якої НЕдотичної теми серед тижня зсувало б вибір — дашборд, state
  // і вже згенерований mock-батч розходилися б. Тут тема стабільна в межах
  // тижня; зміщується лише коли завершили САМУ тему тижня (перехід далі).
  const n = ROADMAP_TOPICS.length;
  const start = ((weekIdx % n) + n) % n;
  for (let i = 0; i < n; i++) {
    // Приведення: індекс завжди в межах масиву (% n), тож undefined тут
    // недосяжний — лише в типі.
    const t = /** @type {KvBlob} */ (ROADMAP_TOPICS[(start + i) % n]);
    const { done, total } = topicProgress(p, t);
    if (done < total) {
      return {
        week,
        topicId: t.id,
        title: t.title,
        done,
        total,
        mockTopics: ROADMAP_TO_MOCK[t.id] ?? [],
      };
    }
  }
  return null;
}
