import { useState } from 'react';
import type { Finance } from '../../api/finance-schema.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { moneyLabel } from '../../lib/financeView.ts';
import { kyivParts, sumMoney } from '../../../../core/finance/planning.mjs';
import { financeRange } from './analytics-format.ts';
export type GoalHistoryRequest = {
  goalIds: string[];
  from: string;
  to: string;
  title?: string;
  scrollTop?: number;
  limit?: number;
  all?: boolean;
};
export function GoalHistory({
  finance,
  request,
  onClose,
  onTransaction,
  onMove,
}: {
  finance: Finance;
  request: GoalHistoryRequest;
  onClose: () => void;
  onTransaction: (
    id: string,
    date: string,
    position?: { scrollTop: number; limit: number; all: boolean },
  ) => void;
  onMove: (id: string) => void;
}) {
  const [all, setAll] = useState(request.all ?? false),
    [limit, setLimit] = useState(request.limit ?? 50);
  const rows = finance.goalMoves
    .filter(
      (m) =>
        (!request.goalIds.length || request.goalIds.includes(m.goalId)) &&
        (all ||
          (kyivParts(Date.parse(m.at)).date >= request.from &&
            kyivParts(Date.parse(m.at)).date <= request.to)),
    )
    .sort((a, b) => b.at.localeCompare(a.at));
  const internal = sumMoney(
      rows.filter((m) => m.movementKind !== 'external').map((m) => m.amountMinor),
    ),
    external = sumMoney(
      rows.filter((m) => m.movementKind === 'external').map((m) => m.amountMinor),
    );
  return (
    <Sheet
      label="Історія внесків"
      onClose={onClose}
      scrollKey="history"
      initialScrollTop={request.scrollTop ?? 0}
    >
      <div className="renewal-finance">
        <div className="renewal-section-head">
          <h2 className="text-xl font-bold">{request.title ?? 'Історія внесків'}</h2>
          <button className="renewal-secondary" aria-label="Закрити внески" onClick={onClose}>
            ×
          </button>
        </div>
        <p className="renewal-chart-note mt-3">
          {all ? 'Усі записані внески' : financeRange(request.from, request.to)}
        </p>
        <div className="renewal-segments mt-3">
          <button
            aria-pressed={!all}
            onClick={() => {
              setAll(false);
              setLimit(50);
            }}
          >
            За період
          </button>
          <button
            aria-pressed={all}
            onClick={() => {
              setAll(true);
              setLimit(50);
            }}
          >
            Уся історія
          </button>
        </div>
        <div className="renewal-metrics">
          <div className="renewal-metric">
            <span>Резерв / повернення</span>
            <strong>{moneyLabel(internal)}</strong>
          </div>
          <div className="renewal-metric">
            <span>Фактичні перекази</span>
            <strong>{moneyLabel(external)}</strong>
          </div>
        </div>
        {request.goalIds.length === 1 && (
          <button
            className="renewal-button w-full mt-4"
            onClick={() => onMove(request.goalIds[0]!)}
          >
            Внесок / повернення
          </button>
        )}
        {rows.slice(0, limit).map((m) => (
          <div className="analytics-operation" key={m.id}>
            <span>
              <b>{finance.goals.find((g) => g.id === m.goalId)?.name ?? 'Ціль'}</b>
              <small>
                {new Date(m.at).toLocaleString('uk-UA', { timeZone: 'Europe/Kyiv' })} ·{' '}
                {m.movementKind === 'external' ? 'Переказано' : 'Резерв'} ·{' '}
                {finance.accounts.find((a) => a.id === m.accountId)?.name ?? 'Рахунок'}
              </small>
              {m.transactionId ? (
                <button
                  className="renewal-link"
                  onClick={(event) =>
                    onTransaction(m.transactionId!, kyivParts(Date.parse(m.at)).date, {
                      limit,
                      all,
                      scrollTop:
                        event.currentTarget.closest<HTMLElement>('[role="dialog"]')?.scrollTop ?? 0,
                    })
                  }
                >
                  Переглянути операцію ↗
                </button>
              ) : (
                <small>Внутрішній резерв, без банківської операції</small>
              )}
            </span>
            <strong>{moneyLabel(m.amountMinor)}</strong>
          </div>
        ))}
        {!rows.length && <p className="renewal-muted mt-4">За цей вибір внесків немає.</p>}
        {rows.length > limit && (
          <button className="renewal-secondary w-full mt-3" onClick={() => setLimit((n) => n + 50)}>
            Показати ще внесків
          </button>
        )}
      </div>
    </Sheet>
  );
}
