import type { ReactNode } from 'react';

// Спільні примітиви UI (роадмеп v3, E1) — відповідники vanilla .card / .statline /
// .subhead / плейсхолдерів, але як Tailwind-компоненти.

/** Картка блоку: заголовок веде емодзі (vanilla h3.plain — без акцентної смуги).
    action — необовʼязковий слот у хедері (напр. кнопка 🔖). */
export function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="mb-3 rounded-card border border-border bg-surface p-4 shadow-lg">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Рядок «ключ → значення» (vanilla .statline). first прибирає верхній роздільник. */
export function StatLine({
  label,
  value,
  first = false,
}: {
  label: ReactNode;
  value: ReactNode;
  first?: boolean;
}) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-1.5 text-sm ${
        first ? '' : 'border-t border-border/50'
      }`}
    >
      <span className="text-muted">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

/** Підзаголовок секції всередині картки (vanilla .subhead). */
export function SubHead({ children }: { children: ReactNode }) {
  return <div className="mb-2 mt-4 text-xs font-medium uppercase tracking-wide text-muted">{children}</div>;
}

/** Плейсхолдер порожнього стану (vanilla ph()). */
export function Ph({ children }: { children: ReactNode }) {
  return <div className="py-1 text-sm text-muted">{children}</div>;
}
