// HTTP-ендпоінти дашборда (Фаза 5, модуляризація worker.js, план A2 §5).
//
// ЩО ТУТ: усе, що Mini App викликає напряму — голос за тему, запис події,
// налаштування, сторінка «Збережене», агрегат статистики. Плюс `applyEvent` —
// СПІЛЬНЕ ядро запису події для двох джерел (Mini App і Telegram-кнопка).
//
// ІНВАРІАНТ ДОСТУПУ: читання -> checkOwnerRead, запис -> checkPrimaryOwner
// (S1/B1). Співвласник дивиться дашборд, але не змінює стан власника — і саме
// тому ці два чеки НЕ можна плутати; кожен хендлер нижче обирає свій свідомо.
//
// ІНВАРІАНТ ЗАПИСУ: усе, що торкається `stats`, іде через updateStats
// (оптимістичний read-modify-write), бо писарів у цей ключ кілька — Mini App,
// голос із чату й три 5-хвилинні крони. Прямий put тут колись уже втрачав дані.

import { json, readJsonBody } from './http-core.mjs';
import { checkOwnerRead, checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { loadStats, loadState, loadSettings, updateStats, updateState } from './kv-store.mjs';
import { applyVote, applyUrlVote, updateJobPrefs, updateMockWeight } from './prefs-core.mjs';
import {
  kyivDateKey,
  kyivHour,
  kyivMinAfter8,
  kyivMinuteOfDay,
  bedtimeBucketForHour,
} from './kyiv-time.mjs';
import {
  recordEvent,
  aggregateStats,
  pageSaved,
  checkinSlot,
  checkinSlotEndsInMin,
  checkinDateKey,
} from './stats-core.mjs';
import { normalizeSettings, connectorStatus } from './settings-core.mjs';
import { totalProgress, roadmapWeekly } from './roadmap-core.mjs';
import { masteryHints, themeOfWeek, mockMaterials, masteryTopics } from './mastery-core.mjs';

/** POST /api/vote {category, dir:'up', url?} -> preferenceWeights + інтерес.
 *  Автентифікація — заголовком X-Telegram-Init-Data (див. mutationInitData).
 *  url (C3): якщо переданий — голос дедуплюється per-url (повторний = зняти).
 *  Без url — стара поведінка (кожен клік зсуває вагу), щоб не ламати клієнтів,
 *  які url ще не шлють.
 *
 *  ⚠️ Межа «створити» vs «прочитати» (фідбек власника, п.5 — ❤️ замість 👍/👎):
 *  НОВИЙ дизлайк створити вже не можна (нижче 400 на будь-що, крім 'up'), але
 *  applyUrlVote/applyVote та recordEvent('vote') мусять і далі РОЗУМІТИ 'down' —
 *  у KV лежать старі голоси, і саме їх треба коректно відкотити, коли власник
 *  лайкне раніше дизлайкнуту новину. Викинеш 'down' із читання — відкотиш не
 *  ту дельту й тихо зіпсуєш вагу теми назавжди. */
export async function handleVote(/** @type {Request} */ request, /** @type {Env} */ env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  const body = parsedBody.body;
  const { category, dir, url } = body ?? {};
  if (typeof category !== 'string' || !category || dir !== 'up') {
    return json({ ok: false, error: 'bad-params' }, 400);
  }
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  let weight;
  /** @type {string|null} */
  let prevDir = null;
  /** @type {string|null} */
  let prevCategory = null;
  let newDir = dir;
  // Вихідні дані заповнює сам patch: при розбіжності updateState викликає його
  // вдруге, і тут лишаються значення ТІЄЇ копії, яку зрештою записали.
  await updateState(env, (s) => {
    if (typeof url === 'string' && url) {
      // Чесний облік: кожен url впливає на вагу максимум раз (C3).
      const r = applyUrlVote(s.preferenceWeights ?? {}, s.votedUrls ?? {}, url, category, dir);
      prevDir = r.prevDir;
      prevCategory = r.prevCategory;
      newDir = r.newDir;
      weight = r.weights[category];
      return { ...s, preferenceWeights: r.weights, votedUrls: r.votedUrls };
    }
    const weights = applyVote(s.preferenceWeights ?? {}, category, dir);
    weight = weights[category];
    return { ...s, preferenceWeights: weights };
  });
  // Інтерес у stats (таб «Статистика» → «твої інтереси»): знімаємо старий голос
  // з ЙОГО теми і додаємо новий до поточної (ревʼю C: той самий url може прийти
  // під іншою темою — інтерес мусить бути category-aware, як і ваги). prevCategory
  // null (без url / перший голос) -> recordEvent застосує лише новий напрямок.
  //
  // Через updateStats, а не сирий put: голос — такий самий незалежний писар
  // 'stats', як Mini App-події і три 5-хвилинні крони (B4). ❤️, що збіглося з
  // кроном, інакше тихо стирало бік, який програв гонку.
  const dateKey = kyivDateKey();
  await updateStats(env, (store) =>
    recordEvent(store, { type: 'vote', category, dir: newDir, prevDir, prevCategory }, dateKey),
  );
  return json({ ok: true, category, weight, voted: newDir });
}

/**
 * Спільне ядро запису події — і /api/event (Mini App), і Telegram-callback
 * (Блок P1) проходять через ЦЕ, щоб jobPrefs/mockWeights/stats не дублювались
 * і не розходились між двома джерелами подій.
 */
export async function applyEvent(/** @type {Env} */ env, /** @type {any} */ body) {
  // jobPrefs: памʼять скорера з живої воронки (dismiss/applied→interview→offer).
  //
  // Термінальні стадії (F1: rejected/failed) сюди СВІДОМО не входять — падають у
  // null, тобто скорер їх не бачить. Це не недогляд: jobPrefs учить скорер, що
  // подобається ВЛАСНИКУ, а відмова — рішення роботодавця. Записати «відмову» як
  // dismiss означало б учити скорер уникати саме тих вакансій, які власник хотів
  // найбільше (він же на них подався). Провал співбесіди — так само не преференція.
  const jobSignal =
    body.type === 'job_dismiss'
      ? 'dismiss'
      : body.type === 'job_stage' && ['applied', 'interview', 'offer'].includes(body.stage)
        ? body.stage
        : null;
  if (jobSignal && typeof body.title === 'string' && body.title) {
    await updateState(env, (s) => ({
      ...s,
      jobPrefs: updateJobPrefs(s.jobPrefs ?? { liked: [], disliked: [] }, jobSignal, body.title),
    }));
  }

  // mockWeights: слабкі теми самооцінки (Блок F) -> частіше в наступному батчі.
  if (
    body.type === 'mock_answer' &&
    typeof body.topic === 'string' &&
    body.topic &&
    (body.rating === 'easy' || body.rating === 'hard')
  ) {
    await updateState(env, (s) => ({
      ...s,
      mockWeights: updateMockWeight(s.mockWeights ?? {}, body.topic, body.rating),
    }));
  }

  const nowMin = body.type === 'open' ? kyivMinAfter8() : null;
  // Сон (wokeAt, case 'open') і тап «Ліг спати» (startedAt, case 'sleepStart')
  // обидва потребують ТОЧНОГО часу — recordEvent чистий (без Date.now() всередині),
  // тож рахуємо тут і передаємо явним аргументом, як і nowMin.
  const nowIso = new Date().toISOString();

  let ev = body;
  let dateKey = kyivDateKey();
  if (body.type === 'checkin') {
    // Слот і добу визначає СЕРВЕР, а не клієнт: інакше «ранковий» чек-ін можна
    // надіслати опівночі, перевівши годинник на телефоні. Клієнтський body.slot
    // ігноруємо свідомо — він тут лише підказка для UI.
    const h = kyivHour();
    const slot = checkinSlot(h);
    // Тиха зона (02:00–07:59) — жоден блок не відкритий, писати нічого.
    if (!slot) return;
    ev = { ...body, slot };
    dateKey = checkinDateKey(dateKey, h);
  } else if (body.type === 'sleepStart') {
    // Той самий зсув, що вечірній чек-ін: тап о 00:47 належить учорашньому
    // вечору, не сьогоднішній календарній добі.
    dateKey = checkinDateKey(dateKey, kyivHour());
    // Бакет "О котрій ліг?" рахуємо ТУТ (маємо kyivHour), не в stats-core —
    // recordEvent лишається без часових поясів, лише зберігає готове значення.
    ev = { ...body, bedtimeBucket: bedtimeBucketForHour(kyivHour()) };
  }

  const loaded = await loadStats(env);
  // Підтверджений блок (recordEvent, case 'checkin') ігнорує ВСІ подальші
  // правки — рахуємо це ДО запису, щоб викликач (агент, runRecordAction;
  // Mini App, handleEvent) міг чесно сказати «нічого не змінилось», а не
  // збрехати про успіх. Це лише швидкий fast-path на щойно прочитаному
  // знімку — САМА безпека (навіть якщо стан зміниться між цим читанням і
  // updateStats) лежить у recordEvent (case 'checkin' сам ігнорує confirmed).
  const checkinLocked =
    body.type === 'checkin' && !!loaded.checkins?.[dateKey]?.[ev.slot]?.confirmed;
  if (checkinLocked) return { locked: true }; // нічого не зміниться — не палимо KV-запис даремно
  await updateStats(env, (curStore) => recordEvent(curStore, ev, dateKey, nowMin, nowIso));
  if (body.type === 'checkin') return { locked: false };
}

/** POST /api/event {type, …} -> записати подію у стор статистики.
 *  locked (checkin, вже підтверджений блок) — сурфейсимо чесно, той самий
 *  контракт, що runRecordAction (агент): {ok:true} саме по собі не каже,
 *  чи запис реально відбувся. */
export async function handleEvent(/** @type {Request} */ request, /** @type {Env} */ env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);
  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  const body = parsedBody.body;
  if (typeof body?.type !== 'string') return json({ ok: false, error: 'bad-params' }, 400);
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const result = await applyEvent(env, body);
  return json({ ok: true, locked: result?.locked ?? false });
}

/**
 * Статус конекторів БЕЗ мережі: наявність GOOGLE_*-секретів + скоупи з кешу
 * `googleToken` (googleAccessToken кладе туди `scope` при обміні). Свідомо НЕ
 * викликаємо googleAccessToken(): відкриття налаштувань не повинне тягнути
 * OAuth-обмін (зайва латентність + мережева залежність на екрані, який просто
 * показує стан). Кеш ще порожній -> віддаємо за наявністю секретів.
 */
async function googleConnectors(/** @type {Env} */ env) {
  const hasGoogleCreds = Boolean(
    env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN,
  );
  let scope = null;
  if (hasGoogleCreds) {
    try {
      scope = JSON.parse((await env.BRIEFING.get('googleToken')) ?? 'null')?.scope ?? null;
    } catch {
      /* биття кешу -> скоупи невідомі, фолбек за секретами */
    }
  }
  return connectorStatus({ hasGoogleCreds, scope });
}

/**
 * GET /api/settings -> налаштування власника + статус конекторів.
 * POST /api/settings {settings} -> ЗАМІНИТИ блоб цілком (PUT-семантика).
 *
 * Свідомо БЕЗ read-modify-write. Спокуса «прочитати + накласти патч» тут
 * оманлива: KV не має ні CAS, ні гарантії read-your-writes (~до 60с), а екран
 * шле окрему мутацію НА КОЖЕН тумблер — два швидкі тапи, і обидва запити
 * читають той самий базовий блоб, після чого другий PUT тихо затирає перший.
 * Тому: єдиний писар (власник) шле ПОВНИЙ стан, який у нього вже є в кеші, а
 * сервер лише валідує й кладе. Клієнт серіалізує запити (scope у
 * useSaveSettings), тож останній тап = останній PUT.
 *
 * Тижнева ціль подач тут СВІДОМО відсутня: вона живе у блобі `stats`
 * (goal.weeklyTarget агрегується поруч із weeklyApplied) і виставляється подією
 * `set_goal` через /api/event, як решта мутацій дашборда.
 */
export async function handleSettings(/** @type {Request} */ request, /** @type {Env} */ env) {
  if (!env.TELEGRAM_BOT_TOKEN) return json({ ok: false, error: 'no-token' }, 500);

  if (request.method === 'GET') {
    const auth = await checkOwnerRead(request, env);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    const [settings, connectors] = await Promise.all([loadSettings(env), googleConnectors(env)]);
    return json({ ok: true, settings, connectors });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);

  const parsedBody = await readJsonBody(request);
  if (!parsedBody.ok) return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  const body = parsedBody.body;
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  // Вимагаємо ПОВНИЙ блоб: часткове тіло normalizeSettings мовчки добив би
  // дефолтами (тихі години злетіли б на 22:00–08:00 при перемиканні модуля).
  // Краще гучне 400, ніж тиха втрата налаштувань.
  const raw = body?.settings;
  if (!raw || typeof raw !== 'object' || !raw.quiet || !raw.modules) {
    return json({ ok: false, error: 'bad-params' }, 400);
  }
  const next = normalizeSettings(raw);
  await env.BRIEFING.put('settings', JSON.stringify(next));
  const connectors = await googleConnectors(env);
  return json({ ok: true, settings: next, connectors });
}

/**
 * GET /api/saved?offset=&limit= -> сторінка збереженого (F3).
 *
 * Окремий ендпоінт, а не поле в /api/stats: там savedList свідомо обрізаний до
 * 8 як прев'ю, і тягти повний архів (сотні записів) у КОЖНЕ відкриття апки
 * заради рядка «Ти зберіг N» — марно. Архів у KV не обрізаний ніколи; його лише
 * не показували.
 */
export async function handleSaved(/** @type {Request} */ request, /** @type {Env} */ env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  const url = new URL(request.url);
  // Кламп і дефолти — у чистій pageSaved (там же й тести).
  const page = pageSaved(await loadStats(env), {
    offset: url.searchParams.get('offset'),
    limit: url.searchParams.get('limit'),
  });
  return json({ ok: true, ...page });
}

// Ті самі локації, що config.yml locations (оркестратор) — Worker НЕ читає
// config.yml (окремий деплой, без збірки з src/), тож хардкодимо дзеркалом.
// ⚠️ Зміниш локації в config.yml -> онови й тут.

/** GET /api/stats -> агрегат для табу «Статистика». Auth власника (H1): стрік,
 *  воронка, інтереси — приватні; без initData -> 401/403 (фронт ховає таб). */
export async function handleStats(/** @type {Request} */ request, /** @type {Env} */ env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
  // Два незалежні KV-читання — паралельно (найгарячіший читальний шлях).
  const [store, state] = await Promise.all([loadStats(env), loadState(env)]);
  // Блоб: нижче до агрегату дописуються роадмеп/майстерність/голоси —
  // поля, яких aggregateStats не знає й знати не мусить.
  const stats = /** @type {KvBlob} */ (aggregateStats(store, kyivDateKey()));
  // roadmap/mastery — окремий KV-блоб (state, не stats); aggregateStats лишається
  // чистим агрегатором stats-блоба, роадмеп-контент йому знати не треба.
  const progress = state.roadmapProgress ?? {};
  stats.roadmap = totalProgress(progress);
  // Ріст роадмепу по тижнях — сурфейс уже наявних ISO-таймстемпів у progress
  // (toggleProgress їх і так пише), Майстерність показує не лише поточний %.
  stats.roadmapWeekly = roadmapWeekly(progress, kyivDateKey());
  // A4: звʼязка mock↔roadmap для дашборда — слабкі теми -> «куди вчитись»,
  // «тема тижня» -> фокус наступного mock-батчу.
  stats.mastery = {
    hints: masteryHints(stats.mock?.weakTopics ?? [], progress),
    themeOfWeek: themeOfWeek(progress, kyivDateKey()),
    // Готовність по темах: єдине місце, де «відмічено пройденим» зустрічається
    // з «як воно даються на питаннях». Обидва боки й доти були в payload, але
    // порізно — зіставити їх на клієнті було нічим, бо таблиця звʼязку
    // mock<->roadmap живе лише тут.
    topics: masteryTopics(progress, store.mockTopics),
  };
  // F4: mock-тема -> куровані матеріали роадмепу («Вивчити» в картці питання).
  // Мапа стала й крихітна (13 тем × 2 посилання) — віддаємо цілком, щоб клієнт
  // не дублював у себе таблицю звʼязку mock↔roadmap.
  stats.mockMaterials = mockMaterials();
  // Голоси per-url (C3): дашборд гідратує підсвітку ❤️ з цього, щоб після
  // переоткриття Mini App повторний тап не «знімав» невидимо активний голос
  // (ревʼю C). Віддаємо компактно {url: 'up'}, без delta/category.
  //
  // Фільтр саме на 'up' (фідбек власника, п.5): у KV лежать старі дизлайки, і
  // віддавати їх клієнту вже нема кому — кнопки 👎 не існує. Мовчки ховаємо їх
  // із READ, а не чистимо запис: votedUrls досі потрібен, щоб лайк по раніше
  // дизлайкнутій новині відкотив саме той delta, який колись застосували.
  stats.votes = Object.fromEntries(
    Object.entries(state.votedUrls ?? {})
      .filter(([, v]) => v && v.dir === 'up')
      .map(([url, v]) => [url, v.dir]),
  );
  // Активний блок чек-іну — рахує СЕРВЕР (клієнтському годиннику не віримо:
  // інакше «ранковий» блок відкривався б опівночі). Не в aggregateStats, бо той
  // чистий і години не знає; тут же — щоб клієнт не мав власної копії меж.
  const h = kyivHour();
  stats.checkinSlot = checkinSlot(h);
  // Скільки блоку лишилось жити. Клієнт тикає від цього якоря локально, а коли
  // той добігає нуля — перепитує сервер замість того, щоб вирішувати самому.
  stats.checkinSlotEndsIn = checkinSlotEndsInMin(kyivMinuteOfDay());
  // ⚠️ checkinToday мусить читатись за КЛЮЧЕМ ЧЕК-ІНУ (як пише applyEvent через
  // checkinDateKey), а не за сирим календарним днем. aggregateStats не знає
  // години, тож дає checkins[kyivDateKey()]; але о 00:00–01:59 вечірній блок
  // ще належить УЧОРАШНЬОМУ чек-ін-дню (checkinDateKey зсуває ніч до 6-ї на
  // попередню дату). Без цієї правки о 00:43 екран читав порожній новий
  // календарний день -> «ЗАПОВНЕНО 0 З 3», ранок/післяобід «пропущено», хоча
  // всі три заповнені (Статистика показує правильно — вона сканує вікно днів).
  // Удень (h>=6) ключі збігаються, тож поведінка не міняється.
  stats.checkinToday = store.checkins?.[checkinDateKey(kyivDateKey(), h)] ?? null;
  return json(stats);
}
