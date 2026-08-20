// @ts-check
// Холодний архів місячних згорток.
//
// ⚠️ ЦЕ ПРО ВТРАТУ ДАНИХ, а не про майбутній графік. Стор ріже історію капами:
// чек-іни й щоденна активність — 365 діб, надійність і журнал сну — 90, тижневі
// інтереси — 26 тижнів, оцінки mock — останні 60. Тобто кожної доби щось
// найстаріше зникає НАЗАВЖДИ, і місця, де воно лишалось би бодай згорнутим, не
// існувало. Що довше відкладати архів, то більше вже не повернути.
//
// ⚠️ ЧОМУ ОКРЕМИЙ KV-КЛЮЧ, а не поле в `stats`. Гарячий блоб читається й
// ПЕРЕЗАПИСУЄТЬСЯ на кожну подію (тап чек-іну, зміна стадії, голос), тож усе,
// що в ньому лежить, коштує на кожному записі. Архів же дописується раз на добу
// кроном і читається лише тоді, коли справді просять довгий період. Тримати їх
// разом означало б платити за роки історії на кожному тапі.
//
// Читання архіву назовні (періоди «рік / усе» на екрані) — окрема задача:
// спершу має бути що читати. Тут закривається саме втрата.

import { isDateKey, dayKey, weekStartKey } from './stats-core.mjs';

/** Ключ у тому самому KV-неймспейсі, що `stats`/`state`. */
export const ARCHIVE_KEY = 'statsArchive';

const monthOf = (/** @type {string} */ dateKey) => dateKey.slice(0, 7);
const round1 = (/** @type {number} */ v) => Math.round(v * 10) / 10;

function bucket(/** @type {KvBlob} */ out, /** @type {string} */ month) {
  if (!out[month]) {
    out[month] = {
      checkinDays: 0,
      sleepAvg: null,
      energyAvg: null,
      moodAvg: null,
      dayScoreAvg: null,
      activeDays: 0,
      opens: 0,
      mock: 0,
      news: 0,
      applied: 0,
    };
  }
  return out[month];
}

const avg = (/** @type {number[]} */ xs) =>
  xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

/**
 * Стор -> {'YYYY-MM': згортка} по всіх місяцях, що ще є в живих даних.
 *
 * Свідомо небагато полів: архів має пережити роки, тож кожен зайвий показник —
 * це те, що не можна буде прибрати, не втративши сумісність із уже записаним.
 * Береться те, на що спирається довгий погляд назад: скільки заповнював, як
 * спав, яка була енергія/настрій/оцінка дня, скільки був активний і скільки
 * подавався.
 */
export function monthlyRollup(/** @type {KvBlob} */ store, /** @type {string} */ todayKey) {
  const s = store && typeof store === 'object' ? store : {};
  /** @type {KvBlob} */
  const out = {};

  const checkins = s.checkins && typeof s.checkins === 'object' ? s.checkins : {};
  /** @type {KvBlob} */
  const acc = {};
  for (const [d, rec] of Object.entries(checkins)) {
    if (!isDateKey(d) || d > todayKey || !rec || typeof rec !== 'object') continue;
    const m = monthOf(d);
    bucket(out, m).checkinDays++;
    if (!acc[m]) acc[m] = { sleep: [], energy: [], mood: [], score: [] };
    const a = acc[m];
    if (typeof rec.morning?.sleepH === 'number') a.sleep.push(rec.morning.sleepH);
    if (typeof rec.evening?.dayScore === 'number') a.score.push(rec.evening.dayScore);
    for (const slot of ['morning', 'afternoon', 'evening']) {
      if (typeof rec[slot]?.energy === 'number') a.energy.push(rec[slot].energy);
      if (typeof rec[slot]?.mood === 'number') a.mood.push(rec[slot].mood);
    }
  }
  for (const [m, a] of Object.entries(acc)) {
    const b = out[m];
    b.sleepAvg = avg(a.sleep);
    b.energyAvg = avg(a.energy);
    b.moodAvg = avg(a.mood);
    b.dayScoreAvg = avg(a.score);
  }

  const days = s.days && typeof s.days === 'object' ? s.days : {};
  for (const [d, v] of Object.entries(days)) {
    if (!isDateKey(d) || d > todayKey || !v || typeof v !== 'object') continue;
    const b = bucket(out, monthOf(d));
    b.activeDays++;
    b.opens += Number(v.opens) || 0;
    b.mock += Number(v.mock) || 0;
    b.news += Number(v.news) || 0;
  }

  for (const a of Array.isArray(s.appliedLog) ? s.appliedLog : []) {
    const ts = typeof a === 'string' ? a : a?.ts;
    if (!isDateKey(ts) || ts > todayKey) continue;
    bucket(out, monthOf(ts)).applied++;
  }

  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Злити свіжий зріз у вже записаний архів.
 *
 * ⚠️ ГОЛОВНЕ ПРАВИЛО: уже записаний МИНУЛИЙ місяць не перераховується НІКОЛИ.
 * Його дані вже частково поза ретеншеном, тож свіжий перерахунок побачить лише
 * огризок — і тихо замінив би повний місяць на гірший. Поточний місяць,
 * навпаки, перераховується щодня: він ще росте.
 *
 * Наслідок, з яким треба жити свідомо: якщо згортка колись рахуватиметься
 * інакше, старі місяці лишаться порахованими по-старому. Це чесніша ціна, ніж
 * втрата даних, і саме тому набір полів тут навмисно вузький.
 */
export function mergeArchive(
  /** @type {KvBlob} */ prevArchive,
  /** @type {KvBlob} */ fresh,
  /** @type {string} */ todayKey,
) {
  const prev = prevArchive && typeof prevArchive === 'object' ? prevArchive : {};
  const current = monthOf(todayKey);
  const out = { ...prev };
  for (const [month, rollup] of Object.entries(fresh ?? {})) {
    if (month !== current && Object.prototype.hasOwnProperty.call(prev, month)) continue;
    out[month] = rollup;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Місяць «сьогодні» за київським ключем доби — для тестів і крону. */
export function currentMonth(/** @type {string} */ todayKey) {
  return monthOf(isDateKey(todayKey) ? todayKey : dayKey(new Date()));
}

// ─────────────────────────────────────────────────────────────────────────────
// ТИЖНЕВИЙ АРХІВ
//
// ⚠️ ОКРЕМИЙ КЛЮЧ, а не поле в місячному. Три причини, і кожної окремо
// достатньо:
//   1. уже записаний місячний архів має формат {'YYYY-MM': згортка} на
//      ВЕРХНЬОМУ рівні; додати туди контейнер тижнів означало б або зламати
//      цей формат, або покластися на те, що всі читачі коректно фільтрують
//      нетипові ключі;
//   2. читачі різні: місяці малює «Історія», тижні потрібні «Важелям», і
//      вантажити одне заради іншого немає причин;
//   3. тижнів у десять разів більше, тобто ключ росте помітно швидше.
//
// ⚠️ НАВІЩО ВЗАГАЛІ ТИЖНІ, якщо є місяці. Місячні середні НЕ ГОДЯТЬСЯ для
// пошуку звʼязків між доменами: дванадцять точок на рік — це вибірка, на якій
// жодна кореляція не витримає поправки. Тижні дають 52 точки на рік, і саме на
// них рахується лаговий звʼязок «цього тижня X -> наступного Y».
//
// А головне — ці ряди ЗНИКАЮТЬ. Тижневі інтереси живуть 26 тижнів, чек-іни 365
// діб; усе, що старше, вже не відновити нізвідки. Тому тижневий рівень пишеться
// зараз, а не тоді, коли зʼявиться графік.
// ─────────────────────────────────────────────────────────────────────────────

export const WEEKLY_ARCHIVE_KEY = 'statsArchiveWeekly';

/** 10 років тижнів. Не «безмежно»: KV тримає 25 МіБ на значення, і межа має
 *  бути ОГОЛОШЕНА, а не з'ясована в день, коли запис перестане вміщатись. */
export const WEEKLY_ARCHIVE_CAP = 520;

/** ISO-понеділок доби.
 *
 * ⚠️ Береться зі stats-core, а НЕ пишеться тут заново. Перша версія цього файлу
 * мала власну копію — арифметично вона збігалась (перевірено на 1000 добах), і
 * саме тому була небезпечною: розійшлися б вони не сьогодні, а через рік, від
 * однієї правки в одному з двох місць, і архів мовчки почав би класти дані під
 * чужі ключі. Той самий клас, що вже ловили з `days`, `pluralUk` і назвою
 * KV-ключа publicStatus.
 *
 * Тижневі кошики інтересів (bumpInterest) уже кейзяться саме цим ключем, тож
 * збіг тут не косметичний: два рівні одних даних мусять індексуватись однаково. */
const weekOf = weekStartKey;

/**
 * Стор -> {'YYYY-MM-DD' (понеділок): згортка} по всіх тижнях у живих даних.
 *
 * Набір полів ТОЙ САМИЙ, що в місячній згортці, і це навмисно: два рівні одного
 * архіву з різними полями — це два формати, які розійдуться при першій же
 * правці. Плюс споживач може рахувати на них однаковим кодом.
 */
export function weeklyRollup(/** @type {KvBlob} */ store, /** @type {string} */ todayKey) {
  const s = store && typeof store === 'object' ? store : {};
  /** @type {KvBlob} */
  const out = {};

  const checkins = s.checkins && typeof s.checkins === 'object' ? s.checkins : {};
  /** @type {KvBlob} */
  const acc = {};
  for (const [d, rec] of Object.entries(checkins)) {
    if (!isDateKey(d) || d > todayKey || !rec || typeof rec !== 'object') continue;
    const w = weekOf(d);
    bucket(out, w).checkinDays++;
    if (!acc[w]) acc[w] = { sleep: [], energy: [], mood: [], score: [] };
    const a = acc[w];
    if (typeof rec.morning?.sleepH === 'number') a.sleep.push(rec.morning.sleepH);
    if (typeof rec.evening?.dayScore === 'number') a.score.push(rec.evening.dayScore);
    for (const slot of ['morning', 'afternoon', 'evening']) {
      if (typeof rec[slot]?.energy === 'number') a.energy.push(rec[slot].energy);
      if (typeof rec[slot]?.mood === 'number') a.mood.push(rec[slot].mood);
    }
  }
  for (const [w, a] of Object.entries(acc)) {
    const b = out[w];
    b.sleepAvg = avg(a.sleep);
    b.energyAvg = avg(a.energy);
    b.moodAvg = avg(a.mood);
    b.dayScoreAvg = avg(a.score);
  }

  const days = s.days && typeof s.days === 'object' ? s.days : {};
  for (const [d, v] of Object.entries(days)) {
    if (!isDateKey(d) || d > todayKey || !v || typeof v !== 'object') continue;
    const b = bucket(out, weekOf(d));
    b.activeDays++;
    b.opens += Number(v.opens) || 0;
    b.mock += Number(v.mock) || 0;
    b.news += Number(v.news) || 0;
  }

  for (const a of Array.isArray(s.appliedLog) ? s.appliedLog : []) {
    const ts = typeof a === 'string' ? a : a?.ts;
    if (!isDateKey(ts) || ts > todayKey) continue;
    bucket(out, weekOf(ts)).applied++;
  }

  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Злити свіжий тижневий зріз у записаний архів.
 *
 * Те саме правило, що в місячному: минулий ТИЖДЕНЬ не перераховується, поточний
 * оновлюється щодня. Плюс кап — найстаріші тижні відпадають, коли їх стає
 * більше за WEEKLY_ARCHIVE_CAP.
 */
export function mergeWeekly(
  /** @type {KvBlob} */ prevArchive,
  /** @type {KvBlob} */ fresh,
  /** @type {string} */ todayKey,
) {
  const prev = prevArchive && typeof prevArchive === 'object' ? prevArchive : {};
  const current = weekOf(isDateKey(todayKey) ? todayKey : dayKey(new Date()));
  const out = { ...prev };
  for (const [week, rollup] of Object.entries(fresh ?? {})) {
    if (week !== current && Object.prototype.hasOwnProperty.call(prev, week)) continue;
    out[week] = rollup;
  }
  const sorted = Object.entries(out).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(sorted.slice(-WEEKLY_ARCHIVE_CAP));
}
