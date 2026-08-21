// GET /api/levers — читання шару звʼязків «Важелі».
//
// ⚠️ ОКРЕМИЙ ЕНДПОІНТ, той самий мотив, що в /api/archive: /api/stats крутить
// aggregateStats на КОЖЕН запит у бюджеті 10 мс CPU, а це — додаткове читання
// KV заради блоку, який дивляться раз на тиждень.
//
// ⚠️ ПРИВАТНИЙ. Тут не «сервіс живий», а звʼязки між сном, настроєм і подачами
// конкретної людини — тобто щоденник у найщільнішій формі. Той самий auth, що
// й решта читань дашборда, і жодних CORS-заголовків.
//
// ⚠️ ТІЛЬКИ ЧИТАННЯ, БЕЗ РОЗРАХУНКУ. Рахує крон раз на тиждень (computeLevers),
// сюди приходить готовий блоб. Спокуса «якщо порожньо — порахувати на льоту»
// відкидається свідомо: саме та вартість і вигнала розрахунок із запиту.
//
// Ярлики ознак підставляються ТУТ, а не зберігаються в KV. Інакше перейменування
// підпису чекало б наступного понеділка, а сам блоб ріс би копіями рядків, які
// й так є в коді.

import { json } from './http-core.mjs';
import { checkOwnerRead } from './auth-core.mjs';
import { loadLevers } from './kv-store.mjs';
import { LEVER_FEATURES, LEVER_DOMAINS, GATE_WEEKS, USEFUL_WEEKS } from './levers-core.mjs';

/**
 * key -> {label, emoji, unit, more, less, domain, domainLabel} для підписів.
 *
 * ⚠️ Мапа, а не обʼєкт. `FEATURES['constructor']` на звичайному обʼєкті
 * правдиве через ланцюг прототипів, тож рядок із такою «ознакою» пройшов би
 * фільтр нижче й доїхав до екрана порожнім. Той самий клас, від якого в
 * stats-core.mjs живе `isSafeKey`.
 */
const FEATURE_MAP = new Map(
  LEVER_FEATURES.map((f) => [
    f.key,
    {
      label: f.label,
      emoji: f.emoji,
      unit: f.unit,
      more: f.more,
      less: f.less,
      domain: f.domain,
      domainLabel: LEVER_DOMAINS[f.domain] ?? f.domain,
    },
  ]),
);

/** Той самий вміст простим обʼєктом — рівно для серіалізації у відповідь. */
const FEATURES = Object.fromEntries(FEATURE_MAP);

/**
 * Збережений блоб -> відповідь дашборда.
 *
 * `levers: null` — це НЕ те саме, що порожній список звʼязків, і клієнт мусить
 * розрізняти: null означає «крон ще не рахував жодного разу» (свіжий деплой до
 * першого понеділка), а `ready:false` — «рахував, але даних ще замало». Злити
 * їх в одне означало б показати «потрібно ще N тижнів» там, де правильна
 * відповідь — «перший розрахунок у понеділок».
 *
 * Биті дані зводяться до null, а не до 500: блоб пише крон, і зіпсований запис
 * не має валити екран статистики — блок просто скаже, що розрахунку немає.
 *
 * @param {Env} env
 * Тип auth — МІНІМУМ, який тут справді читається (як у handleArchive).
 * @param {{ ok?: unknown, status?: number, error?: string }|null|undefined} auth
 */
export async function handleLevers(env, auth) {
  if (!auth?.ok) return json({ ok: false, error: auth?.error ?? 'auth' }, auth?.status ?? 401);

  const raw = await loadLevers(env);
  const levers = shape(raw);

  // no-store: приватне й міняється раз на тиждень — публічний кеш тут був би
  // прямою помилкою, а приватний не окупився б.
  return new Response(
    JSON.stringify({ levers, features: FEATURES, gate: GATE_WEEKS, useful: USEFUL_WEEKS }),
    {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    },
  );
}

/** Звузити збережений блоб до того, що екран справді читає. */
function shape(/** @type {KvBlob|null} */ raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.weekOf !== 'string') return null; // без мітки тижня результат нечитабельний
  const rows = Array.isArray(raw.rows) ? raw.rows : [];
  const skipped = Array.isArray(raw.skipped) ? raw.skipped : [];
  return {
    computedAt: typeof raw.computedAt === 'string' ? raw.computedAt : null,
    weekOf: raw.weekOf,
    firstWeek: typeof raw.firstWeek === 'string' ? raw.firstWeek : null,
    lastWeek: typeof raw.lastWeek === 'string' ? raw.lastWeek : null,
    ready: raw.ready === true,
    weeks: Number(raw.weeks) || 0,
    weeksNeeded: Number(raw.weeksNeeded) || 0,
    tested: Number(raw.tested) || 0,
    shown: Number(raw.shown) || 0,
    rows: rows.filter(
      (/** @type {KvBlob} */ r) => r && FEATURE_MAP.has(r.from) && FEATURE_MAP.has(r.to),
    ),
    skipped: skipped.filter((/** @type {KvBlob} */ s) => s && FEATURE_MAP.has(s.key)),
  };
}

/** Обгортка з auth для маршруту воркера.
 *  @param {Request} request
 *  @param {Env} env */
export async function handleLeversRequest(request, env) {
  // ⚠️ Гейт методу — ПЕРЕД автентифікацією й перед читанням KV. Ендпоінт
  // read-only, тож POST сюди нічого не ламає; але той самий клас уже
  // виправляли для /api/weather/locate-prompt (ревʼю PR #334), і лишати новий
  // маршрут відкритим для будь-якого дієслова означає повторювати те, від чого
  // щойно відмовились.
  if (request.method !== 'GET') return json({ ok: false, error: 'method' }, 405);
  return handleLevers(env, await checkOwnerRead(request, env));
}
