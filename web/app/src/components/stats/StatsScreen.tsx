import { useState } from 'react';
import { PageHeading } from '../ui/PageHeading.tsx';
import { StateStory } from './StateStory.tsx';
import { useStats } from '../../api/hooks.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { PeriodReview } from './PeriodReview.tsx';
import { CheckinBlock } from './CheckinBlock.tsx';
import { InterestsBlock } from './InterestsBlock.tsx';
import { ReliabilityBlock } from './ReliabilityBlock.tsx';
import { LeversBlock } from './LeversBlock.tsx';
import { HistoryBlock } from './HistoryBlock.tsx';

// Вкладка «Статистика» (дизайн v2, Svitanok.dc.html): секції з ритмом 26px,
// кожна — заголовок із градієнтною крапкою та волосінню.
//
// Чек-ін одразу після звичок: це теж «як я живу», а не «як іде пошук», тож
// стоїть до воронки, а не між нею й майстерністю.

export function StatsScreen() {
  const [days, setDays] = useState(7);
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
      <PageHeading
        eyebrow="ЩО ЗМІНЮЄТЬСЯ В ТОБІ"
        title="Не просто числа."
        accent="Твій ритм."
        description="Від щоденних відповідей до змін, які можна помітити."
      />
      <PeriodReview s={s} days={days} setDays={setDays} />
      <StateStory s={s} days={days} />
      <details className="renewal-card">
        <summary className="cursor-pointer text-sm font-semibold">
          Глибше: фактори, карта станів і виконання плану
        </summary>
        <div className="mt-5">
          <CheckinBlock s={s} />
        </div>
      </details>
      <details className="renewal-card">
        <summary className="cursor-pointer text-sm font-bold">Інтереси й робота Світанку</summary>
        <div className="mt-5 flex flex-col gap-6">
          <InterestsBlock s={s} />
          <ReliabilityBlock s={s} />
        </div>
      </details>
      {/* Хвіст екрана — ТРИ згорнуті блоки. Усі відповідають на питання, які
          ставлять рідко: «як іде пошук», «що я знаю, а що ні», «що було за
          місяці». Тримати їх розгорнутими посеред щоденних чисел означало б
          платити увагою щодня за погляд раз на тиждень.

          Ритм приїхав сюди останнім, теж на вимогу власника. Він про воронку,
          а вона рухається ТИЖНЯМИ: конверсії й «лежить без руху» не міняються
          від того, що ти вдруге за день відкрив застосунок. Найдієвіше з нього
          при цьому не губиться — рядок про вакансії без руху щодня приходить
          у /stats бота, тобто туди, де його пробігають очима.

          Майстерність приїхала сюди з середини на вимогу власника. Редизайн
          (29.07 блок був вимкнений із вердиктом «абсолютно не розумію, що мені
          показується») зробив його зрозумілим, але не щоденним — а це різні
          речі, і саме тому він тепер під кнопкою, а не в потоці. */}
      {/* Важелі — четвертий згорнутий. Гейт 26 тижнів даних означає, що
          місяцями блок казатиме лише «потрібно ще N»; тримати таке
          розгорнутим щодня — платити увагою за повідомлення, яке не
          змінюється. Поруч з «Історією» ще й тематично: обидва про
          довгий погляд назад, обидва читають окреме сховище. */}
      <LeversBlock />
      <HistoryBlock />
    </div>
  );
}
