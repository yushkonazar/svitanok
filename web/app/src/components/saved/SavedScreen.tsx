import type { SavedItem } from '../../api/schema.ts';
import { useSavedArchive, useToggleSaveItem, useToggleSaveNews } from '../../api/hooks.ts';
import { useSaved } from '../../saved.tsx';
import { truncate } from '../../lib/format.ts';
import { openLink, haptic } from '../../telegram.ts';
import { SectionLabel } from '../ui/primitives.tsx';
import { Cascade, useCascade } from '../ui/Cascade.tsx';
import { LoadingSkeleton, ErrorState, EmptyState } from '../ui/states.tsx';

// Екран «Збережене» — окремий повноекранний маршрут (фідбек власника, п.6).
//
// Доти архів жив прев'ю всередині «Статистики» — плаский список без групування
// й без видалення, хоча бекенд (unsave_item / unsave_news) умів прибирати з
// першого дня. Тепер це своє місце: групи за типом + хрестик на кожному рядку.
//
// Групуємо ЛИШЕ те, що вже набрали: архів гортається сторінками по 50, і
// підтягнути «всі новини» окремо сервер не вміє — /api/saved віддає зріз
// спільного списку. Тому лічильник у шапці групи — це «стільки набрано»,
// а не «стільки є всього»; загальне число живе в підсумку зверху.

const KINDS: Array<{ id: string; icon: string; label: string }> = [
  { id: 'news', icon: '📰', label: 'Новини' },
  { id: 'quote', icon: '🏛', label: 'Думки' },
  { id: 'fact', icon: '🧠', label: 'Факти' },
  { id: 'question', icon: '🎤', label: 'Питання' },
];

/** Незнайомий kind не мовчить і не зникає — падає в «Інше» з нейтральною іконкою. */
const OTHER = { id: 'other', icon: '🔖', label: 'Інше' };

function kindOf(item: SavedItem) {
  return KINDS.some((k) => k.id === item.kind) ? item.kind : OTHER.id;
}

/** «2026-07-17» → «17.07». Порожнє/биле — без підпису, а не «NaN.NaN». */
function shortDate(ts: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ts);
  return m ? `${m[3]}.${m[2]}` : '';
}

function Row({ item, i }: { item: SavedItem; i: number }) {
  const delItem = useToggleSaveItem();
  const delNews = useToggleSaveNews();
  const { setSaved } = useSaved();
  // useCascade, а не обгортка: рядок тримає роздільники на first:border-t-0,
  // і зайвий div зробив би КОЖЕН рядок «першим» у своїй обгортці — межі зникли б.
  // Заморожений стиль тут критичний: видалення зсуває індекси сусідів знизу.
  const entry = useCascade(i, 40, 6);
  const busy = delItem.isPending || delNews.isPending;
  const date = shortDate(item.ts);

  const remove = () => {
    haptic('light');
    const id = item.id ?? '';
    // ⚠️ Зняти позначку в session-sticky наборі ОБОВʼЯЗКОВО, і саме тут.
    // Набір (saved.tsx) лише ДОПОВНЮЄТЬСЯ зі savedList — зникнення запису його
    // не чистить, і це навмисно: сервер ріже savedList до top-8, тож відсутність
    // не означає «не збережено». Тому єдиний спосіб зняти позначку — сказати про
    // це прямо. Без цього 🔖 на «Новинах»/«Сьогодні» лишався б активним для
    // видаленого запису до кінця сесії, а щоб зберегти його назад, довелося б
    // тиснути двічі (перший тап пішов би в порожній unsave).
    setSaved(item.kind, id, false);
    // Новини писались через save_news (kind='news', id=url) — і прибирати їх
    // треба тим самим шляхом. Через unsave_item вони б не знайшлись.
    if (item.kind === 'news') {
      delNews.mutate({ save: false, url: id, title: item.title, category: '' });
    } else {
      delItem.mutate({ save: false, kind: item.kind, id, title: item.title });
    }
  };

  const isLink = item.kind === 'news' && !!item.url;

  return (
    // ⚠️ Анімації ВИХОДУ тут свідомо немає — три спроби провалились зі
    // структурних причин, і кожна поміряна:
    //   1) власний стан «зникаю» + grid-rows: оптимістичний патч кешу
    //      (dropFromSaved у hooks.ts) прибирає запис МИТТЄВО, React розмонтовує
    //      рядок раніше, ніж CSS устигає щось зробити;
    //   2) AnimatePresence + exit={{height:0}}: framer-motion не інтерполює
    //      height від `auto`, тож вихід завершується миттєво (за 60мс рядка вже
    //      немає в DOM);
    //   3) layout: зсув іде від контейнера ГРУПИ, а не всередині нього, тож
    //      сусідні групи однаково стрибають.
    // Робочий шлях — затримати мутацію на час анімації, але тоді вихід з екрана
    // під час таймера ЗАГУБИТЬ видалення. Різкість краща за втрату даних.
    <div
      className="flex items-start gap-2.5 border-t border-hair py-2.5 first:border-t-0"
      style={entry}
    >
      <div className="min-w-0 flex-1">
        {isLink ? (
          <button
            type="button"
            onClick={() => openLink(item.url!)}
            className="block w-full text-left text-[12.5px] font-medium leading-[1.4] text-a2"
          >
            {truncate(item.title, 120)}
          </button>
        ) : (
          <span className="block text-[12.5px] font-medium leading-[1.4]">
            {truncate(item.title, 120)}
          </span>
        )}
        {date && <span className="mt-0.5 block font-mono text-[9.5px] text-tx3">{date}</span>}
      </div>
      <button
        type="button"
        onClick={remove}
        disabled={busy}
        aria-label={`Прибрати зі збереженого: ${truncate(item.title, 40)}`}
        className="grid h-7 w-7 flex-none place-items-center rounded-lg border border-glassb bg-glass transition-opacity disabled:opacity-40"
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--color-tx3)"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>
  );
}

export function SavedScreen() {
  const {
    data,
    isLoading,
    isError,
    error,
    refetch,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useSavedArchive();

  if (isLoading) return <LoadingSkeleton />;
  // Помилку на весь екран показуємо, ЛИШЕ якщо показувати більше нічого. Інакше
  // збій «Показати ще» на другій сторінці зніс би вже завантажену першу — на
  // мережевий блимок користувач втрачав би список, який тримає в руках.
  if (isError && !data)
    return (
      <ErrorState
        message={(error as Error)?.message ?? 'Спробуй ще раз'}
        onRetry={() => void refetch()}
      />
    );

  const items = data?.pages.flatMap((p) => p.items) ?? [];
  const total = data?.pages[0]?.total ?? 0;

  if (!items.length)
    return (
      <EmptyState
        icon={
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-tx2)"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1Z" />
          </svg>
        }
        title="Поки порожньо"
        text="Тисни 🔖 на новині, факті чи думці — і вони збережуться сюди."
      />
    );

  const groups = [...KINDS, OTHER]
    .map((k) => ({ ...k, list: items.filter((x) => kindOf(x) === k.id) }))
    .filter((g) => g.list.length > 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="font-mono text-[10.5px] font-medium text-tx3">
        УСЬОГО {total}
        {items.length < total && ` · НАБРАНО ${items.length}`}
      </div>

      {/* Cascade (заморожений) і на групах: видалення останнього запису групи
          зсуває наступні — живий delay рестартував би їм появу. */}
      {groups.map((g, gi) => (
        <Cascade key={g.id} i={gi} step={70}>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <SectionLabel>
                {g.icon} {g.label}
              </SectionLabel>
              <span className="font-mono text-[10px] font-medium text-tx3">{g.list.length}</span>
            </div>
            <div className="flex flex-col rounded-2xl border border-glassb bg-glass px-3.5 py-0.5">
              {g.list.map((item, i) => (
                <Row key={`${item.kind}:${item.id ?? i}`} item={item} i={i} />
              ))}
            </div>
          </div>
        </Cascade>
      ))}

      {hasNextPage && (
        <button
          type="button"
          disabled={isFetchingNextPage}
          onClick={() => void fetchNextPage()}
          className="rounded-full border border-glassb bg-glass py-2.5 text-[12px] font-semibold text-a2 disabled:opacity-50"
        >
          {isFetchingNextPage
            ? 'Вантажу…'
            : isError
              ? 'Не вийшло — спробувати ще'
              : `Показати ще (${total - items.length})`}
        </button>
      )}
    </div>
  );
}
