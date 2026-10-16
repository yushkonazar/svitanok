export const XP_CATEGORIES = [
  { xp: 5, title: 'Мікрокрок', detail: 'Коротка буденна дія: уточнити, записати, підготувати.' },
  {
    xp: 10,
    title: 'Невелика справа',
    detail: 'Звична корисна дія з простим перевірним результатом.',
  },
  {
    xp: 15,
    title: 'Зосереджена дія',
    detail: 'Невеликий завершений результат, який потребує уваги.',
  },
  {
    xp: 20,
    title: 'Повноцінна задача',
    detail: 'Звичайне зусилля й чіткий самостійний результат.',
  },
  { xp: 30, title: 'Важливий крок', detail: 'Помітний рух у роботі, навчанні або дисципліні.' },
  {
    xp: 35,
    title: 'Значущий результат',
    detail: 'Важлива задача зі зосередженою роботою та відчутним внеском.',
  },
  {
    xp: 50,
    title: 'Складна задача',
    detail: 'Значне зусилля для важливої цілі, а не багато дрібних позначок.',
  },
  { xp: 75, title: 'Великий етап', detail: 'Складний завершений етап із суттєвим результатом.' },
  {
    xp: 100,
    title: 'Ключова віха',
    detail: 'Рідкісний великий результат, який справді змінює напрям.',
  },
];
export const PLAN_AREAS = {
  work: 'Робота',
  learning: 'Навчання',
  discipline: 'Дисципліна',
  life: 'Щоденні справи',
};
/** A transparent suggestion. Time alone and repetition never mint experience.
 * @param {{effort?:number,contribution?:number,challenge?:number,estimateMinutes?:number,routine?:boolean}} input */
export function suggestTaskScore(input = {}) {
  const effort = Math.max(0, Math.min(2, input.effort ?? 1));
  const contribution = Math.max(0, Math.min(1, input.contribution ?? 0));
  const challenge = Math.max(0, Math.min(2, input.challenge ?? 0));
  const duration =
    (input.estimateMinutes ?? 0) >= 90 ? 2 : (input.estimateMinutes ?? 0) >= 30 ? 1 : 0;
  let index = Math.min(8, 1 + effort * 2 + contribution * 2 + challenge + duration);
  if (input.routine) index = Math.min(index, contribution ? 6 : 2);
  if (!effort && !contribution && !challenge && !duration) index = input.routine ? 0 : 1;
  return {
    ...XP_CATEGORIES[index],
    reasons: [
      `Зусилля ${effort + 1}/3`,
      contribution ? 'Важливий внесок у ціль' : 'Підтримувальна дія',
      `Виклик ${challenge}/2`,
      input.routine ? 'Звична дія: обмежений XP' : 'Самостійний результат',
    ],
  };
}
