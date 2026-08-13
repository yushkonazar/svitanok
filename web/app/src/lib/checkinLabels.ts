// Людські підписи значень чек-іну — ОДНЕ джерело на застосунок.
//
// Доти вони жили локальними константами всередині CheckinBlock.tsx, і поки
// читач був один, це не заважало. Тепер тих самих значень потребує карта
// станів (деталі клітинки перелічують блокери й помічники вибраних діб), а
// дві копії підписів розходяться тихо: сервер бачить `tired`, один екран
// каже «Втома», другий — старе формулювання, і однакові дані виглядають як
// різні.
//
// Ключі — значення з CHECKIN_FIELDS (web/stats-core.mjs). Невідоме значення
// свідомо НЕ падає: `labelOf` віддає сирий ключ, тож нове значення з сервера
// зʼявиться на екрані як є, а не зникне.

export const BLOCKER_LABEL: Record<string, string> = {
  tired: 'Втома',
  anxious: 'Тривога',
  stuck: 'Не знав з чого',
  distract: 'Відволікання',
  nomotiv: 'Немає мотивації',
  overload: 'Забагато всього',
  procrast: 'Відкладав',
  forgot: 'Забув',
  waiting: 'Чекав на інших',
  health: 'Здоровʼя',
  external: 'Зовнішні обставини',
};

export const HELPER_LABEL: Record<string, string> = {
  early: 'Ранній старт',
  list: 'Список',
  smallstep: 'Маленький крок',
  nodistract: 'Прибрав відволікання',
  move: 'Рух/прогулянка',
  rest: 'Відпочинок/сон',
  breaks: 'Перерви',
  deadline: 'Дедлайн',
  music: 'Музика/фокус',
  support: 'Підтримка',
};

export const LATE_REASON_LABEL: Record<string, string> = {
  work: 'Робота/проєкт',
  scroll: 'Залип у стрічці',
  metime: 'Хотів час для себе',
  anxious: 'Не міг заснути',
  social: 'Люди/події',
  other: 'Інше',
};

export const WITH_WHOM_LABEL: Record<string, string> = {
  alone: '🧍 Сам',
  family: '🏠 Рідні',
  friends: '🫂 Друзі',
  work: '💼 По роботі',
  public: '🏙 Серед людей',
  mixed: '🔀 Порівну',
};

export const CATEGORY_LABEL: Record<string, string> = {
  work: '💼 Робота',
  learn: '📚 Навчання',
  project: '🛠 Проєкт',
  travel: '🧭 Дорога',
  chores: '🔁 Побут',
  sport: '🏃 Спорт',
  rest: '🌿 Відпочинок',
  people: '👥 Люди',
  create: '🎨 Творчість',
  health: '🏥 Здоровʼя',
  admin: '📋 Адмін/фінанси',
};

export const PACE_LABEL: Record<string, string> = {
  on: '📈 За планом',
  behind: '🐢 Відстаю',
  other: '🔀 Роблю інше',
  overload: '🥵 Перевантажений',
  better: '🚀 Краще, ніж планував',
};

export const MOVED_LABEL: Record<string, string> = {
  none: '🪑 Майже сидів',
  light: '🚶 Трохи рухався',
  active: '🔥 Активний',
  workout: '🏃 Тренування',
};

/** Підпис або сам ключ — невідоме значення видно, а не мовчки зникає. */
export function labelOf(map: Record<string, string>, key: string): string {
  return map[key] ?? key;
}
