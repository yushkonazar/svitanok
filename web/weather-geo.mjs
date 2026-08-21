// Погода й геопозиція власника (Фаза 5, модуляризація worker.js).
//
// ЩО ТУТ: жива погода для Mini App (кеш у KV), ручний вибір міста, GPS-позиція
// з Telegram і зворотне геокодування.
//
// ЧОМУ ЦЕ ОДИН МОДУЛЬ, А НЕ ЧАСТИНА API. Геопозиція приходить ДВОМА різними
// каналами — тап «📍 Надіслати позицію» в чаті й пошук міста в дашборді, — але
// джерело правди в них ОДНЕ (`ownerGeoManual`). Тримати ці шляхи в різних
// файлах означало б майже напевно розсинхронити їх при наступній правці.
//
// ІНВАРІАНТ КЕШУ: кеш знає, ЯКА позиція в ньому лежить (`weatherLive.geo`), і
// інвалідується не лише за TTL, а й коли ефективна позиція змінилась. Інакше
// власник, який переїхав, дивився б на погоду попереднього міста ще пів години.
//
// ІНВАРІАНТ КВОТИ: денний лічильник запитів — не оптимізація, а запобіжник:
// ключ OpenWeather спільний з оркестратором, і цикл інвалідацій міг би
// вигоряти чужу квоту (реальний випадок 06.08 — 54 запити за день ручних
// перемикань локації).

import { json, readJsonBody } from './http-core.mjs';
import { checkOwnerRead, checkPrimaryOwner, mutationInitData } from './auth-core.mjs';
import { parseOneCall, mergeAqi } from './weather-core.mjs';
import { kyivDateKey } from './kyiv-time.mjs';
import { tgCall } from './telegram-client.mjs';
import { locateKeyboard, normalKeyboard } from './tg-core.mjs';

/**
 * ⚠️ ТУТ ЛИШЕ ПУБЛІЧНІ ЗНАЧЕННЯ, і це другий бік того самого виправлення, що в
 * config.yml. Доти в цьому файлі лежав ЗАШИТИЙ дубль домашніх координат — і
 * саме він робив «прибрати координати з конфігу» неповним фіксом: це не
 * документація й не приклад, а робочий код Worker'а, який щодня ходить по цих
 * точках. Село на дві тисячі людей із точністю ~1 км — адреса, не локація.
 *
 * Справжні значення приходять секретом OWNER_LOCATIONS (JSON тієї самої форми,
 * що config.yml). Немає секрету — працює цей фолбек, і погода буде по Рівному.
 */
const WEATHER_LOCATIONS_FALLBACK = [
  { lat: 49.8397, lon: 24.0297, name: 'Львів' },
  { lat: 50.6199, lon: 26.2516, name: 'Рівне' },
];

/**
 * Локації власника з секрету; фолбек — публічні обласні центри.
 *
 * Битий секрет НЕ валить запит: погода — довантаження понад основне, і впасти
 * тут означало б зачорнити дашборд через одну зіпсовану змінну. Але й тихо
 * підмінити локацію не можна — тому в лог іде явна причина.
 */
function ownerLocations(/** @type {Env} */ env) {
  const raw = (env?.OWNER_LOCATIONS ?? '').trim();
  if (!raw) return WEATHER_LOCATIONS_FALLBACK;
  try {
    const parsed = JSON.parse(raw);
    const ok =
      Array.isArray(parsed) &&
      parsed.length > 0 &&
      parsed.every(
        (/** @type {KvBlob} */ l) =>
          l &&
          typeof l.lat === 'number' &&
          typeof l.lon === 'number' &&
          typeof l.name === 'string' &&
          l.name.length > 0,
      );
    if (!ok) throw new Error('очікується непорожній масив {lat, lon, name}');
    return parsed;
  } catch (/** @type {any} */ e) {
    console.error('OWNER_LOCATIONS невалідні — працюю на публічному фолбеку:', e.message);
    return WEATHER_LOCATIONS_FALLBACK;
  }
}
const WEATHER_LIVE_TTL_MS = 30 * 60_000; // 30 хв — реальна свіжість, не «застигле» з брифінгу
// Захисний лічильник — та сама причина, що DAILY_REQUEST_LIMIT в src/modules/
// weather.ts (спільний OpenWeather-ключ/квота, реальний бюджет акаунта —
// 1000/добу), менший ліміт: тут це «скільки РАЗІВ на добу Mini App може
// оновити кеш», не «скільки запитів на локацію». Піднято з 50 (регресія,
// знайдена фідбеком власника 06.08: лічильник дійшов до 54 за звичайний
// день тестування ручної локації — кожна зміна геопозиції інвалідує кеш і
// коштує ~4 запити (2 локації × onecall+aqi), і денний ліміт вигорав
// набагато швидше, ніж закладалось при першій оцінці). 150 лишає щедрий
// запас під спільним бюджетом навіть із частими змінами локації.
const WEATHER_LIVE_DAILY_LIMIT = 150;
// ~0.02° ≈ 1-2км на широті України — навмисно грубіше за старий клієнтський
// GPS-поріг (0.01°): IP-геолокація (MaxMind через Cloudflare) сама по собі
// точна лише до міста/індексу, тож два послідовні запити з ОДНІЄЇ реальної
// точки можуть дати трохи різні координати без жодного реального переїзду —
// тонший поріг спричиняв би зайві «геопозиції відрізняються» і зайві KV-записи.
const GEO_MATCH_TOLERANCE = 0.02;

function roundGeo(/** @type {number} */ n) {
  return Math.round(n * 100) / 100;
}

/** true, якщо обидві точки «та сама позиція» (з допуском) АБО обидві null
 *  (немає жодного сигналу — трактуємо як «нічого не змінилось»). */
function sameGeo(/** @type {KvBlob|null|undefined} */ a, /** @type {KvBlob|null|undefined} */ b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    Math.abs(a.lat - b.lat) < GEO_MATCH_TOLERANCE && Math.abs(a.lon - b.lon) < GEO_MATCH_TOLERANCE
  );
}

/**
 * Геопозиція власника з Cloudflare-заголовків запиту (request.cf) — жоден
 * клієнтський дозвіл не потрібен: WebView Mini App шле HTTP-запити НАПРЯМУ з
 * пристрою власника на цей Worker (Telegram нічого не проксує), тож
 * Cloudflare бачить реальну мережу власника й на кожному запиті сам додає
 * приблизну геопозицію (по IP, рівень міста/індексу — MaxMind). Ані дозволу,
 * ані JS Geolocation/Telegram LocationManager — обидва виявились НЕНАДІЙНИМИ
 * в самому Telegram-клієнті (задокументований, невирішений баг Telegram на
 * iOS/Desktop, підтверджено власником на обох платформах), тож геолокацію
 * винесено сюди повністю: на боці Worker, поза Telegram API взагалі.
 *
 * request.cf.latitude/longitude — РЯДКИ (`string | null`), НЕ Number(null)/
 * Number('') напряму: та сама пастка, що вже задокументована в
 * checkinDateKey/kyivMinAfter8 — Number(null)===0 АЛЕ Й Number('')===0 дали б
 * хибну (0,0) на кожен запит без cf/з порожнім рядком замість null. request.cf
 * може бути ВІДСУТНІМ узагалі (локальний dev без --remote, деякі внутрішні
 * типи запитів) — null тоді, graceful.
 */
export function requestGeo(/** @type {Request} */ request) {
  const cf = request.cf;
  if (!cf) return null;
  const latRaw = cf.latitude;
  const lonRaw = cf.longitude;
  const lat = typeof latRaw === 'string' && latRaw !== '' ? Number(latRaw) : NaN;
  const lon = typeof lonRaw === 'string' && lonRaw !== '' ? Number(lonRaw) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat: roundGeo(lat), lon: roundGeo(lon) };
}

/** Зворотне геокодування (OpenWeather Geocoding API — окремий безкоштовний
 *  тір від One Call 3.0, той самий WEATHER_API_KEY). Українська назва
 *  (local_names.uk), якщо є, інакше — що дав API. null на будь-який збій —
 *  виклик graceful-деградує до дефолтного підпису, не валить живу погоду. */
export async function reverseGeocodeCity(
  /** @type {number} */ lat,
  /** @type {number} */ lon,
  /** @type {string} */ apiKey,
) {
  try {
    const url = new URL('https://api.openweathermap.org/geo/1.0/reverse');
    url.searchParams.set('lat', String(lat));
    url.searchParams.set('lon', String(lon));
    url.searchParams.set('limit', '1');
    url.searchParams.set('appid', apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = /** @type {any} */ (await res.json());
    const first = Array.isArray(data) ? data[0] : null;
    return first?.local_names?.uk ?? first?.name ?? null;
  } catch {
    return null;
  }
}

/** Пряме геокодування (та сама OpenWeather Geocoding API, інший ендпоінт) —
 *  назва міста -> координати. Фолбек-шлях для POST /api/weather/location,
 *  коли власник ввів назву руками без вибору з автозаповнення (те тепер
 *  працює з локального web/app/public/settlements.json — фідбек власника:
 *  «звичайна пошукова логіка» без мережевого запиту на кожен keystroke, див.
 *  web/scripts/gen-settlements.mjs). null на збій/порожній результат —
 *  виклик сам поверне власнику чесну 404, не впаде мовчки. */
export async function geocodeCity(/** @type {string} */ query, /** @type {string} */ apiKey) {
  try {
    const url = new URL('https://api.openweathermap.org/geo/1.0/direct');
    url.searchParams.set('q', query);
    url.searchParams.set('limit', '1');
    url.searchParams.set('appid', apiKey);
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = /** @type {any} */ (await res.json());
    const first = Array.isArray(data) ? data[0] : null;
    if (!first || !Number.isFinite(first.lat) || !Number.isFinite(first.lon)) return null;
    return { lat: first.lat, lon: first.lon, name: first.local_names?.uk ?? first.name ?? query };
  } catch {
    return null;
  }
}

/**
 * GET /api/weather -> жива погода (PR-7, фідбек власника: статична температура
 * з ранкового брифінгу вже за обідом не відповідала дійсності). Owner-gated,
 * кешовано в KV (weatherLive, ~30 хв) — той самий OpenWeather-ключ ділиться з
 * оркестратором, тож живий фетч НЕ на кожне відкриття Mini App.
 *
 * Геопозиція (Блок «Погода», фідбек власника): на КОЖЕН запит перевіряємо
 * requestGeo() і звіряємо зі збереженою (KV ownerGeo) — «сходяться» (в межах
 * ~1-2км) -> нічого не міняємо; «відрізняються» -> переписуємо на поточну й
 * зберігаємо. Це единий власник (не мультитенантний застосунок), тож його
 * геопозиція — стабільне значення, яке МОЖНА кешувати так само, як дефолтну
 * пару: кеш зберігає, ЯКА позиція в ньому лежить (weatherLive.geo), і
 * інвалідується, коли ефективна позиція змінюється, — не лише по TTL.
 */
export async function handleLiveWeather(/** @type {Request} */ request, /** @type {Env} */ env) {
  const auth = await checkOwnerRead(request, env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const nowMs = Date.now();
  const currentGeo = requestGeo(request);
  let storedGeo;
  try {
    storedGeo = JSON.parse((await env.BRIEFING.get('ownerGeo')) ?? 'null');
  } catch {
    storedGeo = null;
  }
  // «Перевірка чи сходяться геопозиції» (фідбек власника): є свіжий сигнал і
  // він ВІДРІЗНЯЄТЬСЯ від збереженого -> переписуємо й зберігаємо. Сходиться
  // (або свіжого сигналу взагалі немає, напр. локальний dev) -> лишаємо
  // збережене як є, жодного зайвого KV-запису. Пишемо ОКРЕМО від ручного
  // перевизначення нижче — авто-детекція йде своїм ходом навіть під час
  // manual override, щоб було на що впасти назад, коли власник його прибере.
  let effectiveGeo = storedGeo;
  if (currentGeo && !sameGeo(currentGeo, storedGeo)) {
    effectiveGeo = currentGeo;
    await env.BRIEFING.put('ownerGeo', JSON.stringify(currentGeo));
  }

  // Ручне перевизначення (фідбек власника): IP-геолокація (MaxMind через
  // Cloudflare) не встигає за реальним переміщенням на мобільній мережі — тож
  // коли воно є, ПОВНІСТЮ переважає авто-детекцію, незалежно від request.cf.
  let manualGeo;
  try {
    manualGeo = JSON.parse((await env.BRIEFING.get('ownerGeoManual')) ?? 'null');
  } catch {
    manualGeo = null;
  }
  if (manualGeo) effectiveGeo = { lat: manualGeo.lat, lon: manualGeo.lon };
  // Фронту для стану кнопки перевизначення потрібна лише назва — не координати.
  const manualGeoOut = manualGeo ? { name: manualGeo.name } : null;

  const hasGeo = !!effectiveGeo;

  let cached;
  try {
    cached = JSON.parse((await env.BRIEFING.get('weatherLive')) ?? 'null');
  } catch {
    cached = null;
  }
  // Кеш валідний лише якщо TTL не протух І позиція в ньому — та сама, що
  // ефективна зараз (інакше свіжий переїзд показував би застиглу погоду
  // старого міста до 30 хв).
  if (
    cached &&
    sameGeo(cached.geo ?? null, effectiveGeo) &&
    Number.isFinite(cached.fetchedAtMs) &&
    nowMs - cached.fetchedAtMs < WEATHER_LIVE_TTL_MS
  ) {
    return json({
      ok: true,
      locations: cached.locations,
      fetchedAtMs: cached.fetchedAtMs,
      manualGeo: manualGeoOut,
    });
  }

  if (!env.WEATHER_API_KEY) {
    // Немає ключа на Worker-боці (лише в GH Actions secrets, окремий деплой) —
    // graceful: фронт фолбекає на снапшот брифінгу, не показує помилку.
    return json({ ok: false, error: 'not-configured' }, 503);
  }

  const today = kyivDateKey();
  let counter;
  try {
    counter = JSON.parse((await env.BRIEFING.get('weatherLiveCounter')) ?? 'null');
  } catch {
    counter = null;
  }
  if (!counter || counter.date !== today) counter = { date: today, count: 0 };
  if (counter.count >= WEATHER_LIVE_DAILY_LIMIT) {
    // Ліміт вичерпано -> віддати наявний кеш, АЛЕ ЛИШЕ якщо він усе ще під
    // ТУ САМУ позицію (протухлий за TTL — можна, іншої позиції — ні).
    //
    // ⚠️ Регресія, знайдена фідбеком власника (06.08): обрав нову ручну
    // локацію (Рівне замість Сарни), POST успішно зберіг ownerGeoManual —
    // але денний лічильник тоді вже був вичерпаний, і цей блок віддавав
    // СТАРИЙ кеш Сарни як є, без перевірки geo. Виглядало як «нічого не
    // змінилось»: інтерфейс показував чужу погоду під виглядом свіжої.
    // Позиція розійшлась -> чесна 429, клієнт фолбекає на снапшот брифінгу
    // (WeatherBlock), а не бреше живими на вигляд даними чужого міста.
    if (cached && sameGeo(cached.geo ?? null, effectiveGeo))
      return json({
        ok: true,
        locations: cached.locations,
        fetchedAtMs: cached.fetchedAtMs,
        manualGeo: manualGeoOut,
      });
    return json({ ok: false, error: 'rate-limited' }, 429);
  }

  const todayKey = today;
  const fetchLocation = async (/** @type {KvBlob} */ loc) => {
    counter.count++;
    const oneCallUrl = new URL('https://api.openweathermap.org/data/3.0/onecall');
    oneCallUrl.searchParams.set('lat', String(loc.lat));
    oneCallUrl.searchParams.set('lon', String(loc.lon));
    oneCallUrl.searchParams.set('units', 'metric');
    oneCallUrl.searchParams.set('lang', 'ua');
    oneCallUrl.searchParams.set('exclude', 'minutely');
    // `?? ''` недосяжне: handleLiveWeather віддає 503 без ключа ще до сюди.
    oneCallUrl.searchParams.set('appid', env.WEATHER_API_KEY ?? '');
    const res = await fetch(oneCallUrl.toString());
    if (!res.ok) throw new Error(`OpenWeather HTTP ${res.status}`);
    const parsed = /** @type {KvBlob} */ (parseOneCall(await res.json(), loc.name, todayKey));
    if (!parsed) throw new Error(`порожній onecall для ${loc.name}`);

    counter.count++;
    try {
      const aqiUrl = new URL('https://api.openweathermap.org/data/2.5/air_pollution');
      aqiUrl.searchParams.set('lat', String(loc.lat));
      aqiUrl.searchParams.set('lon', String(loc.lon));
      aqiUrl.searchParams.set('appid', env.WEATHER_API_KEY ?? '');
      const aqiRes = await fetch(aqiUrl.toString());
      if (aqiRes.ok) {
        const aqi = mergeAqi(await aqiRes.json());
        if (aqi !== undefined) parsed.aqi = aqi;
      }
    } catch {
      /* AQI — довантаження понад основне; збій не валить локацію */
    }
    return parsed;
  };

  const configured = ownerLocations(env);
  let targetLocations = configured;
  if (hasGeo) {
    // Ручне перевизначення вже несе назву, яку власник підтвердив при
    // встановленні (geocodeCity) — зворотне геокодування тут зайве й може
    // повернути ІНШУ назву (напр. район замість міста), ніж очікує власник.
    let name = manualGeo?.name ?? null;
    if (!name) {
      counter.count++; // геокодування — теж запит проти спільної OpenWeather-квоти
      name = await reverseGeocodeCity(effectiveGeo.lat, effectiveGeo.lon, env.WEATHER_API_KEY);
    }
    // Перша налаштована локація зсувається у другий слот замість другої —
    // той самий 2-слотовий UI (головна температура + рядок біля UV/AQI), лише
    // інший вміст масиву.
    targetLocations = [
      { lat: effectiveGeo.lat, lon: effectiveGeo.lon, name: name ?? 'Твоя локація' },
      configured[0],
    ];
  }

  const results = await Promise.allSettled(targetLocations.map(fetchLocation));
  await env.BRIEFING.put('weatherLiveCounter', JSON.stringify(counter));

  /** @type {KvBlob[]} */
  const locations = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') locations.push(r.value);
    else console.error(`жива погода для ${targetLocations[i]?.name} впала:`, r.reason?.message);
  });

  if (locations.length === 0) {
    // Усі локації впали -> віддати старий кеш, якщо є, інакше чесна відмова
    // (клієнт фолбекає на снапшот брифінгу).
    if (cached)
      return json({
        ok: true,
        locations: cached.locations,
        fetchedAtMs: cached.fetchedAtMs,
        manualGeo: manualGeoOut,
      });
    return json({ ok: false, error: 'upstream-failed' }, 502);
  }

  await env.BRIEFING.put(
    'weatherLive',
    JSON.stringify({ locations, fetchedAtMs: nowMs, geo: effectiveGeo }),
  );
  return json({ ok: true, locations, fetchedAtMs: nowMs, manualGeo: manualGeoOut });
}

/**
 * POST /api/weather/location {city} -> ручне перевизначення геопозиції
 * (фідбек власника, продовження PR-7: IP-геолокація фізично не встигає за
 * реальним переміщенням на мобільній мережі — оператор мапить IP на місто
 * приблизно й не в реальному часі). Пряме геокодування (geocodeCity) введеної
 * назви -> {lat, lon, name} у ownerGeoManual, і ВІД ЦЬОГО МОМЕНТУ
 * handleLiveWeather повністю ігнорує request.cf, доки власник сам не прибере.
 *
 * АБО {lat, lon, name} -> явний вибір з автозаповнення (клієнт
 * шукає по web/app/public/settlements.json, координати вже відомі) —
 * геокодування пропускаємо, інакше повторний запит по одній лише назві міг
 * би повернути ІНШЕ місто, ніж власник візуально обрав (однойменні населені
 * пункти в різних областях/країнах).
 *
 * DELETE /api/weather/location -> прибрати перевизначення,
 * повернутись до авто-детекції по IP (ownerGeo лишався живим весь час).
 */
export async function handleWeatherLocation(
  /** @type {Request} */ request,
  /** @type {Env} */ env,
) {
  const parsedBody = await readJsonBody(request);
  // Тіло тут НЕ обовʼязкове (DELETE без тіла) -> биття JSON = null, як і було;
  // а от завелике тіло відкидаємо явно (S3).
  if (!parsedBody.ok && parsedBody.status === 413) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  }
  const body = parsedBody.ok ? parsedBody.body : null;

  if (request.method === 'DELETE') {
    const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
    if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);
    await env.BRIEFING.delete('ownerGeoManual');
    return json({ ok: true, manualGeo: null });
  }

  if (request.method !== 'POST') return json({ ok: false, error: 'method' }, 405);
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const hasExactPick =
    Number.isFinite(body?.lat) &&
    Number.isFinite(body?.lon) &&
    typeof body?.name === 'string' &&
    body.name.trim();

  let resolved;
  if (hasExactPick) {
    resolved = { lat: body.lat, lon: body.lon, name: body.name.trim() };
  } else {
    const city = typeof body?.city === 'string' ? body.city.trim() : '';
    if (!city) return json({ ok: false, error: 'bad-params' }, 400);
    if (!env.WEATHER_API_KEY) return json({ ok: false, error: 'not-configured' }, 503);
    resolved = await geocodeCity(city, env.WEATHER_API_KEY);
    if (!resolved) return json({ ok: false, error: 'not-found' }, 404);
  }

  const manual = {
    lat: roundGeo(resolved.lat),
    lon: roundGeo(resolved.lon),
    name: resolved.name,
    setAtMs: Date.now(),
  };
  await env.BRIEFING.put('ownerGeoManual', JSON.stringify(manual));
  return json({ ok: true, manualGeo: { name: manual.name } });
}

/**
 * POST /api/weather/locate-prompt -> тригер /locate-промпту
 * (кнопка request_location), ІНІЦІЙОВАНИЙ З MINI APP (фідбек власника:
 * «можна зробити цю кнопку тригер у самій апці?»). WebView не вміє показати
 * нативну кнопку геолокації сама — request_location існує ВИКЛЮЧНО як
 * властивість KeyboardButton у ЧАТІ (Bot API), Mini App цього не обходить.
 * Натомість Mini App просить БОТА проактивно надіслати ТОЙ САМИЙ промпт, що
 * й команда /locate (sendLocatePrompt, worker.js:handleCommand) — власник
 * тапає кнопку вже в чаті, Mini App лише скорочує шлях «не пам'ятати
 * команду», сам факт тапу все одно лишається в чаті, не тут.
 *
 * sendLocatePrompt сам шле в ПРИВАТНИЙ чат (TELEGRAM_OWNER_USER_ID) —
 * request_location недоступний у груповому чаті бота (TOPIC_ASSISTANT).
 */
export async function handleWeatherLocatePrompt(
  /** @type {Request} */ request,
  /** @type {Env} */ env,
) {
  const parsedBody = await readJsonBody(request);
  // Тіло тут НЕ обовʼязкове (DELETE без тіла) -> биття JSON = null, як і було;
  // а от завелике тіло відкидаємо явно (S3).
  if (!parsedBody.ok && parsedBody.status === 413) {
    return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  }
  const body = parsedBody.ok ? parsedBody.body : null;
  // TELEGRAM_OWNER_USER_ID гарантовано задано, якщо checkOwner пройшов —
  // allowedUserIds(env) (усередині checkOwner) сама на нього спирається,
  // тож окрема not-configured-перевірка тут була б недосяжним кодом.
  const auth = await checkPrimaryOwner(mutationInitData(request, body), env);
  if (!auth.ok) return json({ ok: false, error: auth.error }, auth.status);

  const res = await sendLocatePrompt(env);
  if (!res.ok) return json({ ok: false, error: 'telegram-failed' }, 502);
  return json({ ok: true });
}

/**
 * Шле /locate-промпт ЗАВЖДИ в приватний чат із власником — НЕ туди, звідки
 * прийшов виклик (parsed.chatId чи TELEGRAM_CHAT_ID).
 *
 * ⚠️ Регресія (фідбек власника, прод: «Не вдалося надіслати запит (502)»):
 * request_location — властивість KeyboardButton, доступна ВИКЛЮЧНО в
 * приватних чатах (Bot API); основний чат бота — форум-супергрупа з темами
 * (TOPIC_ASSISTANT), тож Telegram відхиляв sendMessage із такою
 * клавіатурою суцільно, і /locate НІКОЛИ не працював за межами приватного
 * листування. chat_id тут = TELEGRAM_OWNER_USER_ID: приватний DM із ботом
 * уже «розблокований» — власник і так писав туди (як мінімум /start).
 */
export async function sendLocatePrompt(/** @type {Env} */ env) {
  return tgCall(env, 'sendMessage', {
    chat_id: env.TELEGRAM_OWNER_USER_ID,
    text: 'Тисни кнопку нижче, щоб надіслати поточну GPS-позицію 📍',
    reply_markup: locateKeyboard(),
  });
}

/**
 * Обробити GPS-позицію з /locate (фідбек власника: IP-геолокація не
 * встигає за реальним рухом; Live Location відкинуто — фоновий дозвіл ОС +
 * 8-годинний ліміт Telegram занадто нав'язливо для одноразової звірки).
 * Той самий ownerGeoManual, що ручний пошук у Mini App (WeatherBlock) —
 * єдине джерело правди для «власник сам сказав, де він», байдуже, звідки
 * прийшла назва (тап у чаті чи вибір зі списку).
 *
 * lat/lon гарантовано скінченні числа — parseUpdate (tg-core.mjs) вже
 * відфільтрував биті координати до null ДО того, як handleCommand
 * викликає це (parsed.location взагалі не було б truthy інакше).
 */
/**
 * @param {Env} env
 * @param {KvBlob} parsed
 * @param {(text: string, extra?: KvBlob) => Promise<unknown>} sendText
 */
export async function handleLocationShare(env, parsed, sendText) {
  const { latitude: lat, longitude: lon } = parsed.location;
  const name = env.WEATHER_API_KEY
    ? ((await reverseGeocodeCity(lat, lon, env.WEATHER_API_KEY)) ?? 'Твоя локація')
    : 'Твоя локація';
  const manual = { lat: roundGeo(lat), lon: roundGeo(lon), name, setAtMs: Date.now() };
  await env.BRIEFING.put('ownerGeoManual', JSON.stringify(manual));
  return sendText(`📍 Позицію оновлено: ${name}. Погода в Mini App підхопить за кілька секунд.`, {
    reply_markup: normalKeyboard(),
  });
}
