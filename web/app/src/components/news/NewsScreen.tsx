import { useState } from 'react';
import { useBriefing } from '../../api/hooks.ts';
import { readBlock, newsDataSchema } from '../../api/briefing-schema.ts';
import { Ph } from '../ui/primitives.tsx';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { NewsGroup } from './NewsGroup.tsx';

// Вкладка «Новини» (роадмеп v3, E3) — 1:1 з index.html renderNews (2262-2279):
// перемикач 🌍 Світ / 🇺🇦 Україна + групи поточного scope.

type Scope = 'world' | 'ua';

const SCOPES: { id: Scope; label: string }[] = [
  { id: 'world', label: '🌍 Світ' },
  { id: 'ua', label: '🇺🇦 Україна' },
];

export function NewsScreen() {
  const [scope, setScope] = useState<Scope>('world');
  const { data, isLoading, isError, error, refetch } = useBriefing();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Не вдалося завантажити новини'}
        onRetry={() => refetch()}
      />
    );
  }

  const news = readBlock(data.brief.blocks, 'news', newsDataSchema);
  if (!news || !news.groups.length) {
    return <Ph>Новин немає</Ph>;
  }

  const visible = news.groups.filter((g) => g.scope === scope);

  return (
    <div>
      <div className="mb-3 flex gap-2">
        {SCOPES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => setScope(s.id)}
            className={`flex-1 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              scope === s.id ? 'bg-accent text-on-accent' : 'bg-surface-2 text-muted hover:bg-border'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {visible.length ? (
        visible.map((g) => <NewsGroup key={`${g.scope}:${g.topic}`} group={g} />)
      ) : (
        <Ph>У цій категорії поки порожньо</Ph>
      )}
    </div>
  );
}
