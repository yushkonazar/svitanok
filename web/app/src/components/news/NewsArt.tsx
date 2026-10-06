import { useState } from 'react';
export function NewsArt({
  image,
  topic,
  compact = false,
  onUnavailable,
}: {
  image?: string;
  topic: string;
  compact?: boolean;
  onUnavailable?: () => void;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!image || failed === image) return null;
  return (
    <div className={`renewal-news-art ${compact ? 'is-compact' : ''}`} data-topic={topic}>
      <img
        src={image}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => {
          setFailed(image);
          onUnavailable?.();
        }}
      />
    </div>
  );
}
