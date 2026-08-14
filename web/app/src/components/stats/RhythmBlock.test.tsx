import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RhythmBlock } from './RhythmBlock.tsx';
import { SAMPLE_STATS } from '../../api/sample.ts';
import type { Stats } from '../../api/schema.ts';

/* Ритм — кроки воронки.
 *
 * ⚠️ ГОЛОВНЕ ТУТ — РІЗНИЦЯ МІЖ «0%» І «ЩЕ НЕ БУЛО». Доти рядок показував
 * «0%» і при нулі співбесід, і при нулі оферів із десяти співбесід: хвостик
 * «x/y» ховався разом із порожнім знаменником, а сам нуль лишався. Тобто
 * ВІДСУТНІСТЬ ДАНИХ виглядала точно як ПОГАНИЙ РЕЗУЛЬТАТ — і саме так екран
 * власника рапортував «Співбесіда → офер 0%», не маючи жодної співбесіди.
 *
 * Це рівно та помилка, яку в Майстерності вже виправили через easePct = null
 * («не питали» ≠ «все складно»), тож тут вона пришпилена тестом. */

vi.mock('../../telegram.ts', () => ({ haptic: () => {} }));

// ⚠️ funnelSpeed гаситься навмисно. Картка «Скільки триває крок» підписує свої
// рядки тими самими словами («Співбесіда → офер»), тож із нею на екрані запит
// по тексту знаходить ДВА елементи й тест падає на неоднозначності, а не на
// поведінці. Тут перевіряються конверсії — швидкість кроку має власні тести.
const stats = (over: Partial<Stats>): Stats => ({
  ...SAMPLE_STATS,
  funnelSpeed: { steps: [], stale: [], staleAfterDays: 21 },
  ...over,
});

describe('RhythmBlock — конверсії з порожнім знаменником', () => {
  it('жодної співбесіди -> «ще не було», а не «0%»', () => {
    render(
      <RhythmBlock
        s={stats({
          reached: { ...SAMPLE_STATS.reached, applied: 3, interview: 0, offer: 0 },
          conversion: { appliedToInterview: 0, interviewToOffer: 0 },
        })}
      />,
    );
    const row = screen.getByText('Співбесіда → офер').parentElement!;
    expect(row.textContent).toContain('ще не було');
    expect(row.textContent).not.toContain('%');
  });

  it('подачі є, співбесід немає -> це чесний 0% з видимим дробом', () => {
    render(
      <RhythmBlock
        s={stats({
          reached: { ...SAMPLE_STATS.reached, applied: 3, interview: 0, offer: 0 },
          conversion: { appliedToInterview: 0, interviewToOffer: 0 },
        })}
      />,
    );
    const row = screen.getByText('Подав → співбесіда').parentElement!;
    expect(row.textContent).toContain('0%');
    // Дріб мусить бути видимий саме тут: «0% з трьох» і «0% з нуля» — різні
    // твердження, і плутати їх ми й перестали.
    expect(row.textContent).toContain('0/3');
  });

  it('обидва знаменники порожні -> жодного відсотка на екрані', () => {
    render(
      <RhythmBlock
        s={stats({
          reached: { ...SAMPLE_STATS.reached, applied: 0, interview: 0, offer: 0 },
          conversion: { appliedToInterview: 0, interviewToOffer: 0 },
        })}
      />,
    );
    expect(screen.getByText('Подав → співбесіда').parentElement!.textContent).toContain(
      'ще не було',
    );
    expect(screen.getByText('Співбесіда → офер').parentElement!.textContent).toContain(
      'ще не було',
    );
  });

  it('дані є — рядок показує відсоток і дріб, як і раніше', () => {
    render(
      <RhythmBlock
        s={stats({
          reached: { ...SAMPLE_STATS.reached, applied: 10, interview: 4, offer: 1 },
          conversion: { appliedToInterview: 40, interviewToOffer: 25 },
        })}
      />,
    );
    expect(screen.getByText('Подав → співбесіда').parentElement!.textContent).toContain('40%');
    expect(screen.getByText('Співбесіда → офер').parentElement!.textContent).toContain('1/4');
  });
});
