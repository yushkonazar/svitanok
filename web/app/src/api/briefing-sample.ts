import type { Brief } from './briefing-schema.ts';

// Демо-брифінг поза Telegram (роадмеп v3, E2) — перенесено з web/public/index.html
// SAMPLE (3097-3317). Містить і news/jobs блоки (для E3). sunrise/sunset —
// unix-секунди на сьогодні за локальним часом (demoSun), щоб циферблат погоди
// показував реалістичну фазу дня.

function demoSun(h: number, m: number): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

export const SAMPLE_BRIEF: Brief = {
  dateLabel: 'Демо-режим',
  generatedAt: new Date().toISOString(),
  blocks: [
    {
      id: 'stoic',
      data: { text: 'Жоден не зашкодить мені без моєї згоди.', author: 'Марк Аврелій' },
    },
    {
      id: 'weather',
      data: {
        locations: [
          {
            name: 'Львів',
            emoji: '⛅',
            tempC: 24,
            feelsLikeC: 24,
            minC: 16,
            maxC: 26,
            windMps: 3,
            gustMps: 7,
            humidity: 58,
            condition: 'мінлива хмарність',
            willRain: true,
            popPercent: 40,
            uv: 6,
            aqi: 2,
            advice: 'Легка куртка на вечір; удень футболка.',
            rainWindow: '15:00–17:00',
            dayLenDeltaMin: -2,
            sunrise: demoSun(6, 43),
            sunset: demoSun(22, 50),
            hourly: [
              { h: 6, t: 17 },
              { h: 8, t: 18 },
              { h: 10, t: 20 },
              { h: 12, t: 22 },
              { h: 14, t: 24 },
              { h: 16, t: 25 },
              { h: 18, t: 24 },
              { h: 20, t: 22 },
              { h: 22, t: 20 },
              { h: 24, t: 18 },
            ],
          },
          {
            name: 'Київ',
            emoji: '☀️',
            tempC: 27,
            feelsLikeC: 28,
            minC: 18,
            maxC: 29,
            windMps: 4,
            gustMps: 9,
            humidity: 45,
            condition: 'ясно',
            willRain: false,
            popPercent: 5,
            uv: 8,
            aqi: 3,
            advice: 'Сонцезахист обов’язково, пий воду.',
            dayLenDeltaMin: -2,
            sunrise: demoSun(6, 10),
            sunset: demoSun(22, 16),
            hourly: [
              { h: 6, t: 19 },
              { h: 8, t: 21 },
              { h: 10, t: 23 },
              { h: 12, t: 25 },
              { h: 14, t: 27 },
              { h: 16, t: 28 },
              { h: 18, t: 27 },
              { h: 20, t: 25 },
              { h: 22, t: 23 },
              { h: 24, t: 21 },
            ],
          },
        ],
      },
    },
    {
      id: 'currency',
      data: {
        usd: 44.79,
        eur: 51.03,
        pln: 12.05,
        gbp: 59.4,
        usdHistory: [44.6, 44.65, 44.7, 44.68, 44.75, 44.79],
        eurHistory: [50.7, 50.8, 50.9, 50.95, 51.0, 51.03],
        plnHistory: [11.9, 11.95, 12.0, 12.02, 12.03, 12.05],
        gbpHistory: [59.0, 59.1, 59.2, 59.25, 59.35, 59.4],
      },
    },
    { id: 'fact', data: { fact: 'Медузи бувають біологічно безсмертними.' } },
    {
      id: 'mock',
      data: {
        question: 'Що таке замикання (closure) в JavaScript?',
        hint: 'Функція, що «пам’ятає» змінні свого лексичного оточення.',
        answer:
          'Замикання — функція разом зі збереженим посиланням на змінні зовнішньої області, де її створено.',
        resourceUrl: 'https://developer.mozilla.org/uk/docs/Web/JavaScript/Closures',
        topic: 'Мова',
      },
    },
    {
      id: 'news',
      data: {
        // Редизайн новин (BBC/Guardian/ТСН/dotesports/HLTV + розширені релізи):
        // назви/джерела тем відповідають реальному config.yml, щоб демо-режим
        // (поза Telegram) давав чесний перегляд нового екрана — різний "час
        // тому" (щойно/години/день) на пробу time-ago, різні хости на пробу
        // newsSource(), Релізи без `why` (те, чого в реальних GitHub-релізах
        // немає).
        groups: [
          {
            scope: 'world',
            topic: 'Світ',
            items: [
              {
                title: 'Wildfire now nine miles from French city of Bordeaux',
                url: 'https://www.theguardian.com/world/2026/jul/27/bordeaux-wildfire',
                publishedAt: new Date(Date.now() - 12 * 60_000).toISOString(),
              },
              {
                title: 'Uganda begins emergency food handouts after 19 die from hunger',
                url: 'https://feeds.bbci.co.uk/news/world/uganda-food',
                publishedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
              },
            ],
            more: [
              {
                title: 'Two Russian men jailed in Angola for terrorism and spying',
                url: 'https://feeds.bbci.co.uk/news/world/angola-case',
                publishedAt: new Date(Date.now() - 26 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'world',
            topic: 'Тех/IT',
            items: [
              {
                title:
                  'Warning shot or publicity stunt — how worried should we be about the OpenAI hack?',
                url: 'https://www.theguardian.com/technology/2026/jul/27/openai-hack',
                why: 'обговорення "радикальної прозорості" після інциденту',
                publishedAt: new Date(Date.now() - 45 * 60_000).toISOString(),
              },
              {
                title: 'Self-contained highly-portable Python distributions',
                url: 'https://news.ycombinator.com/item?id=example',
                publishedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
              },
            ],
            more: [
              {
                title: 'Chrome прибирає third-party cookies',
                url: 'https://feeds.bbci.co.uk/news/technology/chrome-cookies',
                publishedAt: new Date(Date.now() - 30 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'world',
            topic: 'Наука',
            items: [
              {
                title:
                  "'It's not rocket science': a day in the life of a Nasa behavioral health scientist",
                url: 'https://www.theguardian.com/science/2026/jul/27/nasa-scientist',
                publishedAt: new Date(Date.now() - 2 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'world',
            topic: 'Кіберспорт',
            items: [
              {
                title: 'Команда оголосила новий ростер перед осіннім сплітом',
                url: 'https://dotesports.com/news/example-roster',
                publishedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
              },
            ],
          },
          {
            scope: 'world',
            topic: 'Футбол',
            items: [
              {
                title: 'Chelsea open talks to sign Henderson and Welbeck',
                url: 'https://www.theguardian.com/football/2026/jul/27/chelsea-talks',
                publishedAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'world',
            topic: 'Релізи',
            // GitHub-релізи — версія+час, БЕЗ `why` (releases.atom не дає опису).
            items: [
              {
                title: '19.2.8',
                url: 'https://github.com/react/react/releases/tag/19.2.8',
                publishedAt: new Date(Date.now() - 6 * 3600_000).toISOString(),
              },
              {
                title: 'v5.4.10',
                url: 'https://github.com/vitejs/vite/releases/tag/v5.4.10',
                publishedAt: new Date(Date.now() - 20 * 3600_000).toISOString(),
              },
              {
                title: 'wrangler@4.114.0',
                url: 'https://github.com/cloudflare/workers-sdk/releases/tag/wrangler%404.114.0',
                publishedAt: new Date(Date.now() - 40 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'ua',
            topic: 'Загальне',
            items: [
              {
                title:
                  '"З усією повагою до Сирського і Федорова..." Зеленський — у інтервʼю Sky News',
                url: 'https://feeds.bbci.co.uk/ukrainian/interview',
                publishedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
              },
              {
                title: 'У Раді пропонують дозволити полювання у "сезон тиші"',
                url: 'https://tsn.ua/ukrayina/example',
                publishedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'ua',
            topic: 'Політика',
            items: [
              {
                title: 'Уряд ухвалив IT-пільги',
                url: 'https://tsn.ua/politika/example-it',
                why: 'впливає на ринок праці',
                publishedAt: new Date(Date.now() - 7 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'ua',
            topic: 'Оборона',
            items: [
              {
                title: 'Ситуація на фронті: зведення Генштабу',
                url: 'https://tsn.ua/oborona/example-front',
                publishedAt: new Date(Date.now() - 90 * 60_000).toISOString(),
              },
            ],
            more: [
              {
                title: 'Партнери погодили новий пакет постачань на осінь',
                url: 'https://tsn.ua/oborona/example-supply',
                publishedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
              },
            ],
          },
          {
            scope: 'ua',
            topic: 'Технології',
            items: [
              {
                title: 'Мінцифри розширює список послуг у застосунку держави',
                url: 'https://tsn.ua/nauka_it/example-diia',
                publishedAt: new Date(Date.now() - 5 * 3600_000).toISOString(),
              },
            ],
          },
        ],
      },
    },
    {
      id: 'jobs',
      data: {
        items: [
          {
            title: 'Intern Full Stack (Node + Angular)',
            url: 'https://example.com/job1',
            score: 92,
            why: 'Точний збіг стеку: Node.js, Angular, TypeScript.',
            funnelStage: 'applied',
          },
          {
            title: 'Junior Frontend Developer',
            url: 'https://example.com/job2',
            score: 78,
            why: 'Фронтенд-фокус, але вимагають React.',
            funnelStage: 'saved',
          },
          { title: 'Trainee QA Automation', url: 'https://example.com/job3', score: -1, why: '' },
          {
            title: 'Junior Backend (Node)',
            url: 'https://example.com/job4',
            score: 85,
            why: 'Node.js + PostgreSQL — твій профіль.',
            funnelStage: 'interview',
          },
        ],
      },
    },
    {
      id: 'onthisday',
      data: {
        events: [
          {
            year: 1789,
            text: 'Демо-подія: стародавня (гарантований слот).',
            url: 'https://uk.wikipedia.org/wiki/1789',
          },
          { year: 1863, text: 'Демо-подія: стародавня (гарантований слот).' },
          { year: 1996, text: 'Демо-подія: XX ст. (найновіша з квоти).' },
          { year: 1990, text: 'Демо-подія: XX ст.' },
          { year: 1969, text: 'Демо-подія: XX ст.' },
          { year: 2022, text: 'Демо-подія: XXI ст.' },
          { year: 2010, text: 'Демо-подія: XXI ст.' },
          { year: 2004, text: 'Демо-подія: XXI ст. (під toggle).' },
          { year: 1961, text: 'Демо-подія: rollover XX ст. (під toggle).' },
          { year: 1945, text: 'Демо-подія: rollover XX ст. (під toggle).' },
          { year: 1918, text: 'Демо-подія: резерв (2-й клік «Показати ще»).' },
          { year: 1905, text: 'Демо-подія: резерв (2-й клік «Показати ще»).' },
        ],
      },
    },
  ],
};
