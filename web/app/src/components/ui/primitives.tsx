import type { ReactNode } from 'react';

// Спільні примітиви (дизайн v2, Svitanok.dc.html).

/** Моно-лейбл секції: «КУРС НБУ», «ФАКТ ДНЯ» — розріджений капс. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-tx2">{children}</span>
  );
}

/** Заголовок блоку статистики: градієнтна крапка + назва + волосінь. */
export function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {/* Статична. Пробував тут перелив градієнта — на 7px його не видно
          взагалі (див. коментар до .sheen в index.css). */}
      <div className="h-[7px] w-[7px] rounded-[2px]" style={{ background: 'var(--grad)' }} />
      <span className="text-[13px] font-bold">{children}</span>
      <div className="h-px flex-1 bg-hair" />
    </div>
  );
}

/** Скляна картка (glass + рамка + 16px радіус). */
export function GlassCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-2xl border border-glassb bg-glass ${className}`}>{children}</div>
  );
}

/** Рядок «підпис → значення» (текст Manrope зліва, моно-число справа). */
export function StatRow({
  label,
  value,
  valueClass = '',
}: {
  label: ReactNode;
  value: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center">
      <span className="whitespace-nowrap text-[11.5px] font-medium text-tx2">{label}</span>
      <span className={`ml-auto font-mono text-xs font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}

/** Плейсхолдер порожнього стану. */
export function Ph({ children }: { children: ReactNode }) {
  return <div className="py-1 text-[12.5px] text-tx2">{children}</div>;
}

/**
 * Пояснення внизу картки: «що я зараз бачу і як це читати».
 *
 * Окремий примітив, а не просто <div>: графіки статистики стали щільними
 * (матриця станів, радари архетипів, ефект-сайзи), і без однакового,
 * ПЕРЕДБАЧУВАНО РОЗТАШОВАНОГО підпису кожна картка вимагає здогадки. Один
 * стиль на всі — щоб око вчилося шукати пояснення в одному місці.
 */
export function Hint({ children }: { children: ReactNode }) {
  return <div className="mt-2 text-[10px] leading-[1.45] text-tx3">{children}</div>;
}
