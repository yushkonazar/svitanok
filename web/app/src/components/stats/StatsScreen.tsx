import { useStats } from '../../api/hooks.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { HabitsBlock } from './HabitsBlock.tsx';
import { CheckinBlock } from './CheckinBlock.tsx';
import { RhythmBlock } from './RhythmBlock.tsx';
import { InterestsBlock } from './InterestsBlock.tsx';
import { ReliabilityBlock } from './ReliabilityBlock.tsx';
import { MasteryBlock } from './MasteryBlock.tsx';
import { HistoryBlock } from './HistoryBlock.tsx';

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
      <InterestsBlock s={s} />
      <ReliabilityBlock s={s} />
      {/* Хвіст екрана — два згорнуті блоки. Обидва відповідають на питання, які
          ставлять рідко: «що я знаю, а що ні» й «що було за місяці». Тримати їх
          розгорнутими посеред щоденних чисел означало б платити увагою щодня за
          погляд раз на тиждень.

          Майстерність приїхала сюди з середини на вимогу власника. Редизайн
          (29.07 блок був вимкнений із вердиктом «абсолютно не розумію, що мені
          показується») зробив його зрозумілим, але не щоденним — а це різні
          речі, і саме тому він тепер під кнопкою, а не в потоці. */}
      <MasteryBlock s={s} />
      <HistoryBlock />
    </div>
  );
}
