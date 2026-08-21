// Київський час — чисті функції над Intl (Фаза 5, модуляризація worker.js).
//
// НАВІЩО ОКРЕМИЙ МОДУЛЬ. Ці чотири функції — фундамент КОЖНОГО часового рішення
// Worker'а: вікно брифінгу, тихі години, слот чек-іну, бакет «о котрій ліг»,
// дедуплікація за добу. Досі вони жили посеред 5000 рядків I/O, і єдиний спосіб
// їх перевірити був через HTTP-виклик усього воркера.
//
// ⚠️ ЖОДНОГО ручного зсуву годин. Київ — це UTC+2 взимку і UTC+3 влітку, тож
// `+3` у коді ламався б двічі на рік. Усе рахує Intl із timeZone:'Europe/Kyiv';
// саме тому функції беруть Date, а не «години».

/** Київська година (0..23) зараз, з урахуванням DST через Intl. */
export function kyivHour(now = new Date()) {
  const h = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    hour12: false,
  }).format(now);
  return Number(h);
}

/** Київська дата "YYYY-MM-DD" (для порівняння «свіжості» брифінгу). */
export function kyivDateKey(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Години+хвилини київського часу як пара чисел (спільне для двох функцій нижче).
 * @param {Date} now
 */
function kyivHourMinute(now) {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Kyiv',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  return {
    h: Number(p.find((x) => x.type === 'hour')?.value),
    m: Number(p.find((x) => x.type === 'minute')?.value),
  };
}

/** Хвилини після 08:00 Київ зараз (метрика «час до відкриття»); поза ранком -> null. */
export function kyivMinAfter8(now = new Date()) {
  const { h, m } = kyivHourMinute(now);
  const mins = h * 60 + m - 480;
  return mins >= 0 && mins <= 720 ? mins : null;
}

/** Хвилина київської доби (0..1439) — для вікна тихих годин (F2). */
export function kyivMinuteOfDay(now = new Date()) {
  const { h, m } = kyivHourMinute(now);
  return h * 60 + m;
}

/** Бакет "О котрій ліг?" (той самий enum, що BEDTIME_BUCKETS/CHECKIN_FIELDS.
 *  morning.bedtime) із київської ГОДИНИ тапу «Ліг спати».
 *
 * ⚠️ Регресія, знайдена реальним HTTP-тестом (worker-sleep-wake.test.ts):
 * стара умова `h < 23` стояла ПЕРШОЮ й ловила ВСІ години 0-22 (0<23 і 1<23
 * теж істинні), тож гілки `h===0`/`h===1` і фолбек 'late' були мертвим кодом
 * — тап після півночі (01:15, 03:00…) завжди писав 'e23' («лягли раніше
 * 23:00») замість коректного пізнього бакета. Підтверджено на прод-KV: запис
 * від 2026-08-04T22:56:40Z (01:56 Київ) мав bedtimeBucket:"e23". Порядок
 * перевірок тепер — точні години СПЕРШУ, `h<23` — лише фолбек для 20-22. */
export function bedtimeBucketForHour(/** @type {number} */ h) {
  if (h === 23) return 'e00';
  if (h === 0) return 'e01';
  if (h === 1) return 'e02';
  if (h >= 2 && h <= 5) return 'late';
  return 'e23'; // 20, 21, 22 (і будь-що поза реалістичним діапазоном тапу)
}
