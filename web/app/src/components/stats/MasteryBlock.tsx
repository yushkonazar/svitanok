import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { SectionHead, StatRow } from '../ui/primitives.tsx';
import { SkillBars } from '../charts/SkillBars.tsx';
import { Donut } from '../charts/Donut.tsx';

// C · Майстерність (дизайн v2, Svitanok.dc.html): тема тижня, смуги слабких тем,
// пончик прогресу роадмепу з підписом. Підказки «вчити» макет не показує —
// лишаємо тихим рядком (це корисний зв'язок mock-тема → тема роадмепу).

export function MasteryBlock({ s }: { s: Stats }) {
  const tw = s.mastery?.themeOfWeek;
  const hints = (s.mastery?.hints ?? []).slice(0, 3);
  const roadmap = s.roadmap;
  const hasRoadmap = has(roadmap?.done) && has(roadmap?.total);

  return (
    <div className="flex flex-col gap-3">
      <SectionHead>Майстерність</SectionHead>

      {tw && (
        <div className="flex items-center">
          <span className="text-[11.5px] font-medium text-tx2">Тема тижня</span>
          <span className="ml-auto text-[12.5px] font-bold">
            {tw.title} · {tw.done}/{tw.total}
          </span>
        </div>
      )}

      <SkillBars
        items={s.mock.weakTopics.map((w) => ({ name: w.name, pct: w.value }))}
        emptyText="Слабких тем поки не виявлено"
      />

      {hints.map((h, i) => (
        <div key={i} className="text-[11px] leading-[1.4] text-tx3">
          ↳ {h.mockTopic}: вчити {h.themes.map((t) => `${t.title} (${t.done}/${t.total})`).join(', ')}
        </div>
      ))}

      {has(s.mock.streak) && s.mock.streak > 0 && (
        <StatRow label="Стрік mock" value={`🔥 ${s.mock.streak} дн.`} />
      )}

      {hasRoadmap && (
        <div className="flex items-center gap-3.5 pt-1">
          <Donut pct={(roadmap!.done / Math.max(1, roadmap!.total)) * 100} />
          <div className="flex flex-col gap-0.5">
            <span className="text-[13px] font-bold">🗺 Роадмеп тем</span>
            <span className="font-mono text-[11px] font-medium text-tx2">
              {roadmap!.done} / {roadmap!.total} підпунктів
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
