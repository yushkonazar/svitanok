import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { WeeklyReportScreen } from './WeeklyReportScreen.tsx';
import { fetchWeeklyReports } from '../../api/client.ts';
import { weeklyReportsSchema } from '../../api/weekly-report-schema.ts';

vi.mock('../../api/client.ts', () => ({ fetchWeeklyReports: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
function renderScreen() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <WeeklyReportScreen />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
function data() {
  return weeklyReportsSchema.parse({
    history: [
      {
        week: '2026-10-19',
        to: '2026-10-25',
        status: 'partial',
        createdAt: '2026-10-26T06:00:00Z',
      },
      { week: '2026-10-12', to: '2026-10-18', status: 'ready', createdAt: '2026-10-19T05:00:00Z' },
    ],
    report: {
      id: 'weekly:test',
      from: '2026-10-19',
      to: '2026-10-25',
      status: 'partial',
      asOf: '2026-10-26T06:00:00Z',
      createdAt: '2026-10-26T06:00:00Z',
      text: '📊 Тиждень 19.10 — 25.10\n• Гроші: Обліковано 100 грн.',
      missing: ['Особисті спостереження не прочитано'],
      details: {
        plan: {
          summary: {
            acceptedCommitments: 2,
            distinctResults: 1,
            completedDistinctResults: 1,
            lifecycle: { completed: 0, 'completed-late': 2 },
          },
          tasks: [],
        },
        finance: {
          summary: { expenseMinor: 10000, count: 2 },
          sourceTotals: {
            mono: { expenseMinor: 7000, count: 1 },
            manual: { expenseMinor: 3000, count: 1 },
          },
          review: { outflows: { confirmedExpenseMinor: 8000, pendingExpenseMinor: 2000 } },
          context: null,
        },
        personalPeriods: null,
        system: null,
      },
    },
  });
}
it('shows the short overview and keeps details expandable, with late completion distinct from XP', async () => {
  vi.mocked(fetchWeeklyReports).mockResolvedValue(data());
  renderScreen();
  await screen.findByText('Частковий огляд');
  expect(screen.getByText(/Обліковано 100 грн/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Справи й результати'));
  expect(screen.getByText('Завершені результати')).toBeInTheDocument();
  expect(screen.getByText('Виконано із запізненням')).toBeInTheDocument();
  expect(screen.getByText(/окремо від вчасності та XP/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('Фінанси за період'));
  expect(screen.getByText('Ручні записи')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Операції та уточнення →' })).toHaveAttribute(
    'href',
    '/finance?analytics=expenses&from=2026-10-19&to=2026-10-25',
  );
  expect(screen.getAllByText('Невідомо', { selector: 'span' }).length).toBeGreaterThan(0);
  expect(fetchWeeklyReports).toHaveBeenCalledOnce();
});
it('changes the saved week through a read, without offering generation or data mutation', async () => {
  vi.mocked(fetchWeeklyReports).mockResolvedValue(data());
  renderScreen();
  fireEvent.change(await screen.findByLabelText('Період'), { target: { value: '2026-10-12' } });
  await waitFor(() => expect(fetchWeeklyReports).toHaveBeenLastCalledWith('2026-10-12'));
  expect(screen.queryByRole('button', { name: /Сформувати|Запустити/ })).not.toBeInTheDocument();
});
it('renders a genuine empty workspace without fake demo reports', async () => {
  vi.mocked(fetchWeeklyReports).mockResolvedValue({ history: [], report: null });
  renderScreen();
  await screen.findByText('Огляду поки немає');
  expect(screen.getByText(/понеділок о 08:00/)).toBeInTheDocument();
});
it('renders saved model text as text, including strings that resemble HTML', async () => {
  const result = data();
  result.report!.text = '<script>untrusted report text</script>';
  vi.mocked(fetchWeeklyReports).mockResolvedValue(result);
  renderScreen();
  await screen.findByText('<script>untrusted report text</script>');
  expect(document.querySelector('script')).toBeNull();
});
