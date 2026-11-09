import type { ReactNode } from 'react';

export function PageHeading({
  eyebrow,
  title,
  accent,
  description,
  note,
  action,
  compact = false,
}: {
  eyebrow: string;
  title: string;
  accent: string;
  description?: string;
  note?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={`renewal-page-heading${compact ? ' renewal-page-heading-compact' : ''}`}>
      <div className={compact ? 'min-w-0' : undefined}>
        <p className="renewal-eyebrow">{eyebrow}</p>
        <h1 className="renewal-title">
          {title}
          {compact && ' '}
          <br />
          <em>{accent}</em>
        </h1>
        {description && <p className="renewal-muted">{description}</p>}
        {note && <p className="renewal-page-heading-note">{note}</p>}
      </div>
      {action}
    </div>
  );
}
