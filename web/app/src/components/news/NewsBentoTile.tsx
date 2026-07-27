import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { haptic } from '../../telegram.ts';

// Плитки сітки «Новини» (редизайн) — активна тема показує лідер-новину
// одразу (не треба тапати, щоб побачити хоч щось); приглушена — компактний
// сірий чіп із лічильником. Обидві тапабельні -> Sheet (TopicSheet.tsx).

function tap(onOpen: () => void) {
  return () => {
    haptic('light');
    onOpen();
  };
}

function pluralizeNova(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'нова';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'нові';
  return 'нових';
}

export function NewsBentoTile({ group, onOpen }: { group: NewsGroupT; onOpen: () => void }) {
  const lead = group.items[0];
  const count = group.items.length + group.more.length;

  return (
    <button
      type="button"
      onClick={tap(onOpen)}
      className="relative rounded-2xl border border-glassb bg-glass p-3.5 text-left"
    >
      {count > 0 && (
        <span
          className="absolute right-3 top-3 rounded-full px-1.5 py-0.5 font-mono text-[9px] font-bold"
          style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
        >
          {count} {pluralizeNova(count)}
        </span>
      )}
      <div className="text-xl">{topicEmoji(group.topic)}</div>
      <div className="mt-2 text-[13px] font-bold leading-tight">{group.topic}</div>
      {lead && (
        <div className="mt-1 line-clamp-2 text-[10.5px] leading-[1.4] text-tx3">{lead.title}</div>
      )}
    </button>
  );
}

/** Приглушена тема — компактний сірий чіп, теж тапабельний (peek без унмуту). */
export function MutedNewsTile({ group, onOpen }: { group: NewsGroupT; onOpen: () => void }) {
  const count = group.items.length + group.more.length;
  return (
    <button
      type="button"
      onClick={tap(onOpen)}
      className="flex items-center gap-2 rounded-xl border border-glassb bg-glass px-3 py-2.5 text-left opacity-50"
    >
      <span className="text-base">{topicEmoji(group.topic)}</span>
      <span className="min-w-0 flex-1 truncate text-[11.5px] font-semibold">{group.topic}</span>
      {count > 0 && <span className="font-mono text-[9.5px] text-tx3">{count}</span>}
    </button>
  );
}
