import { useId, useState, type ReactNode } from 'react';
import { haptic } from '../../telegram.ts';

// Спільні примітиви (дизайн v2, Svitanok.dc.html).

/** Моно-лейбл секції: «КУРС НБУ», «ФАКТ ДНЯ» — розріджений капс. */
export function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <span className="font-mono text-[10px] font-semibold tracking-[0.12em] text-tx2">
      {children}
    </span>
  );
}

/** Заголовок блоку статистики: градієнтна крапка + назва + волосінь. */
export function SectionHead({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      {/* Статична. Пробував тут перелив градієнта — на 7px його не видно
          взагалі (див. коментар до .sheen в index.css). */}
      <div className="h-[7px] w-[7px] rounded-[2px]" style={{ background: 'var(--grad)' }} />
      <span className="text-[13px] font-bold">{children}</span>
      <div className="h-px flex-1 bg-hair" />
    </div>
  );
}

/** Скляна картка (glass + рамка + 16px радіус). */
export function GlassCard({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={`rounded-2xl border border-glassb bg-glass ${className}`}>{children}</div>;
}

/** Рядок «підпис → значення» (текст Manrope зліва, моно-число справа). */
export function StatRow({
  label,
  value,
  valueClass = '',
}: {
  label: ReactNode;
  value: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="flex items-center">
      <span className="whitespace-nowrap text-[11.5px] font-medium text-tx2">{label}</span>
      <span className={`ml-auto font-mono text-xs font-semibold ${valueClass}`}>{value}</span>
    </div>
  );
}

/** Плейсхолдер порожнього стану. */
export function Ph({ children }: { children: ReactNode }) {
  return <div className="py-1 text-[12.5px] text-tx2">{children}</div>;
}

/**
 * Повідомлення про СТАН картки: «ще рано», «зараз місяців 1», «замало
 * переходів».
 *
 * ⚠️ Виглядає як Hint, але НЕ ховається — і це головне, заради чого воно
 * окремо. Hint пояснює, ЯК читати те, що намальовано; Note відповідає на
 * «чому тут порожньо». Сховати другий за кнопкою означає лишити людину перед
 * порожньою карткою без жодного натяку, що робити.
 */
export function Note({ children }: { children: ReactNode }) {
  return <div className="mt-2 text-[10.5px] leading-[1.5] text-tx3">{children}</div>;
}

/**
 * Пояснення внизу картки: «що я зараз бачу і як це читати».
 *
 * Окремий примітив, а не просто <div>: графіки статистики стали щільними
 * (матриця станів, радари архетипів, ефект-сайзи), і без однакового,
 * ПЕРЕДБАЧУВАНО РОЗТАШОВАНОГО підпису кожна картка вимагає здогадки. Один
 * стиль на всі — щоб око вчилося шукати пояснення в одному місці.
 *
 * ⚠️ ЗГОРНУТЕ ЗА ЗАМОВЧУВАННЯМ. Підказка потрібна ОДИН раз — коли вчишся
 * читати блок; далі вона щодня забирає висоту й розсіює увагу від самих
 * чисел. Але й прибрати її не можна: без неї половина екрана нечитабельна
 * (ρ, d, «витримує поправку»). Тому кнопка, а не видалення.
 *
 * Правиться САМЕ ТУТ, а не в 28 місцях виклику: одна поведінка й один вигляд
 * на всі графіки — вимога, а не збіг. Нова картка отримує це безкоштовно.
 *
 * ⚠️ Стан НЕ зберігається між сесіями свідомо. Інакше через пів року екран
 * мовчки лишиться без пояснень, і «а де воно було» не матиме відповіді.
 */
export function Hint({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // useId, а не лічильник: aria-controls мусить бути унікальним на сторінці,
  // а підказок на екрані статистики під три десятки.
  const bodyId = useId();
  return (
    <div className="mt-2">
      {/* ⚠️ Кнопка притиснута ПРАВОРУЧ, а текст під нею лишається на всю
          ширину. Це не косметика: ліворуч кнопка ставала першим, що бачить
          око в кожній картці, і тягнула увагу на службовий елемент замість
          самих чисел. Праворуч унизу вона читається як виноска — там її
          шукають, коли треба, і не помічають, коли ні. */}
      <div className="flex justify-end">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => {
            haptic('light');
            setOpen((v) => !v);
          }}
          className="flex items-center gap-1 rounded-full border border-glassb bg-glass px-2 py-[3px] font-mono text-[9px] font-semibold tracking-[0.06em] text-tx3"
        >
          {/* Знак — декор: сенс кнопки несе слово поруч, тож читачеві екрана
              «?» не потрібне (інакше він озвучив би «знак питання Пояснення»). */}
          <span aria-hidden="true">?</span>
          <span>{open ? 'ЗГОРНУТИ' : 'ПОЯСНЕННЯ'}</span>
        </button>
      </div>
      {open && (
        <div id={bodyId} className="mt-1.5 text-[10px] leading-[1.45] text-tx3">
          {children}
        </div>
      )}
    </div>
  );
}
