import { describe, it, expect } from 'vitest';
import { demoBadge } from '../web/app/src/lib/demoBadge.ts';

/* B9/F2 (аудит C2, high): клієнт віддає SAMPLE із `demo:true` у ДВОХ випадках —
 * поза Telegram (очікувано) і при ВІДХИЛЕНОМУ initData всередині Telegram
 * (401/403: протухла сесія, не той акаунт). Чип у шапці читав лише
 * `!inTelegram()`, тож другий випадок виглядав як нормальна робота: власник
 * бачив вигадані стріки й чек-іни як СВОЇ.
 *
 * Це найгірший клас помилки в застосунку про особисті дані — не «нічого не
 * видно», а «видно чуже, схоже на твоє». Тому тут перевіряється не лише
 * наявність чипа, а й те, що ВСЕРЕДИНІ Telegram текст ІНШИЙ: «демо» там
 * прочиталося б як «я сам відкрив прев'ю». */

describe('demoBadge', () => {
  it('справжні дані -> чипа немає', () => {
    expect(demoBadge({ inTelegram: true, demo: false })).toBeNull();
    expect(demoBadge({ inTelegram: false, demo: false })).toBeNull();
  });

  it('поза Telegram -> звичайне «демо»', () => {
    const b = demoBadge({ inTelegram: false, demo: true })!;
    expect(b.text).toBe('демо');
    expect(b.hint).toContain('поза Telegram');
  });

  it('У Telegram із відхиленим initData -> текст прямо каже, що дані НЕ ТВОЇ', () => {
    const b = demoBadge({ inTelegram: true, demo: true })!;
    expect(b.text).not.toBe('демо'); // інакше читалось би як «я сам відкрив прев'ю»
    expect(b.text).toContain('не твої');
    // Підказка мусить назвати причину й дію — інакше власник не знає, що робити.
    expect(b.hint).toMatch(/сесі/i);
    expect(b.hint).toMatch(/перезапусти/i);
  });
});
