import { SAMPLE_NEWS } from './news-preview.ts';
import { kyivParts, shiftDate } from '../../../core/finance/planning.mjs';
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
      data: {
        text: 'Людей тривожать не самі речі, а їхні уявлення про речі.',
        author: 'Епіктет · Енхірідіон, 5',
        sourceUrl: 'https://classics.mit.edu/Epictetus/epicench.html',
        reference: 'Енхірідіон, 5',
        translation: 'Власний український переказ',
      },
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
            rainWindow: '12:00–13:00, 16:00–17:00',
            dayLenDeltaMin: -2,
            sunrise: demoSun(7, 32),
            sunset: demoSun(18, 53),
            hourly: [
              { h: 6, t: 17 },
              { h: 8, t: 18 },
              { h: 10, t: 20 },
              { h: 12, t: 22, at: demoSun(12, 0), popPercent: 75, precipMm: 1.2 },
              { h: 14, t: 24, at: demoSun(14, 0), popPercent: 0, precipMm: 0 },
              { h: 16, t: 25, at: demoSun(16, 0), popPercent: 65, precipMm: 0.6 },
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
        catalog: [
          { code: 'USD', name: 'Долар США', rate: 44.79, asOf: kyivParts(Date.now()).date },
          { code: 'EUR', name: 'Євро', rate: 51.03, asOf: kyivParts(Date.now()).date },
          { code: 'PLN', name: 'Польський злотий', rate: 12.05, asOf: kyivParts(Date.now()).date },
          { code: 'GBP', name: 'Фунт стерлінгів', rate: 59.4, asOf: kyivParts(Date.now()).date },
          { code: 'CHF', name: 'Швейцарський франк', rate: 54.8, asOf: kyivParts(Date.now()).date },
          { code: 'JPY', name: 'Японська єна', rate: 0.31, asOf: kyivParts(Date.now()).date },
          { code: 'CZK', name: 'Чеська крона', rate: 2.02, asOf: kyivParts(Date.now()).date },
          { code: 'CAD', name: 'Канадський долар', rate: 32.4, asOf: kyivParts(Date.now()).date },
          {
            code: 'AUD',
            name: 'Австралійський долар',
            rate: 29.1,
            asOf: kyivParts(Date.now()).date,
          },
        ],
        observations: Array.from({ length: 60 }, (_, i) => ({
          date: shiftDate(kyivParts(Date.now()).date, i - 59),
          rates: {
            USD: 44.79 + Math.sin(i / 7) * 0.18,
            EUR: 51.03 + Math.sin(i / 9) * 0.28,
            PLN: 12.05 + Math.sin(i / 6) * 0.05,
            GBP: 59.4 + Math.sin(i / 8) * 0.2,
            CHF: 54.8 + Math.sin(i / 7) * 0.3,
            JPY: 0.31 + Math.sin(i / 4) * 0.003,
            CZK: 2.02 + Math.sin(i / 8) * 0.02,
            CAD: 32.4 + Math.sin(i / 7) * 0.12,
            AUD: 29.1 + Math.sin(i / 6) * 0.11,
          },
        })),
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
    {
      id: 'fact',
      data: {
        fact: 'У восьминога три серця. Два прокачують кров через зябра, а третє забезпечує кровообіг решти тіла.',
        sourceUrl: 'https://ocean.si.edu/ocean-life/invertebrates/octopuses-squids-and-relatives',
        sourceName: 'Smithsonian Ocean',
        verifiedAt: '2026-10-04',
      },
    },
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
    { id: 'news', data: { groups: SAMPLE_NEWS } },
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
            year: 1957,
            text: '4 жовтня запущено «Супутник-1» — перший штучний супутник Землі. Цей запуск відкрив космічну еру.',
            url: 'https://www.nasa.gov/history/65-years-ago-sputnik-ushers-in-the-space-age/',
            location: {
              lat: 45.92,
              lon: 63.34,
              label: 'Байконур, Казахстан · місце запуску',
              sourceUrl: 'https://www.nasa.gov/history/sputnik/sputorig.html',
              kind: 'event',
            },
          },
          {
            year: 2004,
            text: '4 жовтня SpaceShipOne виконав другий заліковий політ і здобув Ansari XPRIZE. Приватна команда довела, що пілотований суборбітальний політ може бути повторюваним.',
            url: 'https://www.xprize.org/competitions/ansari',
            location: {
              lat: 35.05,
              lon: -118.15,
              label: 'Мохаве, Каліфорнія · місце польоту',
              sourceUrl: 'https://space.xprize.org/prizes/ansari',
              kind: 'event',
            },
          },
        ],
      },
    },
  ],
};
