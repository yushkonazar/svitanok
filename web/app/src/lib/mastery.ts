import type { MasteryTopic, Stats } from '../api/schema.ts';

type Topic = MasteryTopic;
type Week = Stats['roadmapWeekly'][number];

// Майстерність — арифметика блоку «де діри».
//
// ⚠️ ПРИВІД. Блок вимкнули з рендера 29.07 із вердиктом власника «абсолютно не
// розумію, що мені показується»: роадмеп, mock і тема тижня стояли поруч без
// звʼязку, і жодне з чисел не відповідало на питання, з яким сюди приходять —
// «що я знаю, а що ні».
//
// Звʼязок при цьому існував (MOCK_TO_ROADMAP на сервері), просто назовні не
// виходив. Найцінніше, що він дає, — РОЗРИВ між «відмітив пройденим» і «даються
// питання»: це «ілюзія знання», і жоден бік окремо її показати не може.

/** Нижче цього відсоток легкості — шум: кожна відповідь важить 20+ пунктів. */
export const MIN_SEEN = 5;

export interface MasteryRow {
  id: string;
  title: string;
  /** Скільки підпунктів теми відмічено, у відсотках. */
  donePct: number;
  /** Скільки питань по темі НЕ виявились складними, у відсотках. */
  easePct: number;
  /** donePct − easePct. Додатний = відмітив, але не дається. */
  gap: number;
  seen: number;
  done: number;
  total: number;
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

/**
 * Теми, розкладені на дві купи.
 *
 * ⚠️ РОЗДІЛЕННЯ, А НЕ ОДИН РЕЙТИНГ — і це головне рішення тут. Тема без питань
 * має easePct=null, і якби вона потрапила в спільний список як нуль, то
 * «жодного разу не питали» читалось би як «геть не дається» — найгірша оцінка
 * за відсутність даних. Тому такі теми йдуть окремо й іншим текстом.
 *
 * Той самий гейт і для майже-порожніх: на 3 питаннях 33% і 67% — це та сама
 * одна помилка, і рейтинг за таким числом впорядковує шум.
 */
export function masteryRows(topics: Topic[]): { rated: MasteryRow[]; unrated: Topic[] } {
  const rated: MasteryRow[] = [];
  const unrated: Topic[] = [];
  for (const t of topics) {
    if (t.easePct === null || t.seen < MIN_SEEN) {
      unrated.push(t);
      continue;
    }
    const donePct = pct(t.done, t.total);
    rated.push({
      id: t.id,
      title: t.title,
      donePct,
      easePct: t.easePct,
      gap: donePct - t.easePct,
      seen: t.seen,
      done: t.done,
      total: t.total,
    });
  }
  // Сортування за розривом — це і є подача інсайту. БД чартів (ui-ux-pro-max,
  // --domain chart) прямо каже: для 13 категорій на мобільному брати
  // горизонтальні бари й «always sort descending», а скатер-квадрант
  // протипоказаний («fewer than 20 points», «mobile-primary context»). Тобто
  // «ілюзію знання» показує ПОРЯДОК рядків, а не положення точки в квадранті.
  rated.sort((a, b) => b.gap - a.gap || b.donePct - a.donePct);
  // Незаймані теми — за прогресом: спершу ті, де вже щось відмічено, бо саме
  // їх варто перевірити питаннями найближче.
  unrated.sort((a, b) => pct(b.done, b.total) - pct(a.done, a.total));
  return { rated, unrated };
}

/** Скільки підпунктів роадмепу лишилось. */
export function remaining(topics: Topic[]): number {
  return topics.reduce((n, t) => n + Math.max(0, t.total - t.done), 0);
}

/**
 * Скільки тижнів лишилось за поточним темпом.
 *
 * ⚠️ Гейт на нуль ОБОВʼЯЗКОВИЙ: при темпі 0 формула дає Infinity, і замість
 * чесного «темпу немає» зʼявилось би «∞ тижнів» або, після округлення, якесь
 * величезне число з виглядом прогнозу. Береться середнє за останні `weeks`
 * тижнів, а не за весь ряд: прогноз має спиратись на те, як ідуть справи
 * ЗАРАЗ, інакше давній ривок роками тягне оцінку вниз.
 */
export function weeksLeft(weekly: Week[], left: number, weeks = 4): number | null {
  if (left <= 0) return null;
  const tail = weekly.slice(-weeks);
  if (!tail.length) return null;
  const pace = tail.reduce((n, w) => n + (w.count || 0), 0) / tail.length;
  if (pace <= 0) return null;
  return Math.ceil(left / pace);
}
