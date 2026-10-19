import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TogetherPlanner } from './TogetherPlanner.tsx';
import {
  fetchLeisure,
  fetchLeisureSuggestions,
  type LeisureWorkspace,
  type LeisureSuggestions,
} from '../../api/leisure.ts';
vi.mock('../../api/leisure.ts', async (original) => ({
  ...(await original<object>()),
  fetchLeisureSuggestions: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ inTelegram: () => false, tg: null }));
const fetchSuggestions = vi.mocked(fetchLeisureSuggestions);
let data: LeisureWorkspace;
beforeEach(async () => {
  fetchSuggestions.mockReset();
  data = await fetchLeisure();
});
function result(): LeisureSuggestions {
  const item = data.items[0]!;
  return {
    generatedAt: '2026-10-19T10:00Z',
    recommendedDate: '2026-10-22',
    note: 'Перед погодженням перевіримо план.',
    sources: [],
    days: [
      {
        date: '2026-10-22',
        notes: [],
        plans: [
          {
            id: 'one',
            anchorId: item.id,
            date: '2026-10-22',
            title: 'Виставка і вечір разом',
            stops: [
              {
                itemId: item.id,
                sessionId: null,
                startAt: '2026-10-22T15:00Z',
                endAt: '2026-10-22T17:00Z',
                tickets: false,
                reservation: false,
                title: item.title,
                address: item.address,
                venueId: item.venueId,
                sourceUrl: item.sourceUrl,
              },
            ],
            legs: [],
            reasons: ['Твій пріоритет'],
            warnings: ['Години потрібно підтвердити'],
            knownCostMinor: 0,
            unknownPrices: 1,
            transport: 'walk',
            confidence: 'needs-check',
            score: 50,
            alternatives: [],
          },
        ],
      },
    ],
  };
}
describe('together planning flow', () => {
  it('keeps the old plan when a replacement does not fit and locks its main activity', async () => {
    const initial = result(),
      plan = initial.days[0]!.plans[0]!,
      main = plan.stops[0]!;
    plan.stops.push({
      ...main,
      itemId: 'cafe',
      title: 'Кав’ярня',
      startAt: '2026-10-22T18:00Z',
      endAt: '2026-10-22T19:00Z',
    });
    plan.alternatives = [{ id: 'replacement', title: 'Інший заклад', priority: true }];
    fetchSuggestions
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce({ ...initial, days: [{ date: '2026-10-22', plans: [], notes: [] }] });
    render(<TogetherPlanner data={data} busy={false} onChoose={() => {}} send={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Підібрати варіанти' }));
    await screen.findByText(plan.title);
    fireEvent.change(screen.getByLabelText('Замінити заклад'), {
      target: { value: 'replacement' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('Попередній план збережено');
    expect(screen.getByText('Кав’ярня')).toBeInTheDocument();
    expect(fetchSuggestions.mock.calls[1]![0]).toMatchObject({
      anchorId: plan.anchorId,
      lockedStop: main,
      preferredFoodId: 'replacement',
    });
  });
  it('generates choices, saves a separate draft and opens final approval only on choice', async () => {
    fetchSuggestions.mockResolvedValue(result());
    const onChoose = vi.fn(),
      send = vi.fn().mockResolvedValue({ message: 'Чернетку збережено.' });
    render(<TogetherPlanner data={data} busy={false} onChoose={onChoose} send={send} />);
    fireEvent.change(screen.getByLabelText('Дата зустрічі'), { target: { value: '2026-10-22' } });
    fireEvent.click(screen.getByRole('button', { name: 'Підібрати варіанти' }));
    await screen.findByText('Виставка і вечір разом');
    expect(onChoose).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'У чернетки' }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        'draft',
        expect.objectContaining({ calendar: false, transport: 'walk' }),
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Обрати й перевірити' }));
    expect(onChoose).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Виставка і вечір разом' }),
    );
  });
  it('does not generate after invalid budget or retain results after window changes', async () => {
    fetchSuggestions.mockResolvedValue(result());
    render(<TogetherPlanner data={data} busy={false} onChoose={() => {}} send={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Бюджет на двох, ₴ · необов’язково'), {
      target: { value: 'помилка' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Підібрати варіанти' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Перевір бюджет');
    expect(fetchSuggestions).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Бюджет на двох, ₴ · необов’язково'), {
      target: { value: '1000' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Підібрати варіанти' }));
    await screen.findByText('Виставка і вечір разом');
    fireEvent.change(screen.getByLabelText('Маємо час до'), { target: { value: '21:00' } });
    expect(screen.queryByText('Виставка і вечір разом')).not.toBeInTheDocument();
  });
  it('supports choosing a day range without adding plans automatically', async () => {
    fetchSuggestions.mockResolvedValue(result());
    const send = vi.fn();
    render(<TogetherPlanner data={data} busy={false} onChoose={() => {}} send={send} />);
    fireEvent.click(screen.getByRole('button', { name: 'Кілька днів на вибір' }));
    fireEvent.change(screen.getAllByLabelText('Від', { exact: true })[0]!, {
      target: { value: '2026-10-22' },
    });
    fireEvent.change(screen.getAllByLabelText('До', { exact: true })[0]!, {
      target: { value: '2026-10-24' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Підібрати варіанти' }));
    await screen.findByText('Коли зустрінемося?');
    expect(fetchSuggestions).toHaveBeenCalledWith(
      expect.objectContaining({ from: '2026-10-22', to: '2026-10-24' }),
      expect.any(AbortSignal),
    );
    expect(send).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Обрати й перевірити' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Варіанти цього дня · 1' }));
    expect(screen.getByRole('button', { name: 'Обрати й перевірити' })).toBeInTheDocument();
  });
});
