import { useState } from 'react';
import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { Card } from '../ui/primitives.tsx';
import { NewsItem } from './NewsItem.tsx';

// Група новин за темою (роадмеп v3, E3) — 1:1 з index.html newsTopicBlock
// (2298-2307): заголовок теми + айтеми + «Більше (N)» (розкриває more[]).

export function NewsGroup({ group }: { group: NewsGroupT }) {
  const [showMore, setShowMore] = useState(false);
  return (
    <Card title={`${topicEmoji(group.topic)} ${group.topic}`}>
      <div>
        {group.items.map((it) => (
          <NewsItem key={it.url} item={it} topic={group.topic} />
        ))}
        {showMore && group.more.map((it) => <NewsItem key={it.url} item={it} topic={group.topic} />)}
      </div>
      {group.more.length > 0 && (
        <button
          type="button"
          onClick={() => setShowMore((v) => !v)}
          className="mt-2 rounded-full bg-surface-2 px-4 py-1.5 text-sm font-medium transition-colors hover:bg-border"
        >
          {showMore ? 'Згорнути' : `Більше (${group.more.length})`}
        </button>
      )}
    </Card>
  );
}
