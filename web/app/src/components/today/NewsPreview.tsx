import { Link } from 'react-router-dom';
import { useBriefing, useNewsSnapshot, useSettings } from '../../api/hooks.ts';
import { newsDataSchema, readBlock } from '../../api/briefing-schema.ts';
import { newsSource } from '../../lib/newsSource.ts';
import { newsFeed } from '../../lib/newsFeed.ts';
export function NewsPreview() {
  const { data: settings } = useSettings();
  const { data } = useBriefing();
  const live = useNewsSnapshot();
  const groups =
    live.data?.groups ?? readBlock(data?.brief.blocks ?? [], 'news', newsDataSchema)?.groups ?? [];
  const item = newsFeed(groups, settings?.settings.mutedTopics, settings?.settings.news?.sources)[0]
    ?.item;
  if (!item) return null;
  return (
    <section>
      <div className="renewal-section-label">
        Поза твоїм вікном
        <Link to="/news" className="renewal-link">
          Уся стрічка →
        </Link>
      </div>
      <Link className="renewal-card block" to="/news">
        <span className="renewal-eyebrow">
          {newsSource(item.url)}
          {data?.demo ? ' · приклад матеріалу' : ''}
        </span>
        <h2 className="text-lg font-semibold mt-3 leading-snug">{item.title}</h2>
        {item.why && <p className="renewal-muted mt-3">{item.why}</p>}
        <span className="renewal-link block mt-4">Відкрити добірку →</span>
      </Link>
    </section>
  );
}
