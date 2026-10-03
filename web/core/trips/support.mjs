import { kyivMs } from '../day-plan/store.mjs';
import { addDaysToDateKey } from '../../reminders-core.mjs';
import { tripSlot } from './time.mjs';

/** Read-only trip navigation. No button here authorizes a booking or a write. */
export const TRIP_SUPPORT_ACTIONS = {
  sights: ['🏛 Що побачити', 'Підбери визначні місця й архітектуру.'],
  nature: ['🌿 Краєвиди', 'Підбери краєвиди, природу й прогулянки.'],
  local: ['🔎 Незвичні місця', 'Підбери менш відомі цікаві місця.'],
  food: ['🍽 Де поїсти', 'Підбери цікаві заклади з перевіреними адресами, годинами й відгуками.'],
  road: [
    '🛣 Дорога',
    'Перевір маршрут, доречні зупинки й повернення. Для квитків перевір розклад перевізника; не використовуй автомобільний ETA замість рейсу.',
  ],
  packing: [
    '🧳 Що взяти',
    'Склади список речей за способом, датами, погодою й обмеженнями саме цієї поїздки.',
  ],
  budget: [
    '💰 Бюджет',
    'Покажи підтверджені витрати цієї поїздки й невідомі складники окремо. Не віднось усі транзакції за ці дати до поїздки.',
  ],
  itinerary: [
    '🗺 Маршрут',
    'Покажи збережені етапи й місцевий час через trip.workspace op=get; перевір запас на пересадки. Не змінюй маршрут без прохання.',
  ],
  journal: [
    '📖 Місця й враження',
    'Прочитай trip.workspace op=get: покажи відвідані/збережені місця, враження та незакриті бажання. Запитай, що власник хоче додати; сам нічого не записуй.',
  ],
};

/** @param {string} chainId */
export function tripSupportButtons(chainId) {
  if (!/^[0-9a-f-]{36}$/i.test(chainId)) return [];
  const choices = Object.entries(TRIP_SUPPORT_ACTIONS).map(([key, [text]]) => ({
    text: String(text),
    callback_data: `m:ta:${chainId}:${key}`,
  }));
  const rows = [];
  for (let i = 0; i < choices.length; i += 2) rows.push(choices.slice(i, i + 2));
  return rows;
}

/** Stable, bounded morning cycle; snapshot inside a Workflow step before waiting.
 * Past days are never replayed as a burst. Unknown return means no invented stay.
 * @param {{date_from:string,date_to:string|null}} state @param {number} nowMs */
export function tripDaySchedule(state, nowMs) {
  if (!state.date_to) return [];
  const points = [];
  let day = state.date_from;
  for (let i = 0; i < 30 && day <= state.date_to; i += 1) {
    const at = kyivMs(day, '09:00');
    if (at != null && at > nowMs) points.push({ day, at, returnDay: day === state.date_to });
    day = addDaysToDateKey(day, 1);
  }
  return points;
}

/** Version 2 uses explicit local time and adds a quiet evening review. Version 1 unchanged.
 * @param {{date_from:string,date_to:string|null,preferences?:Record<string,any>}} state @param {number} nowMs */
export function tripLocalSchedule(state, nowMs) {
  if (!state.date_to) return [];
  const points = [];
  const zone = state.preferences?.timezone ?? 'Europe/Kyiv';
  let day = state.date_from;
  for (let i = 0; i < 30 && day <= state.date_to; i++) {
    for (const { kind, clock } of [
      { kind: 'morning', clock: '09:00' },
      { kind: 'evening', clock: '20:30' },
    ]) {
      const at = tripSlot(day, clock, zone);
      if (at != null && at > nowMs)
        points.push({ day, at, kind, zone, returnDay: day === state.date_to });
    }
    day = addDaysToDateKey(day, 1);
  }
  return points;
}

/** Useful core reminders, not sourced medical/legal guidance or a safety verdict.
 * @param {{mode:string,country?:string|null}} state */
export function packingItems(state) {
  const base = [
    'Документи, гроші й потрібні квитки',
    'Телефон, зарядка та павербанк',
    'Вода й одяг за перевіреним прогнозом',
    'Особисті ліки, які вже використовуєш',
  ];
  if (state.mode === 'car') base.push('Документи на авто, пальне й необхідне дорожнє оснащення');
  if (state.mode === 'plane')
    base.push('Посадковий талон; звір багаж і час реєстрації з правилами перевізника');
  if (state.mode === 'mixed') base.push('Квитки й запас часу для кожної пересадки');
  if (state.mode === 'walk' || state.mode === 'hike')
    base.push(
      'Офлайн-карта, відповідне взуття, вода й запас живлення',
      'План маршруту та домовленість про звʼязок; без перевірених умов не вважай маршрут безпечним',
    );
  if (state.country && !/^(україна|ukraine|ua)$/i.test(state.country.trim()))
    base.push('Перевірені правила вʼїзду, страхування й звʼязок за кордоном');
  return base;
}

/** Deterministic core checklist for walking/hiking, not a vehicle template.
 * @param {string} key */
export function outdoorChecklist(key) {
  if (key !== 'outdoor') return null;
  const item = (/** @type {string} */ text) => ({
    label: (text.split(':')[0] ?? text).slice(0, 40),
    text,
    marker: null,
  });
  return {
    t30: [
      'Маршрут: дистанція, складність, доступ і тривалість',
      'Спорядження: перевір потрібне для маршруту',
      'Звʼязок: залиш план і домовся про контрольний контакт',
    ].map(item),
    t7: [
      'Умови маршруту: перевір актуальні обмеження й прогноз',
      'Ночівля: перевір місце, якщо плануєш залишитись',
    ].map(item),
    t1: [
      'Офлайн-карта: завантаж і перевір маршрут',
      'Вода й спорядження: перевір перед стартом',
      'План відступу: визнач можливість повернення',
    ].map(item),
    road: [
      'Темп: враховуй умови й самопочуття',
      'Звʼязок: повідом контрольний контакт за домовленістю',
      'Зміна умов: не продовжуй лише заради початкового плану',
    ].map(item),
  };
}
