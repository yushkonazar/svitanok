import type { Stats } from '../../api/schema.ts';
import { has } from '../../lib/format.ts';
import { Card, StatLine } from '../ui/primitives.tsx';
import { BarList } from '../charts/BarList.tsx';
import { Donut } from '../charts/Donut.tsx';

// C · Майстерність (роадмеп v3, E1) — index.html:2506-2535.

export function MasteryBlock({ s }: { s: Stats }) {
  const tw = s.mastery?.themeOfWeek;
  const hints = (s.mastery?.hints ?? []).slice(0, 3);
  const roadmap = s.roadmap;
  const hasRoadmap = has(roadmap?.done) && has(roadmap?.total);

  return (
    <Card title="🎤 C · Майстерність">
      {tw && <StatLine first label="🗓 Тема тижня" value={`${tw.title} · ${tw.done}/${tw.total}`} />}

      <div className="mt-2">
        <BarList
          items={s.mock.weakTopics.map((w) => ({ name: w.name, value: w.value }))}
          unit="%"
          emptyText="Слабких тем поки не виявлено"
        />
      </div>

      {hints.map((h, i) => (
        <div key={i} className="mt-1 text-xs text-muted">
          ↳ {h.mockTopic}: вчити{' '}
          {h.themes.map((t) => `${t.title} (${t.done}/${t.total})`).join(', ')}
        </div>
      ))}

      {has(s.mock.streak) && <StatLine label="Стрік mock" value={`🔥 ${s.mock.streak} дн.`} />}

      {hasRoadmap ? (
        <div className="mt-3 flex items-center gap-3">
          <Donut pct={(roadmap!.done / Math.max(1, roadmap!.total)) * 100} />
          <div>
            <div className="font-medium">🗺 Роадмеп тем</div>
            <div className="text-sm text-muted">
              {roadmap!.done}/{roadmap!.total} підпунктів
            </div>
          </div>
        </div>
      ) : (
        <StatLine label="🗺 Роадмеп тем" value={<span className="text-muted">скоро</span>} />
      )}
    </Card>
  );
}
