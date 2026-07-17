// «Туман» — фонові кольорові плями (дизайн v2, Svitanok.dc.html).
// У макеті вони лежать усередині рамки телефона (absolute inset:0); у реальному
// вебв'ю рамка = сам вьюпорт, тож fixed — щоб туман не їхав зі скролом контенту.
// Декоративний шар: pointer-events:none, під усім контентом.

// ⚠️ Туман НЕ анімуємо, і це висновок з виміру, а не смак. Пляма має альфу 0.13
// під blur(22-26px), тож будь-який рух тут дає ~9 рівнів яскравості з 255 —
// фізично невидимо. Я вже спробував (fogDrift, 30-46с) і власник сказав прямо:
// «туману я взагалі не бачу». Постійний рух живе на градієнтних акцентах
// (.grad-live в index.css), де є контраст.
const BLOBS = [
  { left: -60, top: '14%', w: 360, h: 150, fog: 'var(--fogA)', blur: 22 },
  { right: -90, top: '38%', w: 380, h: 160, fog: 'var(--fogB)', blur: 26 },
  { left: -70, top: '62%', w: 360, h: 150, fog: 'var(--fogC)', blur: 26 },
  { right: -70, top: '86%', w: 380, h: 160, fog: 'var(--fogA)', blur: 22 },
];

export function Fog() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0 overflow-hidden" aria-hidden="true">
      {BLOBS.map((b, i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: b.left,
            right: b.right,
            top: b.top,
            width: b.w,
            height: b.h,
            borderRadius: '50%',
            background: `radial-gradient(50% 50% at 50% 50%, ${b.fog}, transparent 70%)`,
            filter: `blur(${b.blur}px)`,
          }}
        />
      ))}
      {/* тепле сяйво згори — «світанок» */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background:
            'radial-gradient(130% 34% at 50% -4%, rgba(255,110,122,.16), transparent 60%)',
        }}
      />
    </div>
  );
}
