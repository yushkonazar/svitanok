import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { FinanceForm } from './FinanceForm.tsx';
import { readFinanceDemo, resetFinanceDemo } from '../../api/finance-demo.ts';
import { postFinance } from '../../api/client.ts';
vi.mock('../../api/client.ts', () => ({
  postFinance: vi.fn(async () => ({ ok: true })),
  refreshFinanceBank: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ haptic: vi.fn() }));
const NOW = Date.parse('2026-10-16T15:00:00Z');
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  resetFinanceDemo();
});
afterEach(() => {
  cleanup();
  resetFinanceDemo();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});
function fixture() {
  const f = readFinanceDemo();
  f.policies = [
    {
      id: 'initial',
      effectiveAt: '1970-01-01T00:00:00.000Z',
      fareBps: 5000,
      commissionBps: 5000,
      fuelBps: 5000,
      tipsBps: 5000,
      thresholdMinor: 2700000,
      bonusFareBps: 5500,
    },
  ];
  f.settlements = [];
  f.taxiEntries = [
    {
      id: 'late-old-car',
      at: '2026-10-16T09:13:00.000Z',
      policyId: 'initial',
      netCashMinor: 99400,
      commissionMinor: 32300,
      fuelMinor: 155200,
      tipsMinor: 0,
      directMinor: 0,
      receivedCashMinor: 50000,
      paidWorkMinor: 0,
      cashReported: true,
      commissionReported: true,
      accountId: 'cash',
      note: '',
      revision: 0,
    },
  ];
  f.taxiWeeks = [
    {
      key: '2026-10-12',
      grossMinor: 131700,
      earnedMinor: -27900,
      heldMinor: 50000,
      settlementMinor: -77900,
      complete: true,
      closed: false,
      settled: false,
    },
  ];
  return f;
}
it('requires attribution of late entries, previews both periods and only then confirms 50/50 and Wednesday noon', async () => {
  const f = fixture(),
    close = vi.fn();
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FinanceForm request={{ kind: 'taxi-transition' }} finance={f} onClose={close} />
    </QueryClientProvider>,
  );
  fireEvent.change(screen.getByLabelText('Час переходу · Київ'), { target: { value: '12:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити розділення' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Для кожного');
  expect(postFinance).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole('combobox', { name: /каса.*пальне/ }), {
    target: { value: 'old' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Перевірити розділення' }));
  expect(screen.getByText(/21 жовт/)).toBeInTheDocument();
  expect(screen.getByText(/Щосереди о 12:00/)).toBeInTheDocument();
  expect(postFinance).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити перехід' }));
  await waitFor(() => expect(close).toHaveBeenCalledOnce());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'taxi-transition',
      version: f.version,
      payload: expect.objectContaining({
        effectiveAt: '2026-10-16T09:00:00.000Z',
        weekDay: 2,
        weekHour: 12,
        weekMinute: 0,
        thresholdMinor: null,
        fareBps: 5000,
        bonusFareBps: 5000,
        keepPreviousEntryIds: ['late-old-car'],
      }),
    }),
  );
});
it('keeps an attributed old-car shift in its old period when editing its money', async () => {
  const f = fixture();
  f.policies.push({
    ...f.policies[0]!,
    id: 'hybrid',
    effectiveAt: '2026-10-16T09:00:00.000Z',
    periodStart: true,
    weekDay: 2,
    weekHour: 12,
    weekMinute: 0,
    vehicleName: 'Гібрид',
    thresholdMinor: null,
    bonusFareBps: 5000,
  });
  f.taxiEntries[0]!.periodKey = '2026-10-12';
  render(
    <QueryClientProvider client={new QueryClient()}>
      <FinanceForm request={{ kind: 'taxi', id: 'late-old-car' }} finance={f} onClose={vi.fn()} />
    </QueryClientProvider>,
  );
  expect(screen.getByLabelText('Авто й робочий період')).toHaveValue('2026-10-12');
  fireEvent.change(screen.getByLabelText('Каса після комісії, ₴'), { target: { value: '1000' } });
  fireEvent.click(screen.getByRole('button', { name: 'Підтвердити й зберегти' }));
  await waitFor(() => expect(postFinance).toHaveBeenCalled());
  expect(postFinance).toHaveBeenCalledWith(
    expect.objectContaining({
      type: 'taxi-edit',
      payload: expect.objectContaining({
        entryId: 'late-old-car',
        periodKey: '2026-10-12',
        netCashMinor: 100000,
      }),
    }),
  );
});
