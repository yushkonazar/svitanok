import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MasteryBlock } from './MasteryBlock.tsx';
import type { MasteryTopic, Stats } from '../../api/schema.ts';

/* Майстерність. Арифметика покрита кореневим vitest (tests/mastery-rows.test.ts);
 * тут — те, чого там перевірити неможливо: що блок ПОКАЗУЄ саме розрив, що
 * неперевірені теми не потрапляють у рейтинг як нулі, і що прогноз мовчить,
 * коли темпу немає. */

vi.mock('../../telegram.ts', () => ({ haptic: () => {} }));

const topic = (over: Partial<MasteryTopic> & { id: string }): MasteryTopic => ({
  title: over.id,
  done: 0,
  total: 10,
  seen: 0,
  weak: 0,
  easePct: null,
  ...over,
});

const stats = (topics: MasteryTopic[], weekly: number[] = [1, 1, 1, 1]): Stats =>
  ({
    mastery: { topics, hints: [], themeOfWeek: null },
    roadmapWeekly: weekly.map((count, i) => ({ week: `2026-0${i + 1}-01`, count })),
    mock: { weakTopics: [], streak: 0 },
  }) as unknown as Stats;

describe('MasteryBlock — розрив', () => {
  it('показує ОБИДВІ смуги з числами, а не одну оцінку', () => {
    render(<MasteryBlock s={stats([topic({ id: 'HTTP', done: 8, total: 10, seen: 20, easePct: 30 })])} />);
    expect(screen.getByText('відмічено')).toBeInTheDocument();
    expect(screen.getByText('дається')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();
    expect(screen.getByText('30%')).toBeInTheDocument();
  });

  it('великий розрив позначений явно — це і є інсайт блоку', () => {
    render(<MasteryBlock s={stats([topic({ id: 'HTTP', done: 8, total: 10, seen: 20, easePct: 30 })])} />);
    expect(screen.getByText(/розрив 50/)).toBeInTheDocument();
  });

  it('дрібний розрив НЕ позначається — інакше значок втрачає сенс', () => {
    render(<MasteryBlock s={stats([topic({ id: 'A', done: 5, total: 10, seen: 20, easePct: 45 })])} />);
    // Саме ЗНАЧОК, не згадка слова в підказці під карткою.
    expect(screen.queryByText(/^розрив \d+$/)).toBeNull();
  });

  it('порядок рядків веде найбільший розрив', () => {
    const { container } = render(
      <MasteryBlock
        s={stats([
          topic({ id: 'рівна', done: 5, total: 10, seen: 20, easePct: 50 }),
          topic({ id: 'ілюзія', done: 10, total: 10, seen: 20, easePct: 20 }),
        ])}
      />,
    );
    const titles = [...container.querySelectorAll('.truncate')].map((e) => e.textContent);
    expect(titles[0]).toBe('ілюзія');
  });

  it('видно розмір вибірки — 50% з 6 питань і з 60 читаються по-різному', () => {
    render(<MasteryBlock s={stats([topic({ id: 'A', done: 5, total: 10, seen: 6, easePct: 50 })])} />);
    expect(screen.getByText(/6 питань/)).toBeInTheDocument();
  });
});

describe('MasteryBlock — неперевірені теми', () => {
  it('тема без питань НЕ стає нулем у рейтингу, а йде окремо', () => {
    render(
      <MasteryBlock
        s={stats([
          topic({ id: 'непитана', done: 10, total: 10, seen: 0, easePct: null }),
          topic({ id: 'питана', done: 5, total: 10, seen: 20, easePct: 50 }),
        ])}
      />,
    );
    expect(screen.getByText(/ЩЕ НЕ ПЕРЕВІРЕНО · 1/)).toBeInTheDocument();
    // У рейтингу лишилась тільки перевірена тема.
    expect(screen.getAllByText('відмічено')).toHaveLength(1);
  });

  it('коли перевіряти нічого — картки рейтингу немає взагалі', () => {
    render(<MasteryBlock s={stats([topic({ id: 'A', done: 3, total: 10 })])} />);
    expect(screen.queryByText(/ВІДМІЧЕНО ПРОТИ/)).toBeNull();
    expect(screen.getByText(/ЩЕ НЕ ПЕРЕВІРЕНО/)).toBeInTheDocument();
  });
});

describe('MasteryBlock — темп і прогноз', () => {
  const many = Array.from({ length: 8 }, (_, i) =>
    topic({ id: `t${i}`, done: 1, total: 10, seen: 20, easePct: 50 - i }),
  );

  it('прогноз показується, коли темп є', () => {
    render(<MasteryBlock s={stats([topic({ id: 'A', done: 0, total: 10 })], [2, 2, 2, 2])} />);
    expect(screen.getByText(/~5 тижнів за поточним темпом/)).toBeInTheDocument();
  });

  it('темпу немає -> прогнозу немає, і картка мовчить, а не пише «∞»', () => {
    render(<MasteryBlock s={stats([topic({ id: 'A', done: 0, total: 10 })], [0, 0, 0, 0])} />);
    expect(screen.queryByText(/за поточним темпом/)).toBeNull();
    expect(screen.queryByText(/ТЕМП/)).toBeNull();
  });

  it('довгий список згортається, кнопка каже скільки саме сховано', async () => {
    const user = userEvent.setup();
    render(<MasteryBlock s={stats(many)} />);
    expect(screen.getByRole('button', { name: /Ще 3/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Ще 3/ }));
    expect(screen.getAllByText('відмічено')).toHaveLength(8);
  });
});

describe('MasteryBlock — порожній стан', () => {
  it('без жодної теми — підказка, що робити, а не порожньо', () => {
    render(<MasteryBlock s={stats([])} />);
    expect(screen.getByText(/roadmap/)).toBeInTheDocument();
  });
});
