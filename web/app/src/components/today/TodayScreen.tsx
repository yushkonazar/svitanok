import { useBriefing, useLiveWeather } from '../../api/hooks.ts';
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
import { useGeolocation } from '../../lib/useGeolocation.ts';
import { LoadingSkeleton, ErrorState } from '../ui/states.tsx';
import { cascade } from '../ui/Cascade.tsx';
import { WeatherBlock } from './WeatherBlock.tsx';
import { CurrencyBlock } from './CurrencyBlock.tsx';
import { QuestionBlock } from './QuestionBlock.tsx';
import { FactBlock, QuoteBlock } from './FactQuoteBlocks.tsx';
import { ThisDayBlock } from './ThisDayBlock.tsx';

// Вкладка «Сьогодні» (дизайн v2, Svitanok.dc.html). Порядок макета:
// погода (з циферблатом і графіком) → горизонт-роздільник → курс → питання →
// факт → думка → у цей день. Секції течуть одна за одною (без карток), розділені
// вертикальним ритмом 18px — як у макеті.

/** Роздільник-«горизонт»: дві волосінки з градієнтною крапкою-сонцем.
 *  Крапка дихає гало (haloPulse) — розрахунок видимості в index.css біля
 *  кадру: анімується окремий шар 14px+blur, бо сама крапка 8px замала. */
function HorizonDivider() {
  return (
    <div className="flex items-center gap-2.5" aria-hidden="true">
      <div
        className="h-px flex-1"
        style={{ background: 'linear-gradient(90deg,transparent,rgba(255,164,92,.4))' }}
      />
      <div className="relative grid place-items-center">
        <span
          className="absolute h-3.5 w-3.5 rounded-full"
          style={{
            background: 'rgba(255,140,100,.65)',
            filter: 'blur(5px)',
            animation: 'haloPulse 3.8s ease-in-out infinite',
          }}
        />
        <div
          className="relative h-2 w-2 rounded-full"
          style={{ background: 'var(--grad)', boxShadow: '0 0 12px rgba(255,140,100,.7)' }}
        />
      </div>
      <div
        className="h-px flex-1"
        style={{ background: 'linear-gradient(90deg,rgba(255,110,122,.4),transparent)' }}
      />
    </div>
  );
}

export function TodayScreen() {
  const { data, isLoading, isError, error, refetch } = useBriefing();
  // Жива погода (PR-7, фідбек власника) — м'який шар поверх снапшоту брифінгу:
  // `live` відсутній (ще завантажується/поза Telegram/збій) -> просто рендеримо
  // снапшот, як і завжди. fetchLiveWeather НІКОЛИ не кидає, тож немає окремого
  // isError тут — лише necessarily-undefined `data`.
  // Геолокація (Блок «Погода») — коли браузер дав координати, useLiveWeather
  // підміняє головну локацію на реальне «де ти зараз»; поки null (ще
  // запитуємо/відмовлено/десктоп) — дефолтна пара Львів/Немовичі, як і раніше.
  const geo = useGeolocation();
  const { data: liveWeather } = useLiveWeather(geo);

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

  // Блок рендериться, лише якщо модуль дав дані: з F2 власник може вимкнути
  // погоду/курс у налаштуваннях, і тоді блока в брифінгу немає взагалі.
  // Неохоронений CurrencyBlock показував би «курс недоступний» — тобто збій
  // там, де насправді свідомо вимкнено. Роздільник — лише МІЖ блоками.
  // Масив (а не JSX-умови в розмітці) — щоб каскад рахував затримку за
  // ФАКТИЧНОЮ позицією секції: з вимкненою погодою курс має йти першим і без
  // затримки, а не чекати слот неіснуючого сусіда.
  const sections: Array<{ key: string; node: React.ReactNode }> = [];
  // liveWeather.locations перекриває снапшот, коли є (PR-7) — той самий
  // масив-формат (weatherLocationSchema), WeatherBlock узагалі не знає
  // різниці між живим і статичним джерелом.
  if (weather)
    sections.push({
      key: 'weather',
      node: <WeatherBlock locations={liveWeather?.locations ?? weather.locations} />,
    });
  if (weather && currency) sections.push({ key: 'divider', node: <HorizonDivider /> });
  if (currency)
    sections.push({
      key: 'currency',
      node: <CurrencyBlock d={currency} date={shortDateFromIso(data.brief.generatedAt)} />,
    });
  if (mock) sections.push({ key: 'mock', node: <QuestionBlock d={mock} /> });
  if (fact) sections.push({ key: 'fact', node: <FactBlock d={fact} /> });
  if (stoic) sections.push({ key: 'stoic', node: <QuoteBlock d={stoic} /> });
  if (onthisday) sections.push({ key: 'onthisday', node: <ThisDayBlock d={onthisday} /> });

  return (
    <div className="flex flex-col gap-[18px]">
      {sections.map((s, i) => (
        <div key={s.key} style={cascade(i, 55, 6)}>
          {s.node}
        </div>
      ))}
    </div>
  );
}
