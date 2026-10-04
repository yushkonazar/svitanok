import { haptic } from '../../telegram.ts';
import { useState } from 'react';

// Двовимірний пад: ОДИН тап по сітці 5×5 дає ДВА значення (1..5 по кожній осі).
// Це єдиний спосіб подвоїти обсяг даних, не подвоївши тертя — а тертя тут
// головний ризик: власник уже казав, що інколи забуває заповнювати чек-ін.
//
// Використовується двічі: енергія×настрій (активація×валентність — дві
// ортогональні осі афекту, доти мірялась лише одна) і зусилля×результат
// (NASA-TLX розділяє effort і performance — «вклав багато / вийшло мало» це
// не те саме, що «легкий продуктивний день»).
//
// Вісь Y намальована зверху вниз від 5 до 1: більше = вище, як в усіх графіках
// застосунку. Обрана клітинка підсвічена, а поточні значення продубльовані
// текстом — покладатись лише на колір не можна (ux-guidelines «Color Only»).

const LEVELS = [5, 4, 3, 2, 1];

export function AffectPad({
  xLabel,
  yLabel,
  x,
  y,
  onPick,
  disabled,
}: {
  xLabel: string;
  yLabel: string;
  // null — «зняв відповідь» (explicit-clear), undefined — «ще не відповідав»;
  // обидва читаються як «не обрано» однаково (questions.ts isAnswered).
  x: number | null | undefined;
  y: number | null | undefined;
  onPick: (x: number, y: number) => void;
  disabled?: boolean;
}) {
  const picked = x != null && y != null;
  const [mode, setMode] = useState<'grid' | 'sliders'>('grid');

  return (
    <div className="flex flex-col gap-3">
      <div className="renewal-segments self-start">
        <button type="button" aria-pressed={mode === 'grid'} onClick={() => setMode('grid')}>
          Сітка стану
        </button>
        <button type="button" aria-pressed={mode === 'sliders'} onClick={() => setMode('sliders')}>
          Точний вибір
        </button>
      </div>
      {mode === 'sliders' ? (
        <div className="renewal-inset flex flex-col gap-4">
          {[
            { label: xLabel, value: x, axis: 'x' },
            { label: yLabel, value: y, axis: 'y' },
          ].map((a) => (
            <label key={a.axis} className="renewal-field">
              <span className="flex justify-between">
                <b>{a.label}</b>
                <b>{a.value ?? '—'} / 5</b>
              </span>
              <input
                type="range"
                min={1}
                max={5}
                step={1}
                value={a.value ?? 3}
                disabled={disabled}
                aria-label={a.label}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onPick(a.axis === 'x' ? n : (x ?? 3), a.axis === 'y' ? n : (y ?? 3));
                }}
              />
              <span className="flex justify-between text-xs text-tx3">
                <span>1 · низько</span>
                <span>5 · високо</span>
              </span>
            </label>
          ))}
        </div>
      ) : (
        <div className="flex gap-1">
          {/* Підпис осі Y — вертикально збоку, щоб не з'їдати висоту сітки. */}
          <span
            className="flex-none self-center font-mono text-[8.5px] font-semibold tracking-[0.08em] text-tx3"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            {yLabel.toUpperCase()} →
          </span>
          <div className="flex flex-1 flex-col gap-1">
            {LEVELS.map((yv) => (
              <div key={yv} className="flex gap-1">
                {[1, 2, 3, 4, 5].map((xv) => {
                  const on = x === xv && y === yv;
                  return (
                    <button
                      key={xv}
                      type="button"
                      aria-pressed={on}
                      aria-label={`${yLabel} ${yv}, ${xLabel} ${xv}`}
                      tabIndex={disabled ? -1 : 0}
                      disabled={disabled}
                      onClick={
                        disabled
                          ? undefined
                          : () => {
                              haptic('light');
                              onPick(xv, yv);
                            }
                      }
                      className="h-11 flex-1 rounded-[10px] border transition-colors disabled:cursor-default"
                      style={{
                        borderColor: on ? 'var(--color-a2)' : 'var(--color-glassb)',
                        background: on
                          ? 'color-mix(in srgb, var(--color-a2) 22%, transparent)'
                          : `hsla(${260 - xv * 45},65%,65%,${0.06 + yv * 0.035})`,
                      }}
                    >
                      <span
                        key={String(on)}
                        className="grid h-full w-full place-items-center rounded-[9px] text-sm font-bold text-a2"
                        style={on ? { animation: 'pop .24s cubic-bezier(.22,1,.36,1)' } : undefined}
                      >
                        {on ? '●' : ''}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
            <div className="flex items-center">
              <span className="font-mono text-[8.5px] font-semibold tracking-[0.08em] text-tx3">
                {xLabel.toUpperCase()} →
              </span>
              {/* Значення словами: сітка сама по собі не каже, ЩО обрано, а
                колір не може бути єдиним носієм інформації. */}
              <span className="ml-auto font-mono text-[9.5px] font-semibold text-tx2">
                {picked ? `${yLabel} ${y} · ${xLabel} ${x}` : 'не обрано'}
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
