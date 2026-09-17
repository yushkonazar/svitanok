import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DeletionReceipts } from '../../api/schema.ts';

let hookResult: { data: DeletionReceipts | undefined; isLoading: boolean; isError: boolean };
let enabledCalls: boolean[];

vi.mock('../../telegram.ts', () => ({ haptic: () => {} }));
vi.mock('../../api/hooks.ts', () => ({
  useDeletionReceipts: (enabled: boolean) => {
    enabledCalls.push(enabled);
    return hookResult;
  },
}));

const { DeletionReceiptsBlock } = await import('./DeletionReceiptsBlock.tsx');

const DATA: DeletionReceipts = {
  retentionDays: 90,
  receipts: [
    {
      requestedAt: '2026-09-16T10:00:00.000Z',
      updatedAt: '2026-09-16T10:02:00.000Z',
      retainedUntil: '2026-12-15T10:00:00.000Z',
      status: 'failed',
      scope: 'all',
      error: 'VPS SDK не підтвердив видалення; локальні дані збережено.',
      stages: {
        queues: { status: 'completed', count: 2 },
        sdkSessions: { status: 'running', count: 0 },
        vectors: { status: 'pending', count: 0 },
        backups: { status: 'pending', count: 0 },
        local: { status: 'pending', count: 0, rows: 0, kvKeys: 0 },
      },
    },
  ],
};

beforeEach(() => {
  enabledCalls = [];
  hookResult = { data: DATA, isLoading: false, isError: false };
});

describe('DeletionReceiptsBlock — приватний read-only звіт', () => {
  it('не вантажить KV-list до явного розгортання', () => {
    render(<DeletionReceiptsBlock />);
    expect(enabledCalls.every((value) => value === false)).toBe(true);
    expect(screen.queryByText(/VPS SDK/)).not.toBeInTheDocument();
  });

  it('показує стан усіх етапів і безпечну причину, але не має мутації', async () => {
    render(<DeletionReceiptsBlock />);
    await userEvent.click(screen.getByRole('button', { name: /Історія видалень/ }));
    expect(enabledCalls.at(-1)).toBe(true);
    expect(screen.getByText('Потрібна увага')).toBeInTheDocument();
    expect(screen.getByText(/SDK-сесії/).parentElement).toHaveTextContent(/виконується/);
    expect(screen.getByText(/VPS SDK не підтвердив/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /забути|видалити/i })).not.toBeInTheDocument();
  });

  it('порожній стан не видає це за успішне видалення', async () => {
    hookResult = { data: { receipts: [], retentionDays: 90 }, isLoading: false, isError: false };
    render(<DeletionReceiptsBlock />);
    await userEvent.click(screen.getByRole('button', { name: /Історія видалень/ }));
    expect(screen.getByText(/Квитанцій за останні 90 діб ще немає/)).toBeInTheDocument();
    expect(screen.queryByText('Завершено')).not.toBeInTheDocument();
  });
});
