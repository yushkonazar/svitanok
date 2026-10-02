import { useWorkerQuality } from '../../api/hooks.ts';
import { inTelegram } from '../../telegram.ts';
import { pluralUk } from '../../lib/plural.ts';
import { SectionLabel, Ph } from '../ui/primitives.tsx';
import { SkeletonBar } from '../ui/states.tsx';

const LABELS: Record<string, string> = {
  analyst: 'Аналітик',
  editor: 'Редактор',
  finance: 'Фінанси',
  'mail-secretary': 'Пошта',
  planner: 'Планувальник',
  'place-search': 'Пошук закладів',
  'price-search': 'Ціни',
  researcher: 'Дослідник',
  tutor: 'Навчання',
};

function latency(value: number | null) {
  if (value == null) return '—';
  return value >= 1000 ? `${(value / 1000).toFixed(1)} с` : `${Math.round(value)} мс`;
}

export function WorkerQualityBlock() {
  const query = useWorkerQuality();
  if (!inTelegram()) return null;

  return (
    <section className="flex flex-col gap-3" aria-label="Якість працівників за 30 днів">
      <SectionLabel>ПРАЦІВНИКИ · 30 ДНІВ</SectionLabel>
      {query.isPending ? (
        <div className="flex flex-col gap-2" aria-label="Завантаження огляду">
          <SkeletonBar height={52} />
          <SkeletonBar height={52} />
        </div>
      ) : query.isError ? (
        <div className="rounded-xl border border-glassb bg-glass p-3">
          <Ph>Огляд зараз недоступний.</Ph>
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="mt-2 text-xs font-semibold text-accent"
          >
            Спробувати ще
          </button>
        </div>
      ) : query.data.length === 0 ? (
        <Ph>За останні 30 днів ще немає збережених результатів.</Ph>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {query.data.map((item) => {
              const enoughData = item.sample_size >= 5;
              const votes = item.feedback.good + item.feedback.bad;
              return (
                <article
                  key={item.worker}
                  className="rounded-xl border border-glassb bg-glass px-3 py-2.5"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-[13px] font-semibold">
                      {LABELS[item.worker] ?? item.worker.replaceAll('-', ' ')}
                    </h3>
                    <span className="shrink-0 text-[11px] text-tx2">
                      {item.results}{' '}
                      {pluralUk(item.results, ['відповідь', 'відповіді', 'відповідей'])}
                    </span>
                  </div>
                  <p className="mt-1 text-[11px] leading-relaxed text-tx2">
                    {enoughData && item.success_rate_pct != null
                      ? `Технічно успішно: ${item.success_rate_pct}%`
                      : `Мало даних для оцінки (${item.sample_size} викликів)`}
                    {' · '}у середньому {latency(item.avg_latency_ms)}
                  </p>
                  <p className="text-[11px] text-tx2">
                    {votes > 0
                      ? `Оцінено ${votes} ${pluralUk(votes, ['відповідь', 'відповіді', 'відповідей'])} із ${item.results} · 👍 ${item.feedback.good} · 👎 ${item.feedback.bad}`
                      : 'Ще немає оцінок'}
                  </p>
                </article>
              );
            })}
          </div>
          <p className="text-[10.5px] leading-snug text-tx3">
            Виклики — це робота моделі, не кількість задач. Технічна успішність і твої оцінки — лише
            сигнали, не рейтинг.
          </p>
        </>
      )}
    </section>
  );
}
