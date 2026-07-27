import type { NewsGroup as NewsGroupT } from '../../api/briefing-schema.ts';
import { topicEmoji } from '../../lib/topicEmoji.ts';
import { isReleaseTopic } from '../../lib/topicKind.ts';
import { Sheet } from '../ui/Sheet.tsx';
import { Ph } from '../ui/primitives.tsx';
import { NewsItem } from './NewsItem.tsx';
import { ReleaseItem } from './ReleaseItem.tsx';

// Розгорнутий перегляд теми (редизайн новин) — тап на плитку/чіп (і
// приглушену теж, без побічного зняття приглушення) відкриває це в тому
// самому Sheet, що вже є для вакансій. На відміну від колишньої NewsGroup
// (заголовок + перші N + «Більше»), тут ОДРАЗУ повний список: items++more
// сплющено — сheet і є «повний перегляд», ховати частину сенсу нема.

export function TopicSheet({ group, onClose }: { group: NewsGroupT; onClose: () => void }) {
  const all = [...group.items, ...group.more];
  const release = isReleaseTopic(group.topic);

  return (
    <Sheet onClose={onClose}>
      <div className="mb-3 flex items-center gap-2">
        <span className="text-lg">{topicEmoji(group.topic)}</span>
        <span className="text-[15px] font-bold tracking-[-0.01em]">{group.topic}</span>
      </div>

      {all.length === 0 ? (
        <Ph>Тут поки порожньо — спробуй пізніше.</Ph>
      ) : (
        <div className="flex max-h-[58vh] flex-col gap-2.5 overflow-y-auto">
          {all.map((it, i) => (
            <div key={it.url} className={i > 0 ? 'border-t border-glassb pt-2.5' : ''}>
              {release ? <ReleaseItem item={it} /> : <NewsItem item={it} topic={group.topic} />}
            </div>
          ))}
        </div>
      )}
    </Sheet>
  );
}
