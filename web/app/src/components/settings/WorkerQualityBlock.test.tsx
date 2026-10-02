import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { WorkerQuality } from '../../api/worker-quality-schema.ts';

let hookResult: {
  data: WorkerQuality[] | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
};
let telegram = true;

vi.mock('../../telegram.ts', () => ({ inTelegram: () => telegram }));
vi.mock('../../api/hooks.ts', () => ({ useWorkerQuality: () => hookResult }));

const { WorkerQualityBlock } = await import('./WorkerQualityBlock.tsx');

beforeEach(() => {
  telegram = true;
  hookResult = {
    data: [
      {
        worker: 'planner',
        results: 4,
        sample_size: 3,
        succeeded: 3,
        failed: 0,
        success_rate_pct: 100,
        avg_latency_ms: 820,
        max_latency_ms: 1100,
        feedback: { good: 2, bad: 1 },
      },
    ],
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  };
});

describe('WorkerQualityBlock — зрозумілий приватний огляд', () => {
  it('відділяє результати від викликів і не робить висновку на малій вибірці', () => {
    render(<WorkerQualityBlock />);
    expect(screen.getByText('Планувальник')).toBeInTheDocument();
    expect(screen.getByText('4 відповіді')).toBeInTheDocument();
    expect(screen.getByText(/Мало даних для оцінки \(3 викликів\)/)).toBeInTheDocument();
    expect(screen.getByText(/Оцінено 3 відповіді із 4 · 👍 2 · 👎 1/)).toBeInTheDocument();
    expect(screen.getByText(/не рейтинг/)).toBeInTheDocument();
  });

  it('не показує персональний блок поза Telegram', () => {
    telegram = false;
    render(<WorkerQualityBlock />);
    expect(screen.queryByText('ПРАЦІВНИКИ · 30 ДНІВ')).not.toBeInTheDocument();
  });
});
