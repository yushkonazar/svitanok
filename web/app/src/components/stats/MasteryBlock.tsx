import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { SectionHead, StatRow } from '../ui/primitives.tsx';
import { SkillBars } from '../charts/SkillBars.tsx';
import { Donut } from '../charts/Donut.tsx';
import { MiniTrend } from '../charts/MiniTrend.tsx';

// C · Майстерність (дизайн v2 + PR-9, п.10.3): раніше три незалежні сутності
// (тема тижня / % слабких тем / прогрес роадмепу) стояли поруч без пояснення
// звʼязку — фідбек власника: "абсолютно не розумію, що мені показується".
// Новий порядок веде від "де я зараз" (роадмеп — головний, головним іде) до
// "що конкретно підтягнути" (слабкі теми + підказки), кожна секція з коротким
// підписом, що саме вона означає.

/** Заголовок секції-підпис: моно-капс, як інші "що це" підписи в проєкті. */
function SubLabel({ children }: { children: string }) {
  return (
    <div className="font-mono text-[9.5px] font-medium tracking-[0.08em] text-tx3">{children}</div>
  );
}

export function MasteryBlock({ s }: { s: Stats }) {
  const tw = s.mastery?.themeOfWeek;
  const hints = (s.mastery?.hints ?? []).slice(0, 3);
  const roadmap = s.roadmap;
  const hasRoadmap = has(roadmap?.done) && has(roadmap?.total);
  const weakTopics = s.mock.weakTopics;
  const roadmapGrowth = s.roadmapWeekly.some((w) => w.count > 0);

  return (
    <div className="flex flex-col gap-3.5">
      <SectionHead>Майстерність</SectionHead>

      {/* 1. Роадмеп — головний "поточний стан": скільки підпунктів пройдено. */}
      {hasRoadmap && (
        <div className="flex items-center gap-3.5">
          <Donut pct={(roadmap!.done / Math.max(1, roadmap!.total)) * 100} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-bold">🗺 Роадмеп тем</span>
            <span className="font-mono text-[11px] font-medium text-tx2">
              {roadmap!.done} / {roadmap!.total} підпунктів пройдено
            </span>
          </div>
        </div>
      )}

      {/* 1.5. Ріст роадмепу в часі — знімок % сам по собі не каже, чи це
          прогрес, чи давно застигле число. toggleProgress і так пише ISO-
          таймстемп при позначенні (roadmap-core.mjs) — тут просто сурфейс
          уже наявних даних, лінія (не бар) — 12 вузьких колонок з реальними
          датами-підписами в барах не влізли б без обрізки. */}
      {roadmapGrowth && (
        <div className="flex flex-col gap-1">
          <SubLabel>НОВІ ЗАВЕРШЕННЯ · 12 ТИЖНІВ</SubLabel>
          <MiniTrend
            weeks={s.roadmapWeekly.map((w) => w.week)}
            series={s.roadmapWeekly.map((w) => w.count)}
          />
        </div>
      )}

      {/* 2. Тема тижня — рекомендований фокус, не сам прогрес. */}
      {tw && (
        <div className="flex flex-col gap-0.5">
          <SubLabel>РЕКОМЕНДОВАНИЙ ФОКУС НА ЦЕЙ ТИЖДЕНЬ</SubLabel>
          <div className="flex items-center">
            <span className="text-[12.5px] font-bold">{tw.title}</span>
            <span className="ml-auto font-mono text-[11px] font-medium text-tx2">
              {tw.done}/{tw.total}
            </span>
          </div>
        </div>
      )}

      {/* 3. Слабкі теми — % ПОЯСНЕНО: це не загальний "рівень скіла", а частка
          невдалих відповідей на mock-питання дня за цією темою. Явно позначено
          "УСЯ ІСТОРІЯ" (mockTopics росте all-time, без забування) — і поруч
          recentEasyPct (mockRated, капнутий на 60 останніх) як чесний
          "як я зараз" сигнал, без розбивки по темі (mockRated не привʼязує
          qId до теми — розбивка вимагала б схема-міграції, свідомо відкладено). */}
      <div className="flex flex-col gap-1.5">
        <SubLabel>СЛАБКІ ТЕМИ · % НЕВДАЛИХ ВІДПОВІДЕЙ, УСЯ ІСТОРІЯ</SubLabel>
        <SkillBars
          items={weakTopics.map((w) => ({ name: w.name, pct: w.value }))}
          emptyText="Слабких тем поки не виявлено"
        />
        {has(s.mock.recentEasyPct) && (
          <StatRow
            label="Останні 60 оцінок"
            value={`${s.mock.recentEasyPct}% легко`}
          />
        )}
      </div>

      {/* 4. Підказки — звʼязок "слабка mock-тема -> яку тему роадмепу підтягнути". */}
      {hints.length > 0 && (
        <div className="flex flex-col gap-1">
          <SubLabel>ЦІ ТЕМИ ВАРТО ПІДТЯГНУТИ</SubLabel>
          {hints.map((h, i) => (
            <div key={i} className="text-[11px] leading-[1.4] text-tx3">
              ↳ {h.mockTopic}: {h.themes.map((t) => `${t.title} (${t.done}/${t.total})`).join(', ')}
            </div>
          ))}
        </div>
      )}

      {/* 5. Стрік — другорядне, унизу. */}
      {has(s.mock.streak) && s.mock.streak > 0 && (
        <StatRow label="Стрік mock" value={`🔥 ${s.mock.streak} дн.`} />
      )}
    </div>
  );
}
