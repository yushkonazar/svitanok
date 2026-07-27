import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { haptic } from '../../telegram.ts';
import { SectionLabel } from '../ui/primitives.tsx';

// Горизонтальний скрол усіх тем поточного регіону (редизайн новин) — і
// приглушені теж, притлумлені (не ховаємо повністю): тап на будь-яку, і
// приглушену, відкриває Sheet (без побічного зняття приглушення).

export function TopicChipRow({
  groups,
  muted,
  onSelect,
}: {
  groups: NewsGroupT[];
  muted: Set<string>;
  onSelect: (group: NewsGroupT) => void;
}) {
  return (
    <div>
      <SectionLabel>{`ВАШІ ТЕМИ · ${groups.length}`}</SectionLabel>
      <div className="mt-2 flex gap-3 overflow-x-auto pb-1">
        {groups.map((g) => {
          const isMuted = muted.has(g.topic);
          return (
            <button
              key={g.topic}
              type="button"
              onClick={() => {
                haptic('light');
                onSelect(g);
              }}
              className="flex flex-none flex-col items-center gap-1.5"
              style={{ opacity: isMuted ? 0.45 : 1 }}
            >
              <div
                className="grid h-12 w-12 place-items-center rounded-full border-2 bg-glass text-lg"
                style={{ borderColor: isMuted ? 'var(--color-glassb)' : 'var(--color-a2)' }}
              >
                {topicEmoji(g.topic)}
              </div>
              <span className="max-w-[64px] truncate text-[10px] font-semibold text-tx2">
                {g.topic}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
