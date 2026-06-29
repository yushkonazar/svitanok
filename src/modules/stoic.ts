// stoic (consumer, §6). Цитата за датою MM-DD, українською. Лише public-domain
// джерела / власний переклад PD-оригіналу (Марк Аврелій, Сенека, Епіктет);
// атрибуції звіряти, не вигадувати.
//
// ⚠️ Старт — кілька десятків записів-ЗАГЛУШОК (власні UA-переклади PD-оригіналів).
// Повні 366 — окремим пізнім PR (§10). Поки нема точного MM-DD, працює
// детермінований фолбек, щоб цитата була щодня.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import quotesData from '../data/stoic.json' with { type: 'json' };

interface Quote {
  text: string;
  author: string;
}
const quotes: Record<string, Quote> = quotesData;

/** "YYYY-MM-DD" -> "MM-DD". */
export function mmdd(todayKey: string): string {
  return todayKey.slice(5);
}

/** Детермінований фолбек: вибір запису за датою, коли немає точного MM-DD. */
function fallbackQuote(key: string): Quote | null {
  const keys = Object.keys(quotes).sort();
  if (keys.length === 0) return null;
  let sum = 0;
  for (let i = 0; i < key.length; i++) sum += key.charCodeAt(i);
  return quotes[keys[sum % keys.length]!]!;
}

/** Цитата на день: точний MM-DD -> 02-29 фолбек на 02-28 -> детермінований фолбек. */
export function resolveQuote(todayKey: string): Quote | null {
  const key = mmdd(todayKey);
  if (quotes[key]) return quotes[key];
  if (key === '02-29' && quotes['02-28']) return quotes['02-28']; // невисокосний рік
  return fallbackQuote(key);
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
      priority: 10, // одразу під заголовком-датою (§5)
    };
  },
};
