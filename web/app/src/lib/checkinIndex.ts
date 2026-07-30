// Дзеркало реєстру checkin-model.mjs (FIELDS/INDICES) — людські підписи для
// індексів і полів, які модель називає внутрішніми ключами. Тримати ЯК
// ОКРЕМИЙ файл: web/checkin-model.mjs — Worker-модуль (.mjs, без збірки),
// тут — фронтенд-мапа підписів, синхронізується руками при зміні реєстру.

export const INDEX_ORDER = ['recovery', 'resource', 'work', 'agency', 'body'] as const;
export type ModelIndex = (typeof INDEX_ORDER)[number];

export const INDEX_LABEL: Record<string, string> = {
  recovery: 'Відновлення',
  resource: 'Ресурс',
  work: 'Робота',
  agency: 'Автономія',
  body: 'Тіло',
};

export const INDEX_COLOR: Record<string, string> = {
  recovery: 'var(--color-idx-recovery)',
  resource: 'var(--color-idx-resource)',
  work: 'var(--color-idx-work)',
  agency: 'var(--color-idx-agency)',
  body: 'var(--color-idx-body)',
};

/** Підпис поля-драйвера. Falls back на сирий ключ моделі, якщо мапа відстала. */
export const FIELD_LABEL: Record<string, string> = {
  sleepH: 'Сон (год)',
  sleepQ: 'Якість сну',
  sleepLatency: 'Час засинання',
  bedtime: 'Час відбою',
  detached: 'Відключення від справ',
  rumination: 'Румінація',
  screen: 'Екран увечері',
  caffeine: 'Кофеїн',
  'energy@morning': 'Енергія (ранок)',
  'energy@afternoon': 'Енергія (день)',
  'energy@evening': 'Енергія (вечір)',
  'mood@morning': 'Настрій (ранок)',
  'mood@afternoon': 'Настрій (день)',
  'mood@evening': 'Настрій (вечір)',
  worryAM: 'Тривога вранці',
  rushed: 'Поспіх',
  output: 'Результат',
  focusQuality: 'Якість фокусу',
  effort: 'Зусилля',
  kept: 'Дотримання плану',
  pace: 'Темп дня',
  jobProgress: 'Просування в пошуку',
  autonomy: 'Автономія дня',
  intentMatch: 'План = факт',
  jobConfidence: 'Віра в результат',
  moved: 'Рух',
  outdoor: 'Час надворі',
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field;
}
