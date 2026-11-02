import { Link } from 'react-router-dom';
import { useState } from 'react';
import { useBriefing, useNewsSnapshot, useSettings } from '../../api/hooks.ts';
import { newsDataSchema, readBlock } from '../../api/briefing-schema.ts';
import { newsSource } from '../../lib/newsSource.ts';
import { newsFeed } from '../../lib/newsFeed.ts';
import { NewsArt } from '../news/NewsArt.tsx';
export function NewsPreview() {
  const [selected, setSelected] = useState(0);
  const [failedImages, setFailedImages] = useState<Set<string>>(() => new Set());
  const { data: settings } = useSettings();
  const { data } = useBriefing();
  const live = useNewsSnapshot();
  const groups =
    live.data?.groups ?? readBlock(data?.brief.blocks ?? [], 'news', newsDataSchema)?.groups ?? [];
  const stories = newsFeed(
    groups,
    settings?.settings.mutedTopics,
    settings?.settings.news?.sources,
  ).slice(0, 3);
  const index = Math.min(selected, Math.max(0, stories.length - 1));
  const story = stories[index],
    item = story?.item;
  if (!item) return null;
  const image = item.imageProxy ?? item.image;
  return (
    <section>
      <div className="renewal-section-label">
        Поза твоїм вікном
        <Link to="/news" className="renewal-link">
          Уся стрічка →
        </Link>
      </div>
      <div className="renewal-card today-news">
        <Link className="today-news-story" to={`/news?article=${encodeURIComponent(item.url)}`}>
          {image && !failedImages.has(image) && (
            <div className="today-news-art">
              <NewsArt
                key={image}
                image={image}
                topic={story.topic}
                onUnavailable={() => setFailedImages((previous) => new Set([...previous, image]))}
              />
            </div>
          )}
          <span className="renewal-eyebrow">
            {newsSource(item.url)}
            {data?.demo ? ' · приклад матеріалу' : ''}
          </span>
          <h2 className="text-lg font-semibold mt-3 leading-snug">{item.title}</h2>
        </Link>
        {stories.length > 1 && (
          <div className="today-news-pager">
            <span className="renewal-muted">
              {index + 1} / {stories.length}
            </span>
            <div>
              <button
                type="button"
                aria-label="Попередня новина"
                disabled={index === 0}
                onClick={() => setSelected(index - 1)}
              >
                ‹
              </button>
              <button
                type="button"
                aria-label="Наступна новина"
                disabled={index === stories.length - 1}
                onClick={() => setSelected(index + 1)}
              >
                ›
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
