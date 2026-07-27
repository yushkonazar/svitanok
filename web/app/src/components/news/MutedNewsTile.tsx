import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { haptic } from '../../telegram.ts';

// Приглушена тема (редизайн) — компактний сірий чіп із лічильником,
// тапабельний -> Sheet (peek без зняття приглушення). Активні теми тепер
// рендеряться HeroNewsCard/CompactNewsCard (не голою плиткою — фідбек
// власника: попередній варіант показував лише обрізаний заголовок без
// джерела/часу/дій, наче "порожню картку").

function tap(onOpen: () => void) {
  return () => {
    haptic('light');
    onOpen();
  };
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
