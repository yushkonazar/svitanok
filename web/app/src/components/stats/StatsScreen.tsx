import { useStats } from '../../api/hooks.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { HabitsBlock } from './HabitsBlock.tsx';
import { CheckinBlock } from './CheckinBlock.tsx';
import { RhythmBlock } from './RhythmBlock.tsx';
import { InterestsBlock } from './InterestsBlock.tsx';
import { ReliabilityBlock } from './ReliabilityBlock.tsx';

// Вкладка «Статистика» (дизайн v2, Svitanok.dc.html): секції з ритмом 26px,
// кожна — заголовок із градієнтною крапкою та волосінню.
//
// Чек-ін одразу після звичок: це теж «як я живу», а не «як іде пошук», тож
// стоїть до воронки, а не між нею й майстерністю.

export function StatsScreen() {
  const { data, isLoading, isError, error, refetch } = useStats();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Не вдалося завантажити статистику'}
        onRetry={() => refetch()}
      />
    );
  }

  const s = data.stats;
  return (
    <div className="flex flex-col gap-[26px]">
      <HabitsBlock s={s} />
      <CheckinBlock s={s} />
      <RhythmBlock s={s} />
      {/* ⚠️ «Майстерність» ТИМЧАСОВО вимкнено (рішення власника 29.07): блок
          чекає на такий самий редизайн, як Чек-ін і Звички. Компонент
          (MasteryBlock.tsx) і всі його дані в /api/stats лишаються НЕТОРКАНИМИ
          — вимкнено лише рендер, щоб повернути одним рядком, а не збирати
          заново. */}
      <InterestsBlock s={s} />
      <ReliabilityBlock s={s} />
    </div>
  );
}
