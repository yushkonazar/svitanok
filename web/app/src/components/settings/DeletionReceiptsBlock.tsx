import { useState } from 'react';
import { useDeletionReceipts } from '../../api/hooks.ts';
import type { DeletionReceipt } from '../../api/schema.ts';
import { haptic } from '../../telegram.ts';
import { SectionLabel } from '../ui/primitives.tsx';

// Read-only звіт T2. Тут НАВМИСНО немає кнопки «забути»: незворотну дію
// створює policy у чаті зі словом-підтвердженням, а Mini App лише чесно
// показує вже зафіксований результат і стан відкладеного cleanup.

const STAGE_LABELS: Record<keyof DeletionReceipt['stages'], string> = {
  queues: 'Черги',
  sdkSessions: 'SDK-сесії',
  vectors: 'Вектори',
  backups: 'Drive backups',
  local: 'Локальні дані',
};

const STATUS_LABELS: Record<DeletionReceipt['status'], string> = {
  running: 'Виконується',
  completed: 'Завершено',
  failed: 'Потрібна увага',
  waiting_for_active_runs: 'Чекає активний прогін',
};

const STAGE_STATUS_LABELS: Record<DeletionReceipt['stages']['queues']['status'], string> = {
  pending: 'ще не почато',
  running: 'виконується',
  completed: 'готово',
};

function dateTime(value: string): string {
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Europe/Kyiv',
  }).format(new Date(value));
}

function objects(count: number): string {
  const last = count % 10;
  const lastTwo = count % 100;
  if (last === 1 && lastTwo !== 11) return `${count} об'єкт`;
  if (last >= 2 && last <= 4 && (lastTwo < 12 || lastTwo > 14)) return `${count} об'єкти`;
  return `${count} об'єктів`;
}

function stageCount(
  key: keyof DeletionReceipt['stages'],
  stage: DeletionReceipt['stages'][typeof key],
) {
  if (key === 'local') return `${stage.rows ?? 0} рядків · ${stage.kvKeys ?? 0} KV`;
  return objects(stage.count);
}

export function DeletionReceiptsBlock() {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError } = useDeletionReceipts(open);
  const receipts = data?.receipts ?? [];

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>ДАНІ Й ВИДАЛЕННЯ</SectionLabel>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          haptic('light');
          setOpen((value) => !value);
        }}
        className="flex items-center gap-1.5 self-start rounded-full border border-glassb bg-glass px-3 py-1.5 text-[11px] font-semibold text-tx2"
      >
        {open ? '− Згорнути квитанції' : '+ Історія видалень'}
      </button>

      {open && isLoading && <div className="text-[11px] text-tx3">Завантажую квитанції…</div>}

      {open && isError && (
        <div className="text-[11px] leading-[1.5] text-tx3">
          Не вдалося прочитати квитанції. Це не змінює стан видалення; спробуй оновити екран.
        </div>
      )}

      {open && !isLoading && !isError && receipts.length === 0 && (
        <div className="text-[11px] leading-[1.5] text-tx3">
          Квитанцій за останні {data?.retentionDays ?? 90} діб ще немає.
        </div>
      )}

      {open && !isLoading && !isError && receipts.length > 0 && (
        <div className="flex flex-col gap-2.5">
          {receipts.map((receipt) => (
            <div
              key={`${receipt.requestedAt}-${receipt.updatedAt}`}
              className="rounded-2xl border border-glassb bg-glass p-3.5"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                <span className="text-[12.5px] font-semibold">{STATUS_LABELS[receipt.status]}</span>
                <span className="font-mono text-[9.5px] text-tx3">
                  {dateTime(receipt.requestedAt)}
                </span>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5">
                {(Object.keys(STAGE_LABELS) as Array<keyof DeletionReceipt['stages']>).map(
                  (key) => {
                    const stage = receipt.stages[key];
                    return (
                      <div key={key} className="text-[10.5px] leading-snug text-tx2">
                        <span className="font-medium">{STAGE_LABELS[key]}: </span>
                        {STAGE_STATUS_LABELS[stage.status]} · {stageCount(key, stage)}
                      </div>
                    );
                  },
                )}
              </div>

              {receipt.error && (
                <p className="mt-2 text-[10.5px] leading-[1.45] text-tx3">{receipt.error}</p>
              )}
              <p className="mt-2 text-[9.5px] leading-snug text-tx3">
                Квитанція зберігається до {dateTime(receipt.retainedUntil)}. Деталей даних та
                зовнішніх ідентифікаторів тут немає.
              </p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
