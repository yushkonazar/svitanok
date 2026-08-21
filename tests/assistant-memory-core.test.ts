import { describe, it, expect } from 'vitest';
import * as mem from '../web/assistant-memory-core.mjs';
const { historyKey, appendTurn, renderHistoryForPrompt, MAX_HISTORY_TURNS } = mem;

describe('historyKey', () => {
  it('chatId+threadId; відсутній threadId -> порожній суфікс', () => {
    expect(historyKey(42, 7)).toBe('42:7');
    expect(historyKey(42, null)).toBe('42:');
    expect(historyKey(42, undefined)).toBe('42:');
  });
});

describe('appendTurn', () => {
  it('додає репліку; нормалізує role; сплющує переноси рядків', () => {
    let h = appendTurn({}, 1, 7, 'user', 'привіт\n\nсвіт');
    h = appendTurn(h, 1, 7, 'boss', 'відповідь'); // невідома role -> user
    expect(h['1:7']).toEqual([
      { role: 'user', text: 'привіт світ' },
      { role: 'user', text: 'відповідь' },
    ]);
    const h2 = appendTurn(h, 1, 7, 'assistant', 'ага');
    expect(h2['1:7'][2]).toEqual({ role: 'assistant', text: 'ага' });
  });

  it('порожня/пробільна репліка не додається', () => {
    expect(appendTurn({}, 1, 7, 'user', '   ')).toEqual({});
    expect(appendTurn({}, 1, 7, 'user', '')).toEqual({});
  });

  it(`кап на MAX_HISTORY_TURNS (=${MAX_HISTORY_TURNS}) останніх`, () => {
    let h: Record<string, { role: string; text: string }[]> = {};
    for (let i = 0; i < MAX_HISTORY_TURNS + 4; i++) h = appendTurn(h, 1, 7, 'user', `t${i}`);
    expect(h['1:7']).toHaveLength(MAX_HISTORY_TURNS);
    expect(h['1:7']?.[0]?.text).toBe(`t4`); // найстаріші 4 витіснено
    expect(h['1:7']?.[MAX_HISTORY_TURNS - 1]?.text).toBe(`t${MAX_HISTORY_TURNS + 3}`);
  });

  it('різні треди не змішуються', () => {
    let h = appendTurn({}, 1, 7, 'user', 'A');
    h = appendTurn(h, 1, 9, 'user', 'B');
    expect(h['1:7']).toHaveLength(1);
    expect(h['1:9']).toHaveLength(1);
  });
});

describe('renderHistoryForPrompt', () => {
  it('порожня історія -> порожній рядок (без префікса)', () => {
    expect(renderHistoryForPrompt({}, 1, 7)).toBe('');
    expect(renderHistoryForPrompt(null, 1, 7)).toBe('');
  });

  it('рендерить репліки з мітками Користувач/Ти у хронологічному порядку', () => {
    const h = {
      '1:7': [
        { role: 'user', text: 'коли зустріч зі стоматологом?' },
        { role: 'assistant', text: 'завтра о 15:00' },
        { role: 'user', text: 'перенеси на годину' },
      ],
    };
    expect(renderHistoryForPrompt(h, 1, 7)).toBe(
      'Попередня розмова:\n' +
        'Користувач: коли зустріч зі стоматологом?\n' +
        'Ти: завтра о 15:00\n' +
        'Користувач: перенеси на годину\n\n',
    );
  });

  it('бюджет: за перевищення MAX_RENDER_LEN лишає лише найсвіжіші', () => {
    const long = 'я'.repeat(180);
    const h = {
      '1:7': Array.from({ length: 6 }, (_, i) => ({ role: 'user', text: `${i}${long}` })),
    };
    const out = renderHistoryForPrompt(h, 1, 7);
    // 6×~187 симв. > 700 -> частина відкинута; найсвіжіша (індекс 5) присутня, найстаріша (0) — ні.
    expect(out).toContain(`5${long}`);
    expect(out).not.toContain(`0${long}`);
    expect(out.length).toBeLessThan(900);
  });
});
