import type { CheckinSlot } from '../../api/schema.ts';
import {
  CHECKIN_DAY_SLOTS,
  CHECKIN_SLOT_NAMES,
  type CheckinProgress,
} from '../../lib/checkinProgress.ts';
import { UpdatedValue } from '../ui/UpdatedValue.tsx';
import './checkin-progress.css';

export function checkinProgressLabel(progress: CheckinProgress | null) {
  return progress
    ? progress.items.map((item) => `${item.name}: ${item.description.toLowerCase()}`).join('. ')
    : 'Статуси чек-інів уточнюються';
}

export function CheckinDayProgress({
  progress,
  compact = false,
  onSelect,
  selectedSlot,
}: {
  progress: CheckinProgress | null;
  compact?: boolean;
  onSelect?: (slot: CheckinSlot) => void;
  selectedSlot?: CheckinSlot | null;
}) {
  const items =
    progress?.items ??
    CHECKIN_DAY_SLOTS.map((slot) => ({
      slot,
      name: CHECKIN_SLOT_NAMES[slot],
      state: 'unknown',
      description: 'Статус уточнюється',
    }));
  const label = progress ? `Чек-іни за ${progress.date}` : 'Чек-іни за день';
  return (
    <div
      className={`checkin-day-progress ${compact ? 'is-compact' : ''}`}
      role={compact ? undefined : 'group'}
      aria-label={compact ? undefined : label}
      aria-hidden={compact || undefined}
    >
      {items.map((item) => {
        const mark = (
          <>
            <UpdatedValue
              identity={`checkin:${progress?.date}:${item.slot}`}
              value={item.state === 'done' ? 1 : 0}
            >
              <span className="checkin-day-mark" aria-hidden="true">
                {item.state === 'done'
                  ? '✓'
                  : item.state === 'closed'
                    ? '−'
                    : item.state === 'saving'
                      ? '…'
                      : ''}
              </span>
            </UpdatedValue>
            <span>{item.name}</span>
            {!compact && <small>{item.description}</small>}
          </>
        );
        return onSelect ? (
          <button
            key={item.slot}
            type="button"
            className="checkin-day-slot"
            data-state={item.state}
            aria-pressed={selectedSlot === item.slot}
            aria-label={`${item.name}: ${item.description}`}
            onClick={() => onSelect(item.slot)}
          >
            {mark}
          </button>
        ) : (
          <span
            key={item.slot}
            className="checkin-day-slot"
            data-state={item.state}
            title={`${item.name}: ${item.description}`}
          >
            {mark}
          </span>
        );
      })}
    </div>
  );
}
