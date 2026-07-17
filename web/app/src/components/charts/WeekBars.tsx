import type { WeeklyDay } from '../../api/schema.ts';

// Тижнева активність (дизайн v2, Svitanok.dc.html): 7 стовпчиків із градієнтом
// зверху вниз (a2→a1), скруглені зверху, підпис дня знизу. Порожній день —
// мінімальна риска, щоб колонка не зникала.

const MAX_H = 46; // висота найвищого стовпчика (контейнер 66px мінус підпис)

export function WeekBars({ days }: { days: WeeklyDay[] }) {
  if (!days.length) return <div className="py-1 text-[11px] text-tx3">Немає даних за тиждень</div>;
  const max = Math.max(1, ...days.map((d) => d.value || 0));

  return (
    <div className="flex h-[66px] items-end gap-2 pt-1">
      {days.map((d, i) => {
        const v = d.value || 0;
        const h = v > 0 ? Math.max(4, Math.round((v / max) * MAX_H)) : 3;
        return (
          <div key={i} className="flex flex-1 flex-col items-center gap-[5px]">
            <div
              className="w-full"
              style={{
                height: h,
                borderRadius: '6px 6px 3px 3px',
                background: v > 0 ? 'linear-gradient(180deg,var(--color-a2),var(--color-a1))' : 'var(--color-track)',
                // Сходинка 45мс: хвиля зліва направо читається як плин тижня —
                // Пн росте перший. Разом вони б просто «стрибнули».
                animation: `barGrow .5s cubic-bezier(.22,1,.36,1) ${i * 45}ms backwards`,
              }}
            />
            <span className="font-mono text-[9px] font-medium text-tx3">{d.day}</span>
          </div>
        );
      })}
    </div>
  );
}
