import type { CheckinDay, CheckinPoint } from '../../api/schema.ts';
import { BLOCKS } from '../checkin/questions.ts';
export function SelectedDay({
  raw,
  point,
}: {
  raw: CheckinDay | undefined;
  point: CheckinPoint | undefined;
}) {
  return (
    <div className="mt-4">
      <div className="renewal-form-grid">
        {(['Енергія', 'Настрій'] as const).map((name, i) => (
          <div key={name} className="renewal-inset">
            <strong className="text-sm">{name} за день</strong>
            {['Ранок', 'День', 'Вечір'].map((label, j) => (
              <div className="flex justify-between gap-2 mt-2 text-xs" key={label}>
                <span className="text-tx3">{label}</span>
                <span>{(i === 0 ? point?.energyCurve : point?.moodCurve)?.[j] ?? '—'} /5</span>
              </div>
            ))}
          </div>
        ))}
      </div>
      <details className="mt-4 renewal-muted">
        <summary className="cursor-pointer">Відповіді цього дня</summary>
        {raw ? (
          BLOCKS.map((block) => {
            const answers = raw[block.id] as Record<string, unknown> | undefined;
            if (!answers) return null;
            return (
              <div className="mt-4" key={block.id}>
                <h3 className="font-semibold text-tx">
                  {block.nm}
                  {answers.confirmed ? ' · підтверджено' : ' · є відповіді'}
                </h3>
                {block.qs.map((q) => {
                  const value = answers[q.id];
                  if (q.pad) {
                    const a = answers[q.pad.x],
                      b = answers[q.pad.y];
                    return a == null && b == null ? null : (
                      <div className="renewal-list-row" key={q.id}>
                        <span>
                          {q.t}
                          <small>
                            {q.pad.xLabel}: {String(a ?? '—')}/5 · {q.pad.yLabel}:{' '}
                            {String(b ?? '—')}/5
                          </small>
                        </span>
                      </div>
                    );
                  }
                  if (value == null) return null;
                  const labels = (Array.isArray(value) ? value : [value]).map(
                    (v) => q.o?.find(([, option]) => option === v)?.[0] ?? String(v),
                  );
                  return (
                    <div className="renewal-list-row" key={q.id}>
                      <span>
                        {q.t}
                        <small>{labels.join(' · ')}</small>
                      </span>
                    </div>
                  );
                })}
              </div>
            );
          })
        ) : (
          <p className="mt-3">
            Для цієї дати докладні відповіді недоступні. Графік показує збережені підсумки.
          </p>
        )}
      </details>
    </div>
  );
}
