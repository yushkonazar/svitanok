import { useEffect, useRef, useState } from 'react';

/**
 * «Елемент доїхав до екрана» — одноразово, назад не вимикається.
 *
 * Навіщо: анімації входу грали при МОНТУВАННІ таба, тобто все нижче згину
 * відпрацьовувало в порожнечу — поки доскролиш, дуга вже намотана, бари вже
 * виросли. Ти бачив рух лише у верхніх двох блоках, решта просто стояла.
 *
 * `once` тут навмисно: якби анімація перезапускалась на кожен прохід повз, скрол
 * туди-сюди перетворив би екран на блимання. Побачив один раз за візит — досить.
 *
 * ⚠️ Дефолт при відсутньому IntersectionObserver — TRUE, а не false. Інакше в
 * старому вебвʼю анімація не запустилась би НІКОЛИ. Це безпечно рівно тому, що
 * правда живе в DOM, а кадри лише додають «звідки приїхати»: не програлось —
 * графік просто стоїть намальований.
 */
export function useInView<T extends Element>(rootMargin = '-40px') {
  const ref = useRef<T | null>(null);
  const [inView, setInView] = useState(() => typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    if (inView) return; // вже показали — спостерігати нема за чим
    const el = ref.current;
    if (!el || typeof IntersectionObserver === 'undefined') return;

    const io = new IntersectionObserver(
      (entries) => {
        // Достатньо, щоб елемент ЗАЙШОВ у вьюпорт; далі відписуємось.
        if (entries.some((e) => e.isIntersecting)) {
          setInView(true);
          io.disconnect();
        }
      },
      // Відʼємний margin — щоб анімація не стартувала, коли від блока видно
      // рівно один піксель: інакше половина руху знову пройшла б за краєм.
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [inView, rootMargin]);

  return [ref, inView] as const;
}
