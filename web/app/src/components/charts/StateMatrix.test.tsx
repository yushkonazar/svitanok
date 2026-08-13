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

const footer = () => screen.getByText(/зріз|×$/).textContent ?? '';

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

  it('повторний тап по тій самій клітинці згортає панель', async () => {
    const user = userEvent.setup();
    const { container } = render(<StateMatrix raw={withCauses(10, 20)} />);
    await user.click(worstCell(container));
    expect(screen.getByText('01.06')).toBeInTheDocument();
    await user.click(worstCell(container));
    expect(screen.queryByText('01.06')).toBeNull();
  });
});
