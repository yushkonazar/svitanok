import type { ReactNode } from 'react';

// Стани екранів (дизайн v2, Svitanok.dc.html): shimmer-скелетон, порожньо,
// помилка. Іконка в скляному квадраті + заголовок + пояснення + дія.

const SHIMMER =
  'linear-gradient(90deg,var(--color-glass) 25%,var(--color-glassb) 37%,var(--color-glass) 63%)';

/** Смуга-скелетон із shimmer-переливом. */
export function SkeletonBar({
  height,
  width = '100%',
  radius = 14,
  delay = 0,
}: {
  height: number;
  width?: string;
  radius?: number;
  delay?: number;
}) {
  return (
    <div
      style={{
        height,
        width,
        borderRadius: radius,
        background: SHIMMER,
        backgroundSize: '200% 100%',
        animation: `shimmer 1.4s linear ${delay}s infinite`,
      }}
    />
  );
}

export function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <SkeletonBar height={14} width="40%" radius={6} />
      <SkeletonBar height={52} />
      <SkeletonBar height={52} delay={0.2} />
      <div className="mt-2" />
      <SkeletonBar height={14} width="32%" radius={6} />
      <SkeletonBar height={52} delay={0.1} />
    </div>
  );
}

function Frame({
  icon,
  title,
  text,
  action,
  danger = false,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  action: ReactNode;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-2.5 px-5 py-[52px] text-center">
      {/* floatY — порожній/помилковий екран не має жодного іншого руху, одна
          повільна вісь на великому (56px) елементі оживляє його, не смикаючи. */}
      <div
        className="grid h-14 w-14 place-items-center rounded-[18px] border"
        style={{
          animation: 'floatY 3.4s ease-in-out infinite',
          ...(danger
            ? { background: 'rgba(255,120,120,.1)', borderColor: 'var(--color-neg)' }
            : { background: 'var(--color-glass)', borderColor: 'var(--color-glassb)' }),
        }}
      >
        {icon}
      </div>
      <div className="text-[15px] font-bold">{title}</div>
      <div className="max-w-[230px] text-[12.5px] leading-[1.5] text-tx2">{text}</div>
      {action}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <Frame
      danger
      icon={
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--color-neg)" strokeWidth="1.7" strokeLinecap="round">
          <path d="M12 8v5M12 16.5v.01" />
          <path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
        </svg>
      }
      title="Не вдалося завантажити"
      text={message}
      action={
        // Той самий акцентний CTA з відблиском, що «Оновити» в EmptyState:
        // це єдина дія на екрані, і скляна кнопка тут виглядала як другорядна.
        <button
          type="button"
          onClick={onRetry}
          className="sheen mt-1 rounded-full px-[18px] py-[9px] text-xs font-bold"
          style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
        >
          Спробувати ще
        </button>
      }
    />
  );
}

export function EmptyState({
  icon,
  title,
  text,
  onReload,
}: {
  icon: ReactNode;
  title: string;
  text: string;
  onReload?: () => void;
}) {
  return (
    <Frame
      icon={icon}
      title={title}
      text={text}
      action={
        onReload ? (
          <button
            type="button"
            onClick={onReload}
            className="sheen mt-1 rounded-full px-[18px] py-[9px] text-xs font-bold"
            style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
          >
            Оновити
          </button>
        ) : null
      }
    />
  );
}
