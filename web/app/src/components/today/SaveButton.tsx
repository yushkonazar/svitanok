import { useToggleSaveItem } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { truncate } from '../../lib/format.ts';
import { haptic } from '../../telegram.ts';

// Кнопка 🔖 збереження факту/цитати/питання (роадмеп v3, E2). Стан «збережено» —
// зі session-sticky набору (useSaved), а не напряму зі savedList: сервер обрізає
// savedList до top-8, тож без стабільної пам'яті позначка «губилась» би на
// витіснених елементах (ревʼю). title обрізаємо до 140 (як vanilla saveItemBtn);
// id лишається за ПОВНИМ текстом (textHash у картці) — сумісність KV.

export function SaveButton({ kind, id, title }: { kind: string; id: string; title: string }) {
  const { isSaved, setSaved } = useSaved();
  const toggle = useToggleSaveItem();
  const saved = isSaved(kind, id);

  return (
    <button
      type="button"
      aria-label={saved ? 'Прибрати зі збереженого' : 'Зберегти'}
      onClick={() => {
        const next = !saved;
        setSaved(kind, id, next);
        toggle.mutate(
          { save: next, kind, id, title: truncate(title, 140) },
          // Відкат sticky-набору при збої (хук відкочує лише кеш ['stats']).
          { onError: () => setSaved(kind, id, saved) },
        );
        haptic('success');
      }}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-base transition-colors hover:bg-border"
    >
      {saved ? '✅' : '🔖'}
    </button>
  );
}
