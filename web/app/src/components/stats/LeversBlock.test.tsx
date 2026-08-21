import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { LeversResult } from '../../api/schema.ts';

/* Важелі. Математика покрита кореневим vitest (tests/levers-core.test.ts) — тут
 * те, чого там перевірити неможливо: що блок РОЗРІЗНЯЄ три порожні стани, що
 * знаменник чесності доїжджає до екрана разом із рядками, і що формулювання не
 * перетворює звʼязок на причину. */

vi.mock('../../telegram.ts', () => ({ haptic: () => {} }));

let hookResult: { data: LeversResult | undefined; isLoading: boolean; isError: boolean };
let enabledCalls: boolean[];

vi.mock('../../api/hooks.ts', () => ({
  useLevers: (enabled: boolean) => {
    enabledCalls.push(enabled);
    return hookResult;
  },
}));

const { LeversBlock } = await import('./LeversBlock.tsx');

const FEATURES: LeversResult['features'] = {
  sleep: {
    label: 'Сон',
    emoji: '🌙',
    unit: 'год',
    more: 'більше сну',
    less: 'менше сну',
    domain: 'recovery',
    domainLabel: 'Відновлення',
  },
  applied: {
    label: 'Подачі',
    emoji: '📨',
    unit: '',
    more: 'більше подач',
    less: 'менше подач',
    domain: 'search',
    domainLabel: 'Пошук роботи',
  },
  roadmap: {
    label: 'Роадмеп',
    emoji: '📚',
    unit: 'тем',
    more: 'більше тем роадмепу',
    less: 'менше тем роадмепу',
    domain: 'learning',
    domainLabel: 'Навчання',
  },
};

const ROW = {
  from: 'sleep',
  to: 'applied',
  lag: 1,
  rho: 0.54,
  rhoDiff: 0.47,
  n: 40,
  nDiff: 38,
  p: 0.0016,
  effect: { high: 11.4, low: 5.6, nHigh: 18, nLow: 22, d: 0.98 },
};

const payload = (over: Partial<NonNullable<LeversResult['levers']>> = {}) => ({
  computedAt: '2026-08-19T00:05:00.000Z',
  weekOf: '2026-08-17',
  firstWeek: '2025-11-03',
  lastWeek: '2026-08-10',
  ready: true,
  weeks: 41,
  weeksNeeded: 0,
  tested: 21,
  shown: 1,
  rows: [ROW],
  skipped: [],
  ...over,
});

const result = (levers: LeversResult['levers']): LeversResult => ({
  levers,
  features: FEATURES,
  gate: 26,
  useful: 39,
});

const setData = (levers: LeversResult['levers']) => {
  hookResult = { data: result(levers), isLoading: false, isError: false };
};

beforeEach(() => {
  enabledCalls = [];
  setData(payload());
});

const open = async () => {
  await userEvent.click(screen.getByRole('button', { name: /Що на що тягне/ }));
};

describe('LeversBlock — вантажиться лише на розгортанні', () => {
  /* ⚠️ Розгортання робить ОКРЕМЕ читання KV. Вішати його на кожне відкриття
     дашборда заради блоку, який дивляться раз на тиждень, — марна ціна. */
  it('до кліку хук вимкнений і жодного рядка немає', () => {
    render(<LeversBlock />);
    expect(enabledCalls.every((e) => e === false)).toBe(true);
    expect(screen.queryByText(/Подачі/)).not.toBeInTheDocument();
  });

  it('після кліку хук вмикається', async () => {
    render(<LeversBlock />);
    await open();
    expect(enabledCalls.at(-1)).toBe(true);
  });
});

describe('LeversBlock — три порожні стани, і жоден не підміняє інший', () => {
  it('розрахунку ще не було -> каже про понеділок, а не про брак даних', async () => {
    setData(null);
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/раз на тиждень, у ніч на понеділок/)).toBeInTheDocument();
    expect(screen.queryByText(/потрібно/)).not.toBeInTheDocument();
  });

  it('даних замало -> справжнє N, а не «звʼязків не знайдено»', async () => {
    setData(payload({ ready: false, weeks: 5, weeksNeeded: 21, tested: 0, shown: 0, rows: [] }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/Даних поки замало/)).toBeInTheDocument();
    expect(screen.getByText(/ще 21/)).toBeInTheDocument();
    expect(screen.queryByText(/жоден не витримав/)).not.toBeInTheDocument();
  });

  /* ⚠️ ЄДИНИЙ зі станів, що є твердженням про дані: перевірили — не витримало.
     Два попередні кажуть, що твердження ще немає взагалі. */
  it('перевірено й нічого не витримало -> так і каже, з кількістю', async () => {
    setData(payload({ tested: 21, shown: 0, rows: [] }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/жоден не витримав/)).toBeInTheDocument();
    expect(screen.getByText(/Перевірено 21/)).toBeInTheDocument();
  });
});

describe('LeversBlock — рядок-важіль', () => {
  it('показує обидві ознаки, момент і числа ефекту', async () => {
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/🌙 Сон/)).toBeInTheDocument();
    expect(screen.getByText(/📨 Подачі/)).toBeInTheDocument();
    expect(screen.getByText(/наступного тижня/)).toBeInTheDocument();
    expect(screen.getByText(/11.4/)).toBeInTheDocument();
    expect(screen.getByText(/5.6/)).toBeInTheDocument();
  });

  /* ⚠️ Формулювання НЕ каузальне. Метод міряє звʼязок у часі, а не причину, і
     підміна «ходить разом» на «підвищує» — найдешевший спосіб збрехати, не
     змінивши жодного числа. */
  it('не стверджує причинності', async () => {
    render(<LeversBlock />);
    await open();
    const body = document.body.textContent ?? '';
    expect(body).toMatch(/у тижнях, де було більше сну/);
    expect(body).not.toMatch(/підвищує|покращує|призводить|через це/);
  });

  it('відʼємний звʼязок читається як «менше», а не «більше»', async () => {
    setData(payload({ rows: [{ ...ROW, rho: -0.51 }] }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/менше подач/)).toBeInTheDocument();
    expect(screen.queryByText(/більше подач/)).not.toBeInTheDocument();
  });

  /* ⚠️ Рід і відмінок живуть у РЕЄСТРІ ознак, не в шаблоні. Перша версія
     збирала «коли {назва} вищий за звичайний» і давала на екрані «оцінка дня
     більше» та «коли роадмеп вищий» — числа правильні, українська ні. */
  it('фраза береться готовою з реєстру, а не збирається з прикметника', async () => {
    setData(payload({ rows: [{ ...ROW, from: 'roadmap', to: 'sleep', lag: 0 }] }));
    render(<LeversBlock />);
    await open();
    expect(
      screen.getByText(/у тижнях, де було більше тем роадмепу, — того ж тижня більше сну/),
    ).toBeInTheDocument();
  });

  it('«того ж тижня» для лагу 0', async () => {
    setData(payload({ rows: [{ ...ROW, lag: 0 }] }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/того ж тижня/)).toBeInTheDocument();
  });

  it('невідома ознака не рендериться й не валить блок', async () => {
    setData(payload({ rows: [{ ...ROW, from: 'вигадка' }], shown: 1 }));
    render(<LeversBlock />);
    await open();
    expect(screen.queryByText(/📨 Подачі/)).not.toBeInTheDocument();
    expect(screen.getByText(/Перевірено 21/)).toBeInTheDocument();
  });
});

describe('LeversBlock — чесність', () => {
  /* ⚠️ Без знаменника рядок читається як істина, а не як один вижилий із 21.
     Це не підпис: прибрати його означає збрехати формою, лишивши числа
     правильними. */
  it('поруч із рядками стоїть, скільки перевірено й скільки показано', async () => {
    render(<LeversBlock />);
    await open();
    const tail = screen.getByText(/Перевірено 21/);
    expect(within(tail).getByText(/могла трапитись випадково/)).toBeDefined();
    expect(tail.textContent).toMatch(/показано\s*1/);
  });

  it('називає ряди, які не перевірялись, і чому', async () => {
    setData(payload({ skipped: [{ key: 'roadmap', reason: 'майже стале значення' }] }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/Не перевірялись: Роадмеп/)).toBeInTheDocument();
    expect(screen.getByText(/забракло розкиду/)).toBeInTheDocument();
  });

  /* ⚠️ Єдине, що відрізняє свіжий результат від «крон упав три тижні тому, а
     рядки ті самі»: старий payload виглядає точно так само, як новий. */
  it('показує, коли рахувалось і по який тиждень', async () => {
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/РАХУВАЛОСЬ 19\.08/)).toBeInTheDocument();
    expect(screen.getByText(/ВІКНО ДО 10\.08/)).toBeInTheDocument();
  });

  /* ⚠️ ЗНАХІДКА РЕВʼЮ. Крон спрацьовує на першому тіку київського тижня —
     понеділок 00:05 Київ, тобто 21:05 UTC НЕДІЛІ. Читання через getUTCDate
     показувало добу назад, і мітка свіжості завжди суперечила `weekOf` у тому
     ж payload. Тест навмисно бере саме цю мить; він не залежить від часового
     поясу раннера, бо формат прибитий до Europe/Kyiv. */
  it('мить перед київською півноччю читається як НАСТУПНА доба', async () => {
    setData(payload({ computedAt: '2026-08-16T21:05:00.000Z', weekOf: '2026-08-17' }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/РАХУВАЛОСЬ 17\.08/)).toBeInTheDocument();
  });

  it('зимовий зсув теж київський, а не UTC', async () => {
    setData(payload({ computedAt: '2027-01-10T22:30:00.000Z' }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/РАХУВАЛОСЬ 11\.01/)).toBeInTheDocument();
  });

  /* Межі вікна — вже КИЇВСЬКІ дати рядком; розбирати їх через Date означало б
     внести зсув там, де його немає. */
  it('дата-рядок не проходить через часовий пояс', async () => {
    setData(payload({ lastWeek: '2026-08-10' }));
    render(<LeversBlock />);
    await open();
    expect(screen.getByText(/ВІКНО ДО 10\.08/)).toBeInTheDocument();
  });
});
