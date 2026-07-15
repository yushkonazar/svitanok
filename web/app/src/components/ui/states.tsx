// Спільні стани завантаження/помилки вкладок (роадмеп v3, E3).

export function LoadingSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-28 animate-pulse rounded-card border border-border bg-surface" />
      ))}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="rounded-card border border-border bg-surface p-6 text-center">
      <div className="mb-1 text-2xl">⚠️</div>
      <div className="mb-3 text-sm text-muted">{message}</div>
      <button
        type="button"
        onClick={onRetry}
        className="rounded-full bg-surface-2 px-4 py-1.5 text-sm font-medium transition-colors hover:bg-border"
      >
        Спробувати ще
      </button>
    </div>
  );
}
