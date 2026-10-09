import { it, expect } from 'vitest';
import { currencyPoints } from '../web/api-currency-history.mjs';
it('keeps actual archive dates, sorts and deduplicates; rate per unit handles foreign currency units', () => {
  expect(
    currencyPoints(
      [
        { cc: 'JPY', exchangedate: '10.10.2026', rate: 29, units: 100 },
        { cc: 'JPY', exchangedate: '09.10.2026', rate: 30, rate_per_unit: 0.3 },
        { cc: 'JPY', exchangedate: '09.10.2026', rate_per_unit: 0.31 },
        { cc: 'USD', exchangedate: '08.10.2026', rate: 44 },
        { cc: 'JPY', exchangedate: '01.01.2026', rate: 29 },
      ],
      'JPY',
      '2026-10-04',
      '2026-10-10',
    ),
  ).toEqual([
    { date: '2026-10-09', value: 0.31 },
    { date: '2026-10-10', value: 0.29 },
  ]);
});
