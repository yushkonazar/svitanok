import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';

// Число «набігає» від нуля до цілі — один раз за візит, коли елемент видно.
//
// CSS-кадри сюди не дістають (текст не анімується keyframe-ами без реєстрації
// @property, якої немає в старих вебвʼю), тож це єдине місце з rAF-анімацією.
// Інваріант «DOM тримає правду» тут перекладається так:
//   - reduced-motion / немає rAF → одразу фінальне число, без нуля й миготіння;
//   - фонова вкладка з притиснутим rAF → число стоїть, докручується при
//     поверненні (те саме «пауза на першому кадрі», що в графіків);
//   - дані оновились ПІСЛЯ програвання → просто показуємо нове число, без
//     повторного набігання (цифра, що крутиться на кожен рефетч, — це шум).

const canAnimate = () =>
  typeof requestAnimationFrame !== 'undefined' &&
  !(typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches);

export function useCountUp(target: number, play = true, duration = 700): number {
  const animatable = canAnimate();
  // Стартове значення: фінал, якщо анімації не буде, — інакше reduced-motion
  // ловив би кадр нуля до першого ефекту.
  const [shown, setShown] = useState(() => (animatable ? 0 : target));
  const [lastTarget, setLastTarget] = useState(target);
  // `started` живе ЛИШЕ всередині ефекту (запис і читання), тож правило
  // react-hooks/refs його не стосується — воно про доступ під час рендера.
  const started = useRef(false);

  // ⚠️ КОРИГУВАННЯ СТАНУ ПІД ЧАС РЕНДЕРА, а не в ефекті. React документує саме
  // цей патерн для «скинути стан, коли проп змінився», і він дешевший: ефект
  // робив зайвий коміт, тобто кадр зі СТАРИМ числом устигав потрапити на екран.
  //
  // Будь-яка зміна цілі -> просто дзеркалимо. Це покриває обидва випадки, які
  // доти розрізнялись: дані оновились після програвання (показати нове число
  // без повторного набігання) і ціль змінилась ПОСЕРЕД анімації (не лишити
  // «недокрученого» значення). Обидва зводяться до одного правила.
  if (target !== lastTarget) {
    setLastTarget(target);
    setShown(target);
  }

  useEffect(() => {
    // Набігає РІВНО ОДИН раз за візит: далі лише дзеркалення вище.
    if (!play || started.current) return;
    // Нема чого анімувати: нуль або притиснута анімація. shown уже дорівнює
    // цілі (див. ініціалізацію), тож нічого й не треба — просто фіксуємо, що
    // програвання відбулось, і жодного setState в ефекті не робимо.
    if (!animatable || target === 0) {
      started.current = true;
      return;
    }
    started.current = true;
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, Math.max(0, (t - t0) / duration));
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic — швидкий старт, мʼяке доїжджання
      setShown(Math.round(eased * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Клінап лише знімає кадр. Доводити число до цілі тут БІЛЬШЕ НЕ ТРЕБА:
    // зміну цілі вже відпрацював рендер вище, а на розмонтуванні setState у
    // клінапі — це запис у стан компонента, якого вже немає.
    return () => cancelAnimationFrame(raf);
  }, [play, target, duration, animatable]);

  return shown;
}

/** Спан-обгортка для місць, де хук не викликати (число в map-колбеку). */
export function CountUp({
  n,
  play,
  className,
  style,
}: {
  n: number;
  play?: boolean;
  className?: string;
  style?: CSSProperties;
}) {
  const shown = useCountUp(n, play);
  return (
    <span className={className} style={style}>
      {shown}
    </span>
  );
}
