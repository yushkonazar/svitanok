import { useState } from 'react';
import type { NewsItem } from '../../api/briefing-schema.ts';
import { changedNewsWords } from '../../lib/newsStories.ts';
export function NewsComparison({ item }: { item: NewsItem }) {
  const [version, setVersion] = useState<'before' | 'now'>('now');
  if (!item.previousTitle) return null;
  const title = version === 'before' ? item.previousTitle : item.title,
    text = version === 'before' ? (item.previousSummary ?? '') : (item.why ?? '');
  return (
    <details className="news-comparison">
      <summary>
        {item.changeKind === 'coverage' ? 'Інше висвітлення цієї події' : 'Що змінилося'}
      </summary>
      <div className="news-compare-tabs">
        {(['before', 'now'] as const).map((v) => (
          <button type="button" key={v} aria-pressed={version === v} onClick={() => setVersion(v)}>
            {v === 'before' ? 'Було' : 'Стало'}
          </button>
        ))}
      </div>
      <div key={version} className="news-compare-text">
        <h3>
          {version === 'now'
            ? changedNewsWords(item.previousTitle, item.title).map((w, i) =>
                w.changed ? <mark key={i}>{w.text}</mark> : w.text,
              )
            : title}
        </h3>
        {text && (
          <p>
            {version === 'now'
              ? changedNewsWords(item.previousSummary ?? '', text).map((w, i) =>
                  w.changed ? <mark key={i}>{w.text}</mark> : w.text,
                )
              : text}
          </p>
        )}
      </div>
      {item.changeAt && (
        <p className="news-compare-time">
          Зміну помічено{' '}
          {new Date(item.changeAt).toLocaleString('uk-UA', {
            timeZone: 'Europe/Kyiv',
            day: 'numeric',
            month: 'short',
            hour: '2-digit',
            minute: '2-digit',
          })}
        </p>
      )}
    </details>
  );
}
