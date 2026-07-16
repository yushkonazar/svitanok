import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { haptic } from '../../telegram.ts';

// Контроли форми (дизайн v2, Svitanok.dc.html — екран «Налаштування»).
// У проєкті досі не було ні тумблера, ні слайдера; тут вони — з семантикою
// доступності (role=switch / role=slider), бо це справжні органи керування, а
// не декоративні div-и з макета.

/** Тумблер on/off: доріжка стає градієнтом accent, кулька їде вбік. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  /** Доступна назва — візуальний підпис лежить у сусідньому вузлі. */
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => {
        haptic('light');
        onChange(!checked);
      }}
      className="ml-auto flex h-[27px] w-[46px] flex-none items-center rounded-full p-[3px] transition-all duration-[220ms] disabled:opacity-40"
      style={{
        justifyContent: checked ? 'flex-end' : 'flex-start',
        background: checked ? 'var(--grad)' : 'var(--color-track)',
      }}
    >
      <span
        className="h-[21px] w-[21px] rounded-full bg-white"
        style={{ boxShadow: '0 1px 3px rgba(0,0,0,.3)' }}
      />
    </button>
  );
}

/** Пігулка-чіп: активна — градієнт accent, інакше скло. */
export function Chip({
  active,
  onClick,
  children,
  pressed,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  /** Роль radio (вибір одного з набору) — озвучує стан скрінрідеру. */
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      {...(pressed !== undefined ? { role: 'radio', 'aria-checked': pressed } : {})}
      onClick={() => {
        haptic('light');
        onClick();
      }}
      className="rounded-full px-[13px] py-2 text-xs transition-colors"
      style={
        active
          ? { background: 'var(--grad)', color: 'var(--color-onacc)', fontWeight: 700 }
          : {
              background: 'var(--color-glass)',
              border: '1px solid var(--color-glassb)',
              color: 'var(--color-tx2)',
              fontWeight: 600,
            }
      }
    >
      {children}
    </button>
  );
}

/**
 * Слайдер цілого числа: −/+ і перетягувана доріжка (як у макеті).
 * Нативний <input type=range> не взяли: його важко привести до мови дизайну
 * крос-браузерно. Натомість pointer-події + клавіатура + role=slider, щоб
 * доступність не постраждала від кастомної шкіри.
 *
 * Перетягування веде ЧЕРНЕТКУ (draft) і кличе onChange лише на відпусканні
 * пальця: кожен onChange тут = мутація = запис у KV, а KV має ліміт 1 запис/сек
 * на ключ. Протяг 1->10 без цього дав би дев'ять записів за півсекунди, і
 * частина мовчки провалилася б. Кнопки й клавіатура кличуть одразу — там темп
 * людський.
 */
export function Stepper({
  value,
  min,
  max,
  onChange,
  label,
}: {
  value: number;
  min: number;
  max: number;
  onChange: (next: number) => void;
  label: string;
}) {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<number | null>(null);
  const clamp = useCallback((v: number) => Math.max(min, Math.min(max, v)), [min, max]);

  // Батько підтвердив (або відкотив) значення — чернетка більше не потрібна.
  useEffect(() => setDraft(null), [value]);

  const shown = draft ?? clamp(value);

  const commit = useCallback(
    (v: number) => {
      const next = clamp(Math.round(v));
      if (next !== value) {
        haptic('light');
        onChange(next);
      }
    },
    [clamp, onChange, value],
  );

  const fromPointer = useCallback(
    (clientX: number) => {
      const el = trackRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return null;
      const p = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
      return clamp(Math.round(min + p * (max - min)));
    },
    [clamp, max, min],
  );

  const drag = useCallback(
    (clientX: number) => {
      const v = fromPointer(clientX);
      if (v === null) return;
      setDraft((cur) => {
        if (cur !== v) haptic('light');
        return v;
      });
    },
    [fromPointer],
  );

  const pct = max > min ? ((shown - min) / (max - min)) * 100 : 0;

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        aria-label={`${label} — менше`}
        onClick={() => commit(shown - 1)}
        disabled={shown <= min}
        className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] border border-glassb bg-glass text-base font-bold text-tx2 disabled:opacity-35"
      >
        −
      </button>

      <div
        ref={trackRef}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={shown}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) drag(e.clientX);
        }}
        // Коміт саме тут — один запис на весь жест, а не на кожне значення.
        onPointerUp={() => commit(shown)}
        onPointerCancel={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') commit(shown - 1);
          else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') commit(shown + 1);
          else if (e.key === 'Home') commit(min);
          else if (e.key === 'End') commit(max);
          else return;
          e.preventDefault();
        }}
        className="relative flex h-6 flex-1 cursor-pointer items-center"
        style={{ touchAction: 'none' }}
      >
        <div className="h-2 w-full overflow-hidden rounded-full bg-track">
          <div
            className="h-full rounded-full"
            style={{ width: `${pct}%`, background: 'var(--grad)' }}
          />
        </div>
        {/* left — числом: React додає 'px' лише до чисел, рядок із % тут не
            підійшов би для transform-центрування, тож рахуємо в calc(). */}
        <div
          className="pointer-events-none absolute h-5 w-5 rounded-full bg-white"
          style={{
            left: `calc(${pct}% - 10px)`,
            boxShadow: '0 2px 6px rgba(0,0,0,.4)',
          }}
        />
      </div>

      <button
        type="button"
        aria-label={`${label} — більше`}
        onClick={() => commit(shown + 1)}
        disabled={shown >= max}
        className="grid h-[30px] w-[30px] flex-none place-items-center rounded-[9px] border border-glassb bg-glass text-base font-bold text-tx2 disabled:opacity-35"
      >
        +
      </button>
    </div>
  );
}

/** Рядок налаштування: підпис (+ підзначення) зліва, контрол справа. */
export function SettingRow({
  title,
  hint,
  icon,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {icon}
      <div className="min-w-0">
        <div className="text-[13.5px] font-semibold leading-tight">{title}</div>
        {hint && <div className="mt-0.5 font-mono text-[11px] font-medium text-tx3">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
