import { useState } from 'react';
import type { NewsStory } from '../../lib/newsStories.ts';
import { newsContext } from '../../lib/newsStories.ts';
import { newsSource } from '../../lib/newsSource.ts';
import { timeAgo } from '../../lib/timeAgo.ts';
import { NewsArt } from './NewsArt.tsx';
import { NewsIcon } from './NewsIcon.tsx';
export function NewsStoryCard({
  story,
  read,
  change,
  following,
  onOpen,
}: {
  story: NewsStory;
  read: boolean;
  change: 'new' | 'updated' | null;
  following: boolean;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false),
    item = story.item,
    image = item.imageProxy ?? item.image;
  const summary = newsContext(item.title, item.why ?? '', 220),
    publishers = new Set([item.url, ...(item.related?.map((n) => n.url) ?? [])].map(newsSource));
  return (
    <article className="news-story-card" data-change={change ?? undefined} data-read={read}>
      <button
        type="button"
        className="news-story-open"
        onClick={onOpen}
        aria-label={`Відкрити: ${item.title}`}
      >
        <span className="news-story-copy">
          <span className="news-story-meta">
            <span>{newsSource(item.url)}</span>
            {item.publishedAt && (
              <time dateTime={item.publishedAt}>{timeAgo(item.publishedAt)}</time>
            )}
            {following && (
              <span className="news-follow-mark" title="Стежиш за подією">
                <NewsIcon name="follow" />
              </span>
            )}
          </span>
          <span className="news-story-title">{item.title}</span>
          {summary && <span className="news-story-summary">{summary}</span>}
          <span className="news-story-tags">
            <span>{story.topic}</span>
            {change && (
              <b className="news-change-badge" data-kind={change}>
                {change === 'updated' ? 'Оновлено' : 'Нове'}
              </b>
            )}
            {publishers.size > 1 && <span>{publishers.size} видання</span>}
            {story.archived && <span>Збережена історія</span>}
            {read && (
              <span className="news-read-mark">
                <NewsIcon name="check" />
                Переглянуто
              </span>
            )}
          </span>
        </span>
        {image && !failed && (
          <span className="news-story-thumbnail">
            <NewsArt
              image={image}
              topic={story.topic}
              compact
              onUnavailable={() => setFailed(true)}
            />
          </span>
        )}
      </button>
    </article>
  );
}
