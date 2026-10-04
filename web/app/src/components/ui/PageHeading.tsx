import type { ReactNode } from 'react';

export function PageHeading({
  eyebrow,
  title,
  accent,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  accent: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="renewal-page-heading">
      <div>
        <p className="renewal-eyebrow">{eyebrow}</p>
        <h1 className="renewal-title">
          {title}
          <br />
          <em>{accent}</em>
        </h1>
        {description && <p className="renewal-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}
