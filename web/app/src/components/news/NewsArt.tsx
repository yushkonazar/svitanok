import { useState } from 'react';
export function NewsArt({
  image,
  topic,
  compact = false,
}: {
  image?: string;
  topic: string;
  compact?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const icon =
    topic === 'CS2'
      ? '⌘'
      : topic === 'Футбол'
        ? '⚽'
        : topic === 'Наука'
          ? '✦'
          : topic.includes('технолог')
            ? '◈'
            : '◎';
  return (
    <div className={`renewal-news-art ${compact ? 'is-compact' : ''}`} data-topic={topic}>
      {image && !failed ? (
        <img
          src={image}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : (
        <>
          <span aria-hidden="true">{icon}</span>
          {!compact && <small>Ілюстрація · {topic}</small>}
        </>
      )}
    </div>
  );
}
