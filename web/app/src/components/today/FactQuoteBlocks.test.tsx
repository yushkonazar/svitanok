import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FactBlock, QuoteBlock } from './FactQuoteBlocks.tsx';
import { DailyContentTools } from './DailyContentTools.tsx';
import {
  fetchContentProfile,
  fetchContentArchive,
  postContentAction,
} from '../../api/daily-content.ts';
import { textHash } from '../../lib/format.ts';

vi.mock('../../api/daily-content.ts', () => ({
  fetchContentProfile: vi.fn(),
  fetchContentArchive: vi.fn(),
  postContentAction: vi.fn(),
}));
vi.mock('./SaveButton.tsx', () => ({
  SaveButton: ({ kind, id }: { kind: string; id: string }) => (
    <button data-testid={`save-${kind}`} data-id={id}>
      Зберегти
    </button>
  ),
}));
const fact = {
  id: 'f-one',
  title: 'Несподіване відкриття',
  fact: 'Перевірений факт із поясненням, чому він цікавий.',
  topic: 'nature',
  context: 'Додатковий контекст, який розгортається лише за бажанням.',
  sourceUrl: 'https://ocean.si.edu/a',
  sourceName: 'Smithsonian',
};
const quote = {
  id: 'q-one',
  text: 'Зосередься на тому, що залежить від тебе.',
  author: 'Епіктет',
  reference: 'Енхіридіон, 1',
  translation: 'Власний український переказ',
  sourceUrl: 'https://classics.mit.edu/a',
};
function show(children: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>);
}
beforeEach(() => {
  vi.mocked(fetchContentProfile).mockResolvedValue({
    date: '2026-10-10',
    preferences: { topics: ['nature', 'space'] },
    feedback: {},
  });
  vi.mocked(fetchContentArchive).mockResolvedValue({ items: [], next: null });
  vi.mocked(postContentAction).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

it('keeps legacy saved IDs, shows readable copy and identifies paraphrases without revealing details initially', () => {
  show(
    <>
      <FactBlock d={fact} />
      <QuoteBlock d={quote} />
    </>,
  );
  expect(screen.getByTestId('save-fact')).toHaveAttribute('data-id', textHash(fact.fact));
  expect(screen.getByTestId('save-quote')).toHaveAttribute(
    'data-id',
    textHash(`«${quote.text}» — ${quote.author}`),
  );
  expect(screen.getByText('Несподіване відкриття')).toBeVisible();
  expect(screen.getByText('Власний український переказ')).toBeVisible();
  expect(screen.getByText(fact.context)).not.toBeVisible();
  const details = screen.getByText('Чому це цікаво та джерело').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  expect(screen.getByText(fact.context)).toBeVisible();
  expect(screen.getByText('Smithsonian ↗')).toHaveAttribute('href', fact.sourceUrl);
});
it('reacts separately from saving, persists canonical item/date, and lets the same button clear a reaction', async () => {
  show(<FactBlock d={fact} />);
  const button = screen.getByRole('button', { name: 'Цікаво' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
  expect(postContentAction).toHaveBeenLastCalledWith(
    { type: 'feedback', kind: 'fact', id: 'f-one', date: '2026-10-10', signal: 'like' },
    expect.anything(),
  );
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'false'));
  expect(postContentAction).toHaveBeenLastCalledWith(
    expect.objectContaining({ signal: 'clear' }),
    expect.anything(),
  );
});
it('does not mark feedback as saved after a network failure and allows retry', async () => {
  vi.mocked(postContentAction).mockRejectedValueOnce(new Error('Спробуй ще раз.'));
  show(<FactBlock d={fact} />);
  const button = screen.getByRole('button', { name: 'Цікаво' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
  expect(await screen.findByRole('alert')).toHaveTextContent('Спробуй ще раз.');
  expect(button).toHaveAttribute('aria-pressed', 'false');
  fireEvent.click(button);
  await waitFor(() => expect(button).toHaveAttribute('aria-pressed', 'true'));
});
it('loads archive only on opening and handles the empty state without revealing the upcoming queue', async () => {
  show(<DailyContentTools />);
  expect(fetchContentArchive).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Архів фактів і цитат ↗' }));
  expect(
    await screen.findByText(
      'Архів поступово наповнюється. Сьогоднішній матеріал з’явиться тут завтра.',
    ),
  ).toBeVisible();
  expect(fetchContentArchive).toHaveBeenCalledTimes(1);
});
it('edits topics without changing today, disables an empty selection and saves only explicit preferences', async () => {
  show(<DailyContentTools />);
  fireEvent.click(screen.getByRole('button', { name: 'Теми добірки' }));
  const nature = await screen.findByRole('button', { name: 'Природа' });
  fireEvent.click(nature);
  fireEvent.click(screen.getByRole('button', { name: 'Космос' }));
  expect(screen.getByRole('button', { name: 'Зберегти вподобання' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Наука' }));
  fireEvent.click(screen.getByRole('button', { name: 'Зберегти вподобання' }));
  await waitFor(() =>
    expect(postContentAction).toHaveBeenCalledWith(
      { type: 'preferences', preferences: { topics: ['science'] } },
      expect.anything(),
    ),
  );
});
