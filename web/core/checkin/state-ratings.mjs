export const CHECKIN_FLOW_REVISION = 2;

export const STATE_RATING_LABELS = {
  energy: [
    'Виснажений · ледве вистачає сил на базове',
    'Дуже мало сил · потрібна пауза навіть між простими справами',
    'Мало сил · можу робити легкі справи, але швидко втомлююся',
    'Нижче звичного · на необхідне сил вистачає',
    'Достатньо сил · справляюся зі звичними справами',
    'Бадьорий · маю запас для складнішого завдання',
    'Багато сил · легко тримаю темп',
    'Дуже багато сил · відчуваю себе особливо бадьорим',
  ],
  mood: [
    'Дуже важкий · неприємні почуття майже повністю переважають',
    'Поганий · неприємні почуття сильно відчуваються',
    'Радше поганий · неприємного відчуваю більше',
    'Змішаний із важким відтінком · є різне, але важкого трохи більше',
    'Рівний або змішаний · нічого явно не переважає',
    'Радше хороший · приємного відчуваю більше',
    'Хороший · приємні почуття помітно переважають',
    'Дуже хороший · відчуваю виразну радість або піднесення',
  ],
};

/** The existing fields carry their existing 1–5 meaning for historical consumers.
 * @param {unknown} value */
export function coarseRatingV4(value) {
  return typeof value === 'number' && Number.isInteger(value)
    ? ([1, 2, 2, 3, 3, 4, 4, 5][value - 1] ?? null)
    : null;
}

/** @param {Record<string,unknown>} record @param {'energy'|'mood'} metric */
export function recordedStateRating(record, metric) {
  const exact = record[`${metric}LevelV4`];
  if (record.flowRevisionV4 === CHECKIN_FLOW_REVISION)
    return coarseRatingV4(exact) != null
      ? { value: /** @type {number} */ (exact), scale: 8 }
      : null;
  const value = record[metric];
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 5
    ? { value, scale: 5 }
    : null;
}

/** @param {{value:number,scale:number}} rating */
export function stateRatingBand(rating) {
  const value = rating.scale === 8 ? (coarseRatingV4(rating.value) ?? 3) : rating.value;
  return value <= 2 ? 0 : value >= 4 ? 2 : 1;
}

/** @param {{value:number,scale:number}} a @param {{value:number,scale:number}} b */
export function stateRatingDirection(a, b) {
  return Math.sign(
    a.scale === b.scale ? b.value - a.value : stateRatingBand(b) - stateRatingBand(a),
  );
}
