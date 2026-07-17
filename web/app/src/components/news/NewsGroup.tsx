import { useState } from 'react';
import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { cascade } from '../ui/Cascade.tsx';
import { NewsItem } from './NewsItem.tsx';

// Група новин за темою (дизайн v2, Svitanok.dc.html): емодзі + тема + лічильник
// у скляному бейджі + волосінь; далі айтеми; «Більше (N)» розкриває more[].

export function NewsGroup({ group }: { group: NewsGroupT }) {
  const [showMore, setShowMore] = useState(false);
  const total = group.items.length + group.more.length;

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-[9px]">
        <span className="text-base">{topicEmoji(group.topic)}</span>
        <span className="text-[15px] font-bold tracking-[-0.01em]">{group.topic}</span>
        <span className="rounded-md bg-glass px-1.5 py-0.5 font-mono text-[10px] font-semibold text-tx3">
          {total}
        </span>
        <div className="h-px flex-1 bg-hair" />
      </div>

      {/* Каскад лише всередині групи (індекси тут статичні): групи стоять одна
          під одною, тож око однаково читає хвилю зверху вниз. «Більше» рахує
          затримку від нуля — розкриття грає власний каскад, а не чекає хвостом
          за основними трьома. */}
      {group.items.map((it, i) => (
        <div key={it.url} style={cascade(i)}>
          <NewsItem item={it} topic={group.topic} />
        </div>
      ))}
      {showMore &&
        group.more.map((it, i) => (
          <div key={it.url} style={cascade(i)}>
            <NewsItem item={it} topic={group.topic} />
          </div>
        ))}

      {group.more.length > 0 && (
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="self-start whitespace-nowrap rounded-full border border-glassb bg-glass px-[13px] py-1.5 text-[11px] font-semibold text-tx2"
        >
          {showMore ? 'Згорнути' : `Більше (${group.more.length})`}
        </button>
      )}
    </div>
  );
}
