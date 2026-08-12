// stoic (consumer, §6). Одна цитата на день — ротація за днем року через увесь
// набір (детерміновано, щодня наступна, циклічно). Лише public-domain джерела /
// власний переклад PD-оригіналу (Марк Аврелій, Сенека, Епіктет); атрибуції
// звіряти, не вигадувати. «За мотивами …» = вільний переказ ідеї автора.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import quotesData from '../data/stoic.json' with { type: 'json' };

interface Quote {
  text: string;
  author: string;
}
const quotes: Quote[] = quotesData as Quote[];

/** День року 1..366 з "YYYY-MM-DD" (todayKey уже київський). */
export function dayOfYear(todayKey: string): number {
  const [y, m, d] = todayKey.split('-').map(Number);
  return Math.floor((Date.UTC(y!, m! - 1, d!) - Date.UTC(y!, 0, 1)) / 86_400_000) + 1;
}

/** Цитата на день: ротація за днем року через увесь масив (циклічно). */
export function resolveQuote(todayKey: string): Quote | null {
  if (quotes.length === 0) return null;
  return quotes[(dayOfYear(todayKey) - 1) % quotes.length]!;
}

export const stoicModule: Module<AppConfig> = {
  id: 'stoic',
  kind: 'consumer',
  enabled: (config) => config.modules.stoic.enabled,
  async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
    const q = resolveQuote(ctx.clock.todayKey());
    if (!q) return null;
    return {
      id: 'stoic',
      title: 'Думка дня',
      icon: '🏛',
      summary: `«${q.text}»\n— ${q.author}`,
      data: { text: q.text, author: q.author },
      priority: 10, // одразу під заголовком-датою (§5)
    };
  },
};
