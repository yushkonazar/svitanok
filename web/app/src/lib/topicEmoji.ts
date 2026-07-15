// Емодзі теми за назвою (роадмеп v3, E1) — перенесено з index.html:2309-2320.
// Регекс, перший збіг виграє; default 📰.

const RULES: [RegExp, string][] = [
  [/наук/i, '🔬'],
  [/політ/i, '🏛'],
  [/спорт/i, '⚽'],
  [/війн|оборон|фронт/i, '🛡'],
  [/техно|it|tech/i, '💻'],
  [/економ|бізнес|фінанс/i, '💹'],
  [/культур|мистецтв/i, '🎭'],
  [/здоров|медиц/i, '🩺'],
];

export function topicEmoji(t: string): string {
  for (const [re, emoji] of RULES) if (re.test(t)) return emoji;
  return '📰';
}
