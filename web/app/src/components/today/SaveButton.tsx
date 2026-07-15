import { useStats, useToggleSaveItem } from '../../api/hooks.ts';
import { haptic } from '../../telegram.ts';

// Кнопка 🔖 збереження факту/цитати/питання (роадмеп v3, E2). Стан «збережено»
// походить зі stats-черги (savedList) — як vanilla hydrateSaved; тогл — мутація
// save_item/unsave_item з оптимістичним оновленням кешу.

export function SaveButton({ kind, id, title }: { kind: string; id: string; title: string }) {
  const { data } = useStats();
  const toggle = useToggleSaveItem();
  const saved = !!data?.stats.savedList.some((x) => x.kind === kind && x.id === id);

  return (
    <button
      type="button"
      aria-label={saved ? 'Прибрати зі збереженого' : 'Зберегти'}
      onClick={() => {
        toggle.mutate({ save: !saved, kind, id, title });
        haptic('success');
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-base transition-colors hover:bg-border"
    >
      {saved ? '✅' : '🔖'}
    </button>
  );
}
