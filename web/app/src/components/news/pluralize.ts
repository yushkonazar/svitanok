// Українська плюралізація для лічильників новин — спільна між
// HeroNewsCard/CompactNewsCard/NewsBentoTile (раніше дублювалась).
//
// Саме правило (пастка 11-14) живе в lib/plural.ts — тут лишаються тільки
// СЛОВА. Доти кожен такий хелпер ніс власну копію умов, і місце, де копію
// забули зробити, давало «5 дні» (аудит C2/F7).

import { pluralUk } from '../../lib/plural.ts';

export function pluralizeNova(n: number): string {
  return pluralUk(n, ['нова', 'нові', 'нових']);
}
