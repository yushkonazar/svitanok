// Українська плюралізація для лічильників новин — спільна між
// HeroNewsCard/CompactNewsCard/NewsBentoTile (раніше дублювалась).

export function pluralizeNova(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'нова';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'нові';
  return 'нових';
}
