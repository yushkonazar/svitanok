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
  noplan: 'Не було плану',
  context: 'Перемикався між справами',
  perfect: 'Застряг на деталях',
  noise: 'Шум/незручне місце',
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
  plan: 'План з вечора',
  timer: 'Таймер/помодоро',
  clean: 'Прибрав робоче місце',
  food: 'Нормально поїв',
};

export const SLEEP_KIND_LABEL: Record<string, string> = {
  slept: 'Спав',
  naps: 'Дрімав уривками',
  none: 'Ніч без сну',
};

export const MOVE_PLAN_LABEL: Record<string, string> = {
  none: 'Рух не планував',
  light: 'Планував легкий рух',
  // Рівні дзеркалять MOVED_LABEL один в один — пара «намір проти факту»
  // порівнює однакові шкали, тож і підписи мусять читатись однаково.
  active: 'Планував активний рух',
  workout: 'Планував тренування',
};

export const PROGRESS_LABEL: Record<string, string> = {
  none: 'До обіду нічого',
  started: 'До обіду почав',
  half: 'До обіду половина',
  most: 'До обіду майже все',
};

export const INTERRUPTED_LABEL: Record<string, string> = {
  none: 'Не збивали',
  few: 'Збивали кілька разів',
  many: 'Збивали постійно',
};

export const AWAKENINGS_LABEL: Record<string, string> = {
  no: 'Не прокидався',
  once: 'Прокидався раз',
  few: 'Прокидався кілька разів',
  many: 'Прокидався часто',
};

export const NIGHT_REASON_LABEL: Record<string, string> = {
  wait: 'Чекав ранку/комендантська',
  work: 'Робота/проєкт',
  cant: 'Не міг заснути',
  uncomf: 'Незручно спати',
  anxious: 'Тривога/думки',
  health: 'Здоровʼя/біль',
  people: 'Люди/події',
  scroll: 'Залип у стрічці',
  travel: 'Дорога/переїзд',
  other: 'Інше',
};

export const LATE_REASON_LABEL: Record<string, string> = {
  work: 'Робота/проєкт',
  scroll: 'Залип у стрічці',
  metime: 'Хотів час для себе',
  anxious: 'Не міг заснути',
  social: 'Люди/події',
  late_home: 'Пізно повернувся',
  other: 'Інше',
};

export const WITH_WHOM_LABEL: Record<string, string> = {
  alone: '🧍 Сам',
  partner: '💖 Кохана',
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
  food: '🍽 Їжа/готування',
  scroll: '📱 Стрічка/телефон',
  games: '🎮 Ігри',
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
