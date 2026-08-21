import type { CheckinDay, CheckinRaw, CheckinSlot } from '../api/schema.ts';
import {
  BLOCKER_LABEL,
  HELPER_LABEL,
  LATE_REASON_LABEL,
  MOVED_LABEL,
  NIGHT_REASON_LABEL,
  PACE_LABEL,
  WITH_WHOM_LABEL,
  labelOf,
} from './checkinLabels.ts';

// Карта станів: розбір гарячого вікна чек-інів на зрізи «енергія×настрій».
//
// НАВІЩО ОКРЕМИЙ МОДУЛЬ, а не всередині StateMatrix.tsx: тут живе вся
// арифметика карти, і вона мусить бути покрита кореневим vitest без DOM.
// Компоненту лишається рендер.
//
// ⚠️ ГОЛОВНЕ РІШЕННЯ ЦЬОГО ФАЙЛУ — зріз ЗНАЄ свій слот і свою дату. Доти
// сітка читала energyCurve/moodCurve з checkinSeries і зсипала ранок, день і
// вечір в одну купу: «енергія 2 · настрій 2» вранці (недоспав) і ввечері
// (виснажився за день) ставали одним числом в одній клітинці. Це два різні
// явища з різними причинами — і саме слот робить майбутній звʼязок із
// причинами чесним, бо в ранковому записі лежить сон і час відбою, а у
// вечірньому — блокери, помічники й оцінка дня.

export type SlotFilter = 'all' | CheckinSlot;

// `id`, а не `key` — форма готова прямо для <Segmented>, без перекладання.
// Підписи словами, не самими емодзі: кнопка з одним 🌅 нечитабельна з
// екранного читача, і на дрібному екрані емодзі не пояснює, ранок це чи схід.
export const SLOT_FILTERS: ReadonlyArray<{ id: SlotFilter; label: string }> = [
  { id: 'all', label: 'Усі' },
  { id: 'morning', label: '🌅 Ранок' },
  { id: 'afternoon', label: '☀️ День' },
  { id: 'evening', label: '🌙 Вечір' },
];

const SLOTS: readonly CheckinSlot[] = ['morning', 'afternoon', 'evening'];

/** Один зріз стану: пара «енергія×настрій» із відомим слотом і датою. */
export interface StateReading {
  d: string;
  slot: CheckinSlot;
  energy: number;
  mood: number;
}

const snap = (v: number) => Math.min(5, Math.max(1, Math.round(v)));

/**
 * Усі зрізи вікна, за зростанням дати.
 *
 * Зріз існує, ЛИШЕ коли є обидва виміри: пад дає їх одним тапом, тож половина
 * пари означає биті чи легасі дані, а не «настрій без енергії». Домалювати
 * відсутню вісь нулем — і клітинка на краю сітки набрала б ваги з нічого.
 */
export function readingsOf(raw: CheckinRaw, filter: SlotFilter): StateReading[] {
  const wanted = filter === 'all' ? SLOTS : [filter];
  const out: StateReading[] = [];
  for (const d of Object.keys(raw.records).sort()) {
    const rec = raw.records[d];
    if (!rec) continue;
    for (const slot of wanted) {
      const s = rec[slot];
      if (typeof s?.energy !== 'number' || typeof s?.mood !== 'number') continue;
      out.push({ d, slot, energy: snap(s.energy), mood: snap(s.mood) });
    }
  }
  return out;
}

/**
 * Сітка 5×5 з лічильниками.
 *
 * Геометрія НАВМИСНО повторює AffectPad (введення чек-іну): енергія вгору,
 * настрій вправо, тож [0][0] — «виснажений і в поганому настрої» вгорі-ліворуч
 * за енергією, а рахунок рядків іде згори. Тапаєш по тій самій сітці, по якій
 * відповідаєш.
 */
export function gridOf(readings: StateReading[]): { grid: number[][]; max: number; n: number } {
  const grid: number[][] = Array.from({ length: 5 }, () => Array(5).fill(0));
  for (const r of readings) grid[5 - r.energy]![r.mood - 1]! += 1;
  // max=1 на порожньому: інтенсивність кольору ділиться на нього, і нуль дав
  // би NaN у color-mix, тобто прозорі клітинки замість порожньої сітки.
  return { grid, max: Math.max(1, ...grid.flat()), n: readings.length };
}

/* ── Період ────────────────────────────────────────────────────────────────
   ⚠️ ФІЛЬТР УМІЄ ЛИШЕ ЗВУЖУВАТИ, і це не спрощення, а межа даних. Сервер
   віддає 90 діб — стелю, яку задає CPU-бюджет воркера (10 мс на запит,
   лінійно з історією). Глибших даних на клієнті просто немає, тож «рік» або
   «усе» тут зʼявитись не можуть: кнопка, яка обіцяє період, а показує ті самі
   90 діб, гірша за її відсутність. Довші періоди чекають на місячні згортки
   в холодному ключі — тоді до цього самого перемикача додасться ще пункт. */

/** Опції періоду; значення підставляє екран із оголошених сервером вікон. */
export interface PeriodOption {
  days: number;
  label: string;
}

/**
 * Звузити гаряче вікно до останніх `days` діб.
 *
 * Разом із записами звужується й ОГОЛОШЕНА глибина (days/from): підпис
 * малюється саме з неї, і якби вона лишалась 90, перемикач «30 діб» показував
 * би тридцятиденні дані під дев'яностоденним заголовком.
 */
export function narrowWindow(raw: CheckinRaw, days: number): CheckinRaw {
  if (days >= raw.days) return raw;
  const from = shiftKey(raw.to, -(days - 1));
  const records: CheckinRaw['records'] = {};
  for (const [k, v] of Object.entries(raw.records)) if (k >= from) records[k] = v;
  return { days, from, to: raw.to, records };
}

function shiftKey(dateKey: string, delta: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return dateKey;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/* ── Причини стану ─────────────────────────────────────────────────────────
   Питання, заради якого все й робилось: «я часто буваю ось у цьому стані —
   а що з ним поруч?».

   ⚠️ ЦЕЙ БЛОК ЛЕГКО ЗРОБИТИ БРЕХЛИВИМ, і брехня тут виглядатиме як аналітика.
   «У цих вечорах утома траплялась удвічі частіше» на трьох зрізах — монетка,
   але читається як висновок і підштовхує до рішень. Тому:
     • ДАТИ показуються завжди — це факт, а не висновок;
     • ПРИЧИНИ — лише від CAUSE_MIN_N зрізів, і той самий поріг, що вже стоїть
       на кореляціях чек-іну в stats-core (CORR_MIN_N=8), а не власний;
     • замало в клітинці -> рахуємо по ЗОНІ сусідніх станів і ЯВНО це пишемо;
     • замало навіть у зоні -> причин немає взагалі.

   Арифметика клітинки проти цього: 90 діб × один слот ÷ 25 клітинок ≈ 3.6
   зрізи на клітинку. Тобто фолбек на зону — не рідкісний випадок, а типовий,
   і саме тому він мусить бути підписаний, а не мовчазний. */

/** Той самий поріг, що CORR_MIN_N у stats-core: нижче — не порівнюємо. */
export const CAUSE_MIN_N = 8;

/** Скільки разів факт мусить трапитись, щоб узагалі йти в розрахунок. */
const FACT_MIN_HITS = 3;

/** У скільки разів має відрізнятись від норми, щоб це не був шум округлення. */
const LIFT_THRESHOLD = 1.5;

/** Скільки причин показуємо: далі йде хвіст, який ніхто не читає. */
const MAX_CAUSES = 6;

export interface CauseRow {
  key: string;
  label: string;
  /** Скільки зрізів вибірки мають цей факт. */
  n: number;
  /** Розмір вибірки. */
  of: number;
  /** n/of — сира частка, для підпису. */
  share: number;
  /** Частка того самого факту в РЕШТІ зрізів — з чим порівнюємо. */
  baseShare: number;
  /** У скільки разів частіше (>1) або рідше (<1) за норму. */
  lift: number;
}

export interface CellDetail {
  /** Зрізи САМЕ цієї клітинки — завжди, за будь-якого n. */
  readings: StateReading[];
  /** По чому пораховані причини. */
  scope: 'cell' | 'zone' | 'none';
  /** Розмір вибірки, на якій пораховані причини. */
  n: number;
  causes: CauseRow[];
  /** Середня оцінка дня цих діб проти решти; null, коли оцінок немає. */
  dayScore: { avg: number; base: number; n: number } | null;
}

const bucket = (v: number, lo: number, hi: number, names: [string, string, string]) =>
  v < lo ? names[0] : v >= hi ? names[2] : names[1];

/**
 * Що спостережно в записі ОДНОГО слоту.
 *
 * ⚠️ Тільки свій слот — і це головне обмеження чесності всієї фічі. Пад
 * «енергія×настрій» питається тричі на добу, і поруч із кожним разом лежить
 * СВІЙ контекст: уранці сон і час відбою, удень темп і компанія, увечері
 * блокери, помічники й рух. Взяти вечірню втому як причину РАНКОВОГО стану
 * означало б пояснювати ранок тим, що сталося після нього.
 *
 * «Нічого» (none) не факт: це свідома відповідь «перешкод не було», а не
 * причина. Порахувати її як причину — те саме, що вважати тишу звуком.
 */
export function factsOf(rec: CheckinDay | undefined, slot: CheckinSlot): string[] {
  const out: string[] = [];
  if (!rec) return out;
  if (slot === 'morning') {
    const m = rec.morning;
    if (!m) return out;
    if (typeof m.sleepH === 'number') {
      out.push(`sleep:${bucket(m.sleepH, 6, 8, ['short', 'mid', 'long'])}`);
    }
    if (typeof m.sleepQ === 'number') {
      if (m.sleepQ <= 2) out.push('sleepQ:bad');
      else if (m.sleepQ >= 4) out.push('sleepQ:good');
    }
    if (m.bedtime) {
      out.push(
        `bedtime:${m.bedtime === 'e23' ? 'early' : m.bedtime === 'e02' || m.bedtime === 'late' ? 'late' : 'mid'}`,
      );
    }
    if (m.lateReason) out.push(`late:${m.lateReason}`);
    if (typeof m.worryAM === 'number' && m.worryAM >= 4) out.push('worry:high');
    // ⚠️ «Скільки засинав» доти збиралось, валідувалось і живило індекс
    // RECOVERY — але в ПРИЧИНАХ клітинки не зʼявлялось ніколи. Тобто модель
    // ним користувалась, а пояснити стан ним було неможливо. Це третій
    // незалежний факт про сон (ліг / засинав / проспав), і саме він
    // відрізняє «мало спав» від «довго не міг заснути».
    if (m.sleepLatency === 'slow' || m.sleepLatency === 'vslow') out.push('latency:slow');
    else if (m.sleepLatency === 'fast') out.push('latency:fast');
    // ⚠️ ЩЕ ПʼЯТЬ ПОЛІВ, які живили «Індекс дня» і НЕ ВМІЛИ пояснити жодну
    // клітинку. Це та сама прогалина, що вже закривалась для sleepLatency й
    // румінації, — просто ширша: поле, чий єдиний споживач — одне зведене
    // число, з погляду власника не відповідає ні на що. Пороги ті самі, що в
    // сусідів (≤2 / ≥4), а середина шкали нічого не характеризує й факту не дає.
    //
    // 'slept' у факти не йде НАВМИСНО: це норма, а норма нічого не вирізняє.
    if (m.sleepKind === 'none' || m.sleepKind === 'naps') out.push(`night:${m.sleepKind}`);
    // Причина зіпсованої ночі — мультивибір, тож КОЖНА причина окремий факт
    // (той самий принцип, що блокери). Саме вона, а не сам факт, відрізняє
    // «доробляв проєкт» від «не міг заснути».
    for (const r of m.nightReason ?? []) out.push(`nightwhy:${r}`);
    if (m.awakenings === 'few' || m.awakenings === 'many') out.push('awake:many');
    else if (m.awakenings === 'no') out.push('awake:no');
    if (typeof m.bodyFeel === 'number') {
      if (m.bodyFeel <= 2) out.push('body:bad');
      else if (m.bodyFeel >= 4) out.push('body:good');
    }
    if (typeof m.dayLoad === 'number') {
      if (m.dayLoad >= 4) out.push('load:high');
      else if (m.dayLoad <= 2) out.push('load:low');
    }
    if (typeof m.dayControl === 'number') {
      if (m.dayControl >= 4) out.push('control:high');
      else if (m.dayControl <= 2) out.push('control:low');
    }
    if (m.movePlan === 'workout' || m.movePlan === 'active') out.push('moveplan:yes');
    else if (m.movePlan === 'none') out.push('moveplan:no');
    return out;
  }
  if (slot === 'afternoon') {
    const a = rec.afternoon;
    if (!a) return out;
    if (a.pace) out.push(`pace:${a.pace}`);
    if (a.withWhom) out.push(`with:${a.withWhom}`);
    if (typeof a.rushed === 'number' && a.rushed >= 4) out.push('rushed:high');
    // Три обідні поля з тією самою прогалиною: доти вони існували лише всередині
    // індексів. «Збивали постійно» пояснює провал по обіді краще за будь-який
    // вечірній блокер — саме тому, що воно з ТОГО САМОГО часу доби, що й зріз.
    if (a.interrupted === 'many') out.push('interrupted:many');
    else if (a.interrupted === 'none') out.push('interrupted:none');
    if (a.mainProgress === 'none') out.push('progress:none');
    else if (a.mainProgress === 'most' || a.mainProgress === 'half') out.push('progress:good');
    if (a.outdoorNow) out.push(`outnow:${a.outdoorNow}`);
    return out;
  }
  const e = rec.evening;
  if (!e) return out;
  for (const b of e.blocker ?? []) if (b !== 'none') out.push(`blocker:${b}`);
  for (const h of e.helper ?? []) if (h !== 'none') out.push(`helper:${h}`);
  if (e.moved) out.push(`moved:${e.moved}`);
  if (e.kept) out.push(`kept:${e.kept}`);
  if (e.detached) out.push(`detached:${e.detached}`);
  if (e.screen === 'high' || e.screen === 'vhigh') out.push('screen:high');
  if (typeof e.focusQuality === 'number') {
    if (e.focusQuality <= 2) out.push('focus:low');
    else if (e.focusQuality >= 4) out.push('focus:high');
  }
  if (e.outdoor) out.push(`outdoor:${e.outdoor}`);
  // ⚠️ Та сама прогалина, що з sleepLatency: обидва поля живили модель, але не
  // могли пояснити жодну клітинку. А це найцінніші кандидати в причини — вони
  // про ГОЛОВУ, а не про обставини: «крутиться в голові» й «керував я, а не
  // обставини» пояснюють важкий вечір там, де блокери мовчать.
  //
  // Пороги ті самі, що в сусідів (≤2 / ≥4) — вихід за них і є сигналом, а
  // середина шкали нічого не характеризує.
  if (typeof e.rumination === 'number') {
    if (e.rumination >= 4) out.push('rumination:high');
    else if (e.rumination <= 2) out.push('rumination:low');
  }
  if (typeof e.autonomy === 'number') {
    if (e.autonomy >= 4) out.push('autonomy:high');
    else if (e.autonomy <= 2) out.push('autonomy:low');
  }
  // Останнє поле, чиїм єдиним споживачем лишалась вага 0.4 всередині
  // «Відновлення». Три чашки — це вже режим доби, а не деталь.
  if (typeof e.caffeine === 'number') {
    if (e.caffeine >= 3) out.push('caffeine:high');
    else if (e.caffeine === 0) out.push('caffeine:none');
  }
  return out;
}

const SLEEP_LABEL: Record<string, string> = {
  short: '🛌 Спав менше 6 год',
  mid: '🛌 Спав 6–8 год',
  long: '🛌 Спав 8+ год',
};
const BEDTIME_LABEL: Record<string, string> = {
  early: '🌙 Ліг до 23',
  mid: '🌙 Ліг 23–01',
  late: '🌙 Ліг після 01',
};
const KEPT_LABEL: Record<string, string> = {
  yes: '🎯 Зробив заплановане',
  partly: '🎯 Зробив частково',
  changed: '🔄 Свідомо змінив плани',
  no: '🎯 Не зробив запланованого',
};
const DETACHED_LABEL: Record<string, string> = {
  yes: '🧠 Відпустив думки про роботу',
  partly: '🧠 Відпустив частково',
  no: '🧠 Не відпускало',
};
const OUTDOOR_LABEL: Record<string, string> = {
  none: '🚪 Не виходив',
  short: '🚪 До години надворі',
  long: '🚪 Годину+ надворі',
};
/** Той самий вимір, що OUTDOOR_LABEL, але зріз на обід — і підпис мусить це
 *  казати, інакше два різні факти доби читаються як один. */
const OUTNOW_LABEL: Record<string, string> = {
  none: '🚪 До обіду не виходив',
  short: '🚪 До обіду коротко надворі',
  long: '🚪 До обіду годину+ надворі',
};
const PLAIN_LABEL: Record<string, string> = {
  'sleepQ:bad': '😖 Погано спалось',
  'sleepQ:good': '😌 Добре спалось',
  'worry:high': '😰 Тривожний ранок',
  'rushed:high': '⏱ Поспішав',
  'screen:high': '📱 Багато екрана',
  'focus:low': '🌫 Розсіяний фокус',
  'focus:high': '🎯 Глибокий фокус',
  // Три факти, що доти живили модель, але не вміли пояснити жодну клітинку.
  'latency:slow': '🛏 Довго не міг заснути',
  'latency:fast': '🛏 Заснув одразу',
  'rumination:high': '🌀 Крутилось у голові',
  'rumination:low': '🌀 Голова чиста',
  'autonomy:high': '🎛 День був мій',
  'autonomy:low': '🎛 Вели обставини',
  // Девʼять полів, що доти вміли лише додати ваги в одне зведене число.
  'night:none': '🌑 Ніч без сну',
  'night:naps': '🌒 Спав уривками',
  'awake:many': '😵 Ніч рвалась',
  'awake:no': '😴 Проспав без пробуджень',
  'body:bad': '🦴 Тіло розбите',
  'body:good': '🦴 Тіло легке',
  'load:high': '📅 День був щільний',
  'load:low': '📅 День був порожній',
  'control:high': '🎚 Зранку день здавався своїм',
  'control:low': '🎚 Зранку день здавався чужим',
  'moveplan:yes': '🏃 Планував рух',
  'moveplan:no': '🏃 Руху не планував',
  'interrupted:many': '📢 Збивали постійно',
  'interrupted:none': '📢 Ніхто не збивав',
  'progress:none': '🐌 До обіду нічого',
  'progress:good': '⚡ До обіду половина+',
  'caffeine:high': '☕ Три чашки+',
  'caffeine:none': '☕ Без кофеїну',
};

/** Людський підпис факту. Невідомий ключ віддається як є — видно, а не зникає. */
export function causeLabel(key: string): string {
  if (PLAIN_LABEL[key]) return PLAIN_LABEL[key];
  const [kind, value = ''] = key.split(':');
  switch (kind) {
    case 'sleep':
      return labelOf(SLEEP_LABEL, value);
    case 'bedtime':
      return labelOf(BEDTIME_LABEL, value);
    case 'late':
      return `🌙 ${labelOf(LATE_REASON_LABEL, value)}`;
    case 'nightwhy':
      return `🌑 ${labelOf(NIGHT_REASON_LABEL, value)}`;
    case 'pace':
      return labelOf(PACE_LABEL, value);
    case 'with':
      return labelOf(WITH_WHOM_LABEL, value);
    case 'blocker':
      return `🚧 ${labelOf(BLOCKER_LABEL, value)}`;
    case 'helper':
      return `✨ ${labelOf(HELPER_LABEL, value)}`;
    case 'moved':
      return labelOf(MOVED_LABEL, value);
    case 'kept':
      return labelOf(KEPT_LABEL, value);
    case 'detached':
      return labelOf(DETACHED_LABEL, value);
    case 'outdoor':
      return labelOf(OUTDOOR_LABEL, value);
    case 'outnow':
      return labelOf(OUTNOW_LABEL, value);
    default:
      return key;
  }
}

const gridPos = (r: StateReading) => ({ row: 5 - r.energy, col: r.mood - 1 });

/**
 * Деталі клітинки: які це доби й що їх відрізняє.
 *
 * Зона — сусідство 3×3 навколо клітинки («схожі стани»), а не квадрант: межа
 * квадранта проходить посеред шкали, і клітинки по різні боки від неї бувають
 * ближчі одна до одної, ніж до власного кута.
 */
export function cellDetail(
  raw: CheckinRaw,
  filter: SlotFilter,
  cell: { energy: number; mood: number },
): CellDetail {
  const all = readingsOf(raw, filter);
  const target = { row: 5 - cell.energy, col: cell.mood - 1 };
  const inCell = all.filter((r) => {
    const p = gridPos(r);
    return p.row === target.row && p.col === target.col;
  });
  const inZone = all.filter((r) => {
    const p = gridPos(r);
    return Math.abs(p.row - target.row) <= 1 && Math.abs(p.col - target.col) <= 1;
  });

  const scope: CellDetail['scope'] =
    inCell.length >= CAUSE_MIN_N ? 'cell' : inZone.length >= CAUSE_MIN_N ? 'zone' : 'none';
  const picked = scope === 'cell' ? inCell : scope === 'zone' ? inZone : [];
  const pickedKeys = new Set(picked.map((r) => `${r.d}|${r.slot}`));
  const rest = all.filter((r) => !pickedKeys.has(`${r.d}|${r.slot}`));

  return {
    readings: inCell,
    scope,
    n: picked.length,
    causes: scope === 'none' ? [] : causesOf(raw, picked, rest),
    dayScore: dayScoreOf(raw, inCell, all),
  };
}

// ⚠️ ПОПОВНЮВАТИ РАЗОМ ІЗ factsOf. Знаменник факту береться за цим переліком, і
// забутий вид тихо їде у вечір (default нижче) — тобто ранковий факт ділиться
// на кількість ВЕЧІРНІХ зрізів. Саме так уже сталося з 'latency': факт додали,
// сюди не дописали, і «довго не міг заснути» рахувалось від вечірнього
// знаменника. Помилка не падає й не видно її на око — вона просто дає інший
// відсоток.
const MORNING_KINDS = new Set([
  'sleep',
  'sleepQ',
  'bedtime',
  'late',
  'worry',
  'latency',
  'night',
  'nightwhy',
  'awake',
  'body',
  'load',
  'control',
  'moveplan',
]);
const AFTERNOON_KINDS = new Set(['pace', 'with', 'rushed', 'interrupted', 'progress', 'outnow']);

/**
 * Якому слоту належить факт.
 *
 * ⚠️ БЕЗ ЦЬОГО БЛОК БРЕШЕ, і саме так він і збрехав у демо: у режимі «Усі»
 * клітинка з самими вечірніми зрізами показувала «🫂 Друзі — 0 із 17, норма
 * 28%». Читалось як висновок («у такому стані ти не буваєш із людьми»), а
 * насправді вечірній блок про компанію просто не питає — поля не існує.
 * Відсутність ПОЛЯ видавалась за відсутність ЯВИЩА.
 *
 * Тому знаменник кожного факту — зрізи ЙОГО слоту, а не вся вибірка.
 */
function factSlot(key: string): CheckinSlot {
  const kind = key.split(':')[0] ?? '';
  if (MORNING_KINDS.has(kind)) return 'morning';
  if (AFTERNOON_KINDS.has(kind)) return 'afternoon';
  return 'evening';
}

function countFacts(raw: CheckinRaw, readings: StateReading[]) {
  const counts = new Map<string, number>();
  const bySlot = new Map<CheckinSlot, number>();
  for (const r of readings) {
    bySlot.set(r.slot, (bySlot.get(r.slot) ?? 0) + 1);
    for (const f of factsOf(raw.records[r.d], r.slot)) {
      counts.set(f, (counts.get(f) ?? 0) + 1);
    }
  }
  return { counts, bySlot };
}

function causesOf(raw: CheckinRaw, picked: StateReading[], rest: StateReading[]): CauseRow[] {
  const hits = countFacts(raw, picked);
  const base = countFacts(raw, rest);
  const rows: CauseRow[] = [];
  // Перебираємо обидві множини: факт, ЯКОГО ТУТ НЕМАЄ, а всюди є — теж
  // відповідь. «У ці вечори ранній старт траплявся вчетверо рідше» пояснює
  // стан не гірше за присутню перешкоду.
  for (const key of new Set([...hits.counts.keys(), ...base.counts.keys()])) {
    const slot = factSlot(key);
    const of = hits.bySlot.get(slot) ?? 0;
    const baseOf = base.bySlot.get(slot) ?? 0;
    // Обидва боки мусять мати вибірку: без цього «0 із 0» перетворюється на
    // впевнене твердження про стан, у якому цього поля ніхто не питав.
    if (of < CAUSE_MIN_N || baseOf < CAUSE_MIN_N) continue;
    const n = hits.counts.get(key) ?? 0;
    const bn = base.counts.get(key) ?? 0;
    if (Math.max(n, bn) < FACT_MIN_HITS) continue;
    const share = n / of;
    const baseShare = bn / baseOf;
    // Згладжування (+0.5/+1): без нього «0 проти 20» дає Infinity, а «10 проти
    // 0» — ділення на нуль. Обидва випадки реальні й обидва мусять лишитись
    // числом, яке можна відсортувати.
    const lift = (n + 0.5) / (of + 1) / ((bn + 0.5) / (baseOf + 1));
    if (lift < LIFT_THRESHOLD && lift > 1 / LIFT_THRESHOLD) continue;
    rows.push({ key, label: causeLabel(key), n, of, share, baseShare, lift });
  }
  return rows
    .sort((a, b) => Math.abs(Math.log(b.lift)) - Math.abs(Math.log(a.lift)))
    .slice(0, MAX_CAUSES);
}

/**
 * Мінімум діб, щоб порівнювати оцінку клітинки з нормою.
 *
 * ⚠️ Доти гейта тут не було ВЗАГАЛІ — єдине таке місце в блоці. Клітинка з
 * ОДНІЄЮ добою показувала впевнене «3.0 проти 3.6», ще й розфарбоване в
 * зелений/червоний, тобто читалось як висновок. Порівняй із сусідами в цьому ж
 * файлі: причини — CAUSE_MIN_N=8, драйвери — 8, лаг — 16, соцконтекст — 8.
 *
 * Поріг нижчий за CAUSE_MIN_N свідомо: середнє двох чисел — набагато простіша
 * величина за lift тега, і 4 доби вже дають щось краще за здогадку. Але одна
 * доба — це не «оцінка таких днів», це оцінка одного дня.
 */
export const DAY_SCORE_MIN_N = 4;

/**
 * Оцінка дня цих діб проти решти.
 *
 * Окремо від причин, бо це не тег, а число — і єдине в картці, що приходить із
 * ВЕЧОРА незалежно від обраного слоту: оцінка належить добі, а не зрізу. Тобто
 * навіть у фільтрі «Ранок» видно, чим закінчувались доби, що починались так.
 */
function dayScoreOf(
  raw: CheckinRaw,
  picked: StateReading[],
  all: StateReading[],
): CellDetail['dayScore'] {
  const scoreOf = (d: string) => {
    const v = raw.records[d]?.evening?.dayScore;
    return typeof v === 'number' ? v : null;
  };
  const days = [...new Set(picked.map((r) => r.d))];
  const restDays = [...new Set(all.map((r) => r.d))].filter((d) => !days.includes(d));
  const mine = days.map(scoreOf).filter((v): v is number => v !== null);
  const theirs = restDays.map(scoreOf).filter((v): v is number => v !== null);
  // Обидва боки: норма з однієї доби так само не норма, як і середнє з однієї.
  if (mine.length < DAY_SCORE_MIN_N || theirs.length < DAY_SCORE_MIN_N) return null;
  const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
  return { avg: avg(mine), base: avg(theirs), n: mine.length };
}
