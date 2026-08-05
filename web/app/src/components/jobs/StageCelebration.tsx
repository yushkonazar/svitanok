import { useEffect, useState } from 'react';

// Зворотний зв'язок на перетягування картки в термінальну стадію Канбана
// (фідбек власника). «Офер» — фінал воронки, годиться на щось більше за
// звичайний haptic: конфеті + привітання, лишається доки не закриють самі
// (мить хочеться затримати). «Відмова»/«Провал» — теж кінець історії, але
// тихіший: приглушений тост, сам згасає — не варте того, щоб чекати тапу.

const CLOSED_TEXT: Record<'rejected' | 'failed', string> = {
  rejected: 'Закрито. Одна вакансія — не вирок, наступна ближче.',
  failed: 'Закрито. Досвід теж рахується.',
};

const CONFETTI_COLORS = ['#FFA45C', '#FF6E7A', '#9BA6FF', '#78DCA0', '#FFD166'];

function ConfettiPiece({ i }: { i: number }) {
  const left = (i * 37) % 100;
  const delay = (i % 6) * 0.08;
  const dur = 1.1 + (i % 5) * 0.15;
  const size = 5 + (i % 3) * 2;
  return (
    <span
      className="absolute top-0 rounded-sm"
      style={{
        left: `${left}%`,
        width: size,
        height: size * 1.6,
        background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        animation: `confettiFall ${dur}s ease-in ${delay}s both`,
      }}
    />
  );
}

export function StageCelebration({
  kind,
  onClose,
}: {
  kind: 'offer' | 'rejected' | 'failed';
  onClose: () => void;
}) {
  // shown: true одразу ПІСЛЯ монтування (rAF) -> транзиція «увійти» з 0.
  // Монтувати вже з opacity:1 означало б нічого не анімувати на вхід.
  const [shown, setShown] = useState(false);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const close = () => setLeaving(true);

  useEffect(() => {
    if (kind === 'offer') return; // офер лишаємо, доки не закриють самі
    const t = setTimeout(close, 2600);
    return () => clearTimeout(t);
  }, [kind]);

  useEffect(() => {
    if (!leaving) return;
    const t = setTimeout(onClose, 220); // дочекатись CSS-транзиції виходу
    return () => clearTimeout(t);
  }, [leaving, onClose]);

  const visible = shown && !leaving;

  if (kind === 'offer') {
    return (
      <div
        className="fixed inset-0 z-[60] flex items-center justify-center px-6"
        style={{
          background: 'rgba(8,6,20,.72)',
          opacity: visible ? 1 : 0,
          transition: 'opacity .22s ease',
        }}
        onClick={close}
      >
        <div className="pointer-events-none absolute inset-x-0 top-0 h-44 overflow-hidden">
          {shown &&
            !leaving &&
            Array.from({ length: 26 }, (_, i) => <ConfettiPiece key={i} i={i} />)}
        </div>
        <div
          className="relative flex max-w-xs flex-col items-center gap-2 rounded-3xl border border-glassb bg-bg2 px-6 py-7 text-center"
          style={{
            boxShadow: '0 24px 60px rgba(0,0,0,.55)',
            opacity: visible ? 1 : 0,
            transform: visible ? 'scale(1)' : 'scale(.85)',
            transition:
              'opacity .26s cubic-bezier(.2,1.4,.4,1), transform .26s cubic-bezier(.2,1.4,.4,1)',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="text-[34px] leading-none">🎉</div>
          <div className="text-[17px] font-extrabold">Офер!</div>
          <div className="text-[13px] leading-[1.5] text-tx2">
            Вітаю — усі етапи пройдено. Заслужено.
          </div>
          <button
            type="button"
            onClick={close}
            className="mt-2 rounded-full px-4 py-2 text-[12.5px] font-semibold"
            style={{ background: 'var(--grad)', color: 'var(--color-onacc)' }}
          >
            Дякую
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="pointer-events-none fixed inset-x-4 bottom-24 z-[60] flex justify-center"
      style={{
        opacity: visible ? 1 : 0,
        transform: visible ? 'translateY(0)' : 'translateY(10px)',
        transition: 'opacity .24s ease, transform .24s ease',
      }}
    >
      <div className="max-w-xs rounded-2xl border border-glassb bg-bg2 px-4 py-3 text-center text-[12.5px] font-medium text-tx2 shadow-lg">
        {CLOSED_TEXT[kind]}
      </div>
    </div>
  );
}
