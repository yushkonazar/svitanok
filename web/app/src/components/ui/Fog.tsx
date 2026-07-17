// «Туман» — фонові кольорові плями (дизайн v2, Svitanok.dc.html).
// У макеті вони лежать усередині рамки телефона (absolute inset:0); у реальному
// вебв'ю рамка = сам вьюпорт, тож fixed — щоб туман не їхав зі скролом контенту.
// Декоративний шар: pointer-events:none, під усім контентом.

// dur/delay — ЄДИНИЙ нескінченний цикл у застосунку (див. fogDrift в index.css).
// Тривалості непарні між собою (30/37/43/46с) навмисно: у спільному ритмі плями
// «дихали» б у такт, і око одразу прочитало б це як анімацію. Врозбіг вони
// просто повільно живуть.
const BLOBS = [
  { left: -60, top: '14%', w: 360, h: 150, fog: 'var(--fogA)', blur: 22, dur: 30, delay: 0 },
  { right: -90, top: '38%', w: 380, h: 160, fog: 'var(--fogB)', blur: 26, dur: 43, delay: -7 },
  { left: -70, top: '62%', w: 360, h: 150, fog: 'var(--fogC)', blur: 26, dur: 37, delay: -15 },
  { right: -70, top: '86%', w: 380, h: 160, fog: 'var(--fogA)', blur: 22, dur: 46, delay: -22 },
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
            // Відʼємна затримка — щоб плями стартували з РІЗНИХ фаз циклу, а не
            // всі з нуля: інакше перші 15 секунд після відкриття вони їхали б
            // синхронно, і вся робота з непарними тривалостями пропала б.
            animation: `fogDrift ${b.dur}s ease-in-out ${b.delay}s infinite`,
            willChange: 'transform, opacity',
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
