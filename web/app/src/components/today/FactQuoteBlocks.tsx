import type { FactData, StoicData } from '../../api/briefing-schema.ts';
import { CONTENT_TOPICS } from '../../../../core/brief/daily-content-display.mjs';
import { textHash } from '../../lib/format.ts';
import { SectionLabel } from '../ui/primitives.tsx';
import { SaveButton } from './SaveButton.tsx';
import { ContentFeedback } from './DailyContentTools.tsx';

function Topic({ value }: { value?: string }) {
  const name = value ? CONTENT_TOPICS[value as keyof typeof CONTENT_TOPICS] : null;
  return name ? <span className="daily-content-topic">{name}</span> : null;
}
export function FactBlock({ d }: { d: FactData }) {
  return (
    <article className="renewal-card daily-fact daily-content-card">
      <div className="flex items-center gap-2">
        <SectionLabel>ФАКТ ДНЯ</SectionLabel>
        <div className="ml-auto">
          <SaveButton kind="fact" id={textHash(d.fact)} title={d.fact} />
        </div>
      </div>
      <Topic value={d.topic} />
      {d.title && <h3 className="daily-content-title">{d.title}</h3>}
      <p className="daily-content-copy">{d.fact}</p>
      <details className="daily-content-details">
        <summary>Чому це цікаво та джерело</summary>
        {d.context && <p>{d.context}</p>}
        {d.sourceUrl?.startsWith('https://') && (
          <a className="renewal-link" href={d.sourceUrl} target="_blank" rel="noopener noreferrer">
            {d.sourceName ?? 'Перевірити джерело'} ↗
          </a>
        )}
      </details>
      <ContentFeedback kind="fact" item={d} />
    </article>
  );
}
export function QuoteBlock({ d }: { d: StoicData }) {
  // Keep legacy saved IDs: the exact combined string is shared with the old dashboard.
  const title = `«${d.text}» — ${d.author}`;
  const paraphrase = d.translation?.includes('переказ');
  return (
    <article className="renewal-card daily-quote daily-content-card">
      <div className="flex items-center gap-2">
        <SectionLabel>ЦИТАТА ДНЯ</SectionLabel>
        <div className="ml-auto">
          <SaveButton kind="quote" id={textHash(title)} title={title} />
        </div>
      </div>
      <Topic value={d.topic} />
      <div className="daily-quote-text">
        <span aria-hidden="true" className="daily-quote-mark">
          “
        </span>
        <p>{d.text}</p>
      </div>
      <p className="daily-quote-author">{d.author}</p>
      <p className="daily-quote-reference">{d.reference}</p>
      {d.translation && <span className="daily-content-provenance">{d.translation}</span>}
      <details className="daily-content-details">
        <summary>Контекст і оригінал</summary>
        {paraphrase && (
          <p>Це український переказ думки автора; формулювання відрізняється від оригіналу.</p>
        )}
        {d.context && <p>{d.context}</p>}
        {d.sourceUrl?.startsWith('https://') && (
          <a className="renewal-link" href={d.sourceUrl} target="_blank" rel="noopener noreferrer">
            {d.reference ?? 'Читати оригінал'} ↗
          </a>
        )}
      </details>
      <ContentFeedback kind="quote" item={d} />
    </article>
  );
}
