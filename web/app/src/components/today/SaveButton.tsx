import { useToggleSaveItem } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { truncate } from '../../lib/format.ts';
import { haptic } from '../../telegram.ts';

// Кнопка 🔖 для факту/цитати/питання (дизайн v2 — тихий іконковий варіант).
// Макет Svitanok.dc.html на «Сьогодні» збереження не показує, але бекенд і
// «Ти зберіг» у статистиці на ньому тримаються — тож лишаємо функцію, вписавши
// у нову мову (маленький скляний квадрат у рядку-заголовку блоку).
// Стан — зі session-sticky набору (useSaved), бо savedList сервера обрізаний
// до top-8; title обрізаємо до 140 (як vanilla), id — за повним текстом.

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
          { onError: () => setSaved(kind, id, saved) },
        );
        haptic('success');
      }}
      className="grid h-7 w-7 flex-none place-items-center rounded-[9px] border text-[13px] transition-colors"
      style={
        saved
          ? { background: 'rgba(255,164,92,.16)', borderColor: 'var(--color-a2)' }
          : { background: 'var(--color-glass)', borderColor: 'var(--color-glassb)' }
      }
    >
      {saved ? '✅' : '🔖'}
    </button>
  );
}
