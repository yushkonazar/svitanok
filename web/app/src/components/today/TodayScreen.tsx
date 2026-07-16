import { useBriefing } from '../../api/hooks.ts';
import {
  readBlock,
  weatherDataSchema,
  currencyDataSchema,
  mockDataSchema,
  factDataSchema,
  stoicDataSchema,
  onThisDayDataSchema,
} from '../../api/briefing-schema.ts';
import { shortDateFromIso } from '../../lib/dateLabel.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { WeatherBlock } from './WeatherBlock.tsx';
import { CurrencyBlock } from './CurrencyBlock.tsx';
import { QuestionBlock } from './QuestionBlock.tsx';
import { FactBlock, QuoteBlock } from './FactQuoteBlocks.tsx';
import { ThisDayBlock } from './ThisDayBlock.tsx';

// Вкладка «Сьогодні» (дизайн v2, Svitanok.dc.html). Порядок макета:
// погода (з циферблатом і графіком) → горизонт-роздільник → курс → питання →
// факт → думка → у цей день. Секції течуть одна за одною (без карток), розділені
// вертикальним ритмом 18px — як у макеті.

/** Роздільник-«горизонт»: дві волосінки з градієнтною крапкою-сонцем. */
function HorizonDivider() {
  return (
    <div className="flex items-center gap-2.5" aria-hidden="true">
      <div
        className="h-px flex-1"
        style={{ background: 'linear-gradient(90deg,transparent,rgba(255,164,92,.4))' }}
      />
      <div
        className="h-2 w-2 rounded-full"
        style={{ background: 'var(--grad)', boxShadow: '0 0 12px rgba(255,140,100,.7)' }}
      />
      <div
        className="h-px flex-1"
        style={{ background: 'linear-gradient(90deg,rgba(255,110,122,.4),transparent)' }}
      />
    </div>
  );
}

export function TodayScreen() {
  const { data, isLoading, isError, error, refetch } = useBriefing();

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        message={error instanceof Error ? error.message : 'Перевір з’єднання й спробуй ще раз.'}
        onRetry={() => refetch()}
      />
    );
  }

  const blocks = data.brief.blocks;
  const weather = readBlock(blocks, 'weather', weatherDataSchema);
  const currency = readBlock(blocks, 'currency', currencyDataSchema);
  const mock = readBlock(blocks, 'mock', mockDataSchema);
  const fact = readBlock(blocks, 'fact', factDataSchema);
  const stoic = readBlock(blocks, 'stoic', stoicDataSchema);
  const onthisday = readBlock(blocks, 'onthisday', onThisDayDataSchema);

  return (
    <div className="flex flex-col gap-[18px]">
      {weather && <WeatherBlock locations={weather.locations} />}
      <HorizonDivider />
      <CurrencyBlock d={currency} date={shortDateFromIso(data.brief.generatedAt)} />
      {mock && <QuestionBlock d={mock} />}
      {fact && <FactBlock d={fact} />}
      {stoic && <QuoteBlock d={stoic} />}
      {onthisday && <ThisDayBlock d={onthisday} />}
    </div>
  );
}
