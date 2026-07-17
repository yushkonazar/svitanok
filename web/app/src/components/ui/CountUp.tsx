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
  // Стартове значення: фінал, якщо анімації не буде, — інакше reduced-motion
  // ловив би кадр нуля до першого ефекту.
  const [shown, setShown] = useState(() => (canAnimate() ? 0 : target));
  const played = useRef(false);

  useEffect(() => {
    if (played.current) {
      // Уже відіграли — далі лише дзеркалимо свіжі дані.
      setShown(target);
      return;
    }
    if (!play) return; // чекаємо появи на екрані (play=true назад не вимикається)
    played.current = true;
    if (!canAnimate() || target === 0) {
      setShown(target);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / duration);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic — швидкий старт, мʼяке доїжджання
      setShown(Math.round(eased * target));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    // Клінап знімає кадр і чесно доводить число до цілі: розмонтування чи зміна
    // target посеред анімації не сміє лишити на екрані «недокручене» значення.
    return () => {
      cancelAnimationFrame(raf);
      setShown(target);
    };
  }, [play, target, duration]);

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
