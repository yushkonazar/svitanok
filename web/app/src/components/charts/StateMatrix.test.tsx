import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StateMatrix } from './StateMatrix.tsx';
import type { CheckinRaw } from '../../api/schema.ts';

/* Слот-фільтр карти станів. Арифметика розбору вікна покрита кореневим vitest
 * (tests/state-map.test.ts) — тут перевіряється те, чого там перевірити
 * неможливо: що перемикач справді ПЕРЕМАЛЬОВУЄ сітку, а не лише підсвічує
 * себе, і що вибір клітинки не переживає перемикання (інакше підпис унизу
 * описував би клітинку з попереднього зрізу даних). */

vi.mock('../../telegram.ts', () => ({ haptic: () => {} }));

/** n діб, де ранок бадьорий (4/4), а вечір сідає (2/2) — та сама пара чисел
 *  у різних слотах і є причина, з якої слот не можна зсипати в одну купу. */
const raw = (n: number): CheckinRaw => {
  const records: CheckinRaw['records'] = {};
  for (let i = 0; i < n; i++) {
    const d = `2026-06-${String(i + 1).padStart(2, '0')}`;
    records[d] = {
      morning: { energy: 4, mood: 4 },
      evening: { energy: 2, mood: 2 },
    };
  }
  return { days: 90, from: '2026-06-01', to: '2026-08-13', records };
};

/** Підпис під сіткою. Шукаємо через сусідство з легендою осей, а не за
 *  текстом: щойно панель деталей теж почала писати «N зрізів», пошук за
 *  текстом став знаходити два елементи й падати. */
const footer = () =>
  screen.getByText(/енергія ↑ · настрій →/).nextElementSibling?.textContent ?? '';

describe('StateMatrix — слот-фільтр', () => {
  it('замало зрізів -> нічого не малюємо (сітка з двох крапок читається як збій)', () => {
    const { container } = render(<StateMatrix raw={raw(5)} />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('«Усі» рахує всі слоти, фільтр — лише свій', async () => {
    const user = userEvent.setup();
    render(<StateMatrix raw={raw(10)} />);
    expect(footer()).toBe('20 зрізів'); // 10 діб × 2 слоти

    await user.click(screen.getByRole('button', { name: /Вечір/ }));
    expect(footer()).toBe('10 зрізів');
  });

  it('ранок і вечір дають РІЗНІ клітинки — заради цього все й робилось', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={raw(10)} />);
    const filled = () =>
      [...container.querySelectorAll('svg text')]
        .filter((t) => t.getAttribute('font-size') === '12')
        .map((t) => `${t.getAttribute('y')}:${t.textContent}`);

    await user.click(screen.getByRole('button', { name: /Ранок/ }));
    const morning = filled();
    await user.click(screen.getByRole('button', { name: /Вечір/ }));
    const evening = filled();

    expect(morning).toHaveLength(1);
    expect(evening).toHaveLength(1);
    expect(morning[0]).not.toBe(evening[0]); // різна висота = різна енергія
  });

  it('перемикання слоту знімає вибір клітинки, а не описує чужу', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={raw(10)} />);
    const cells = container.querySelectorAll('svg g');

    await user.click(cells[0]!);
    expect(footer()).toMatch(/енергія \d · настрій \d/);

    await user.click(screen.getByRole('button', { name: /Ранок/ }));
    expect(footer()).toBe('10 зрізів');
  });

  it('плюрал не ламається на 2 і 21', () => {
    const { unmount } = render(<StateMatrix raw={raw(11)} />);
    expect(footer()).toBe('22 зрізи');
    unmount();
    render(<StateMatrix raw={raw(6)} />);
    expect(footer()).toBe('12 зрізів');
  });

  it('усі чотири фільтри доступні як кнопки з назвами', () => {
    render(<StateMatrix raw={raw(10)} />);
    const names = ['Усі', 'Ранок', 'День', 'Вечір'];
    for (const nm of names) {
      expect(screen.getByRole('button', { name: new RegExp(nm) })).toBeInTheDocument();
    }
  });
});

/* Фільтр періоду. Він уміє лише ЗВУЖУВАТИ: глибших за 90 діб даних на клієнті
 * немає (стеля CPU-бюджету воркера), тож ширші пункти не показуються взагалі —
 * кнопка, яка обіцяє період і не змінює нічого, гірша за її відсутність. */
describe('StateMatrix — фільтр періоду', () => {
  const PERIODS = [
    { days: 30, label: '30д' },
    { days: 90, label: '90д' },
  ];

  /** n діб поспіль, найсвіжіша — `to`. */
  const spread = (n: number): CheckinRaw => {
    const records: CheckinRaw['records'] = {};
    const d = new Date('2026-08-13T00:00:00Z');
    for (let i = 0; i < n; i++) {
      records[d.toISOString().slice(0, 10)] = { evening: { energy: 3, mood: 3 } };
      d.setUTCDate(d.getUTCDate() - 1);
    }
    return { days: 90, from: '2026-05-16', to: '2026-08-13', records };
  };

  it('за замовчуванням — повне вікно', () => {
    render(<StateMatrix raw={spread(60)} periods={PERIODS} />);
    expect(screen.getByText('ЗА 90 ДІБ')).toBeInTheDocument();
    expect(footer()).toBe('60 зрізів');
  });

  it('вужчий період справді відрізає дані, а не лише підпис', async () => {
    const user = userEvent.setup();
    render(<StateMatrix raw={spread(60)} periods={PERIODS} />);
    await user.click(screen.getByRole('button', { name: '30д' }));
    expect(footer()).toBe('30 зрізів');
    expect(screen.getByText('ЗА 30 ДІБ')).toBeInTheDocument();
  });

  it('причини рахуються на ВИБРАНОМУ періоді, не на повному вікні', async () => {
    const user = userEvent.setup();
    const records: CheckinRaw['records'] = {};
    const d = new Date('2026-08-13T00:00:00Z');
    for (let i = 0; i < 60; i++) {
      // Через день — важкий стан (1,1) і добрий (5,5): без «решти» причини не
      // рахуються взагалі, бо порівнювати нема з чим.
      // Втома лише в СТАРІШІЙ половині: у 30-денному вікні її бути не має.
      const hard = i % 2 === 0;
      records[d.toISOString().slice(0, 10)] = hard
        ? { evening: { energy: 1, mood: 1, ...(i >= 30 ? { blocker: ['tired' as const] } : {}) } }
        : { evening: { energy: 5, mood: 5 } };
      d.setUTCDate(d.getUTCDate() - 1);
    }
    const raw90: CheckinRaw = { days: 90, from: '2026-05-16', to: '2026-08-13', records };
    const { container } = render(<StateMatrix raw={raw90} periods={PERIODS} />);
    const worst = container.querySelectorAll('svg g')[20]!;

    await user.click(worst);
    expect(screen.getByText(/Втома/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '30д' }));
    await user.click(container.querySelectorAll('svg g')[20]!);
    expect(screen.queryByText(/Втома/)).toBeNull();
  });

  it('зміна періоду скидає вибір клітинки', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={spread(60)} periods={PERIODS} />);
    await user.click(container.querySelectorAll('svg g')[12]!);
    expect(footer()).toMatch(/енергія 3 · настрій 3/);
    await user.click(screen.getByRole('button', { name: '30д' }));
    expect(footer()).toBe('30 зрізів');
  });

  it('без переданих періодів перемикача немає взагалі', () => {
    render(<StateMatrix raw={spread(60)} />);
    expect(screen.queryByRole('button', { name: '30д' })).toBeNull();
  });

  it('період, глибший за вікно, не показується — він нічого б не змінив', () => {
    render(
      <StateMatrix
        raw={{ ...spread(20), days: 30 }}
        periods={[...PERIODS, { days: 365, label: 'рік' }]}
      />,
    );
    expect(screen.queryByRole('button', { name: 'рік' })).toBeNull();
    expect(screen.queryByRole('button', { name: '90д' })).toBeNull();
  });

  it('вузький період не заганяє в глухий кут — сітка й перемикачі лишаються', async () => {
    const user = userEvent.setup();
    // 40 діб усього: у 30-денному вікні лишиться 30 — більше за гейт.
    render(<StateMatrix raw={spread(40)} periods={PERIODS} />);
    await user.click(screen.getByRole('button', { name: '30д' }));
    expect(screen.getByRole('button', { name: '90д' })).toBeInTheDocument();
  });
});

describe('StateMatrix — підпис осей', () => {
  it('пояснює напрямок обох осей (сітка без цього нечитабельна)', () => {
    const { container } = render(<StateMatrix raw={raw(10)} />);
    expect(within(container).getByText(/енергія ↑ · настрій →/)).toBeInTheDocument();
  });
});

/* Панель деталей — те, заради чого власник це й просив: «зараз це просто
 * сітка, яка показує, скільки разів я обирав ту чи іншу плитку». */
describe('StateMatrix — деталі клітинки', () => {
  /** n важких вечорів (утома) + m добрих (ранній старт), щоб було з чим порівнювати. */
  const withCauses = (bad: number, good: number): CheckinRaw => {
    const records: CheckinRaw['records'] = {};
    for (let i = 0; i < bad; i++) {
      records[`2026-06-${String(i + 1).padStart(2, '0')}`] = {
        evening: { energy: 1, mood: 1, dayScore: 2, blocker: ['tired'] },
      };
    }
    for (let i = 0; i < good; i++) {
      records[`2026-07-${String(i + 1).padStart(2, '0')}`] = {
        evening: { energy: 5, mood: 5, dayScore: 4, helper: ['early'] },
      };
    }
    return { days: 90, from: '2026-06-01', to: '2026-08-13', records };
  };

  /** Клітинка «енергія 1 · настрій 1» — лівий нижній кут сітки. */
  const worstCell = (container: HTMLElement) => container.querySelectorAll('svg g')[20]!;

  it('тап відкриває ДАТИ — і саме їх, а не лише лічильник', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText('01.06')).toBeInTheDocument();
    expect(screen.getByText(/10 вечорів|10 зрізів/)).toBeInTheDocument();
  });

  it('показує причини з часткою й нормою, а не сам перелік', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText(/Втома/)).toBeInTheDocument();
    expect(screen.getByText('↑ 10/10')).toBeInTheDocument();
    expect(screen.getByText('норма 0%')).toBeInTheDocument();
  });

  /* ⚠️ Регресія за побудовою: кратність на чистому розділенні (10 із 10 проти
   * 0 з 20) дає «×70 частіше» — число, що стрибає вдесятеро від однієї нової
   * доби. Виглядає як точність, є фальшивкою; на екрані його бути не мусить. */
  it('кратність НЕ показується — вона лише для сортування', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    await user.click(worstCell(container));
    expect(screen.queryByText(/×\d/)).toBeNull();
  });

  it('відсутність теж читається: помічник, якого тут не буває', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText(/Ранній старт/)).toBeInTheDocument();
    expect(screen.getByText('↓ 0/10')).toBeInTheDocument();
  });

  it('оцінка таких днів іде поруч зі своєю нормою', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText(/Оцінка таких днів/)).toBeInTheDocument();
    expect(screen.getByText(/зазвичай 4/)).toBeInTheDocument();
  });

  it('замало даних -> дати є, а висновків НЕМАЄ (і про це сказано)', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(3, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText('01.06')).toBeInTheDocument();
    expect(screen.getByText(/Замало даних/)).toBeInTheDocument();
    expect(screen.queryByText(/частіше/)).toBeNull();
  });

  it('порожня клітинка каже прямо, що такого стану не було', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(0, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText(/не був жодного разу/)).toBeInTheDocument();
  });

  /* F9 з аудиту C2: тапи по чартах були доступні лише мишею/пальцем. Клітинка
   * несе поведінку (відкриває деталі), тож мусить бути кнопкою й для клавіші —
   * інакше половина карти просто недосяжна. */
  it('клітинка — кнопка з підписом, а не німий прямокутник', () => {
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    const cell = worstCell(container);
    expect(cell.getAttribute('role')).toBe('button');
    expect(cell.getAttribute('tabindex')).toBe('0');
    expect(cell.getAttribute('aria-label')).toMatch(/енергія 1.*настрій 1.*10/i);
  });

  it('Enter відкриває деталі так само, як тап', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    (worstCell(container) as SVGElement & { focus: () => void }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('01.06')).toBeInTheDocument();
  });

  it('пробіл теж відкриває (обидві клавіші — стандарт для кнопки)', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    (worstCell(container) as SVGElement & { focus: () => void }).focus();
    await user.keyboard(' ');
    expect(screen.getByText('01.06')).toBeInTheDocument();
  });

  it('обрана клітинка позначена для скрінрідера, не лише обведенням', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    expect(worstCell(container).getAttribute('aria-pressed')).toBe('false');
    await user.click(worstCell(container));
    expect(worstCell(container).getAttribute('aria-pressed')).toBe('true');
  });

  it('порожня клітинка теж досяжна — «тут не був жодного разу» це відповідь', () => {
    const { container } = render(<StateMatrix raw={withCauses(0, 20)} />);
    expect(worstCell(container).getAttribute('aria-label')).toMatch(/жодного разу|0/);
  });

  it('повторний тап по тій самій клітинці згортає панель', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText('01.06')).toBeInTheDocument();
    await user.click(worstCell(container));
    expect(screen.queryByText('01.06')).toBeNull();
  });
});
