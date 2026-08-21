import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';

// Тости про НЕВДАЧУ (аудит C2: «немає видимого фідбеку помилок мутацій» —
// названо найбільшою прогалиною фронтенду).
//
// ЧОМУ ЦЕ ВЗАГАЛІ ПРОБЛЕМА. Дашборд усюди робить оптимістичне оновлення: тап по
// плитці чек-іну, зміна стадії вакансії, ❤️ — усе миттєво міняє екран, а запит
// іде фоном. Коли він падає (мережа в метро, 401 після протухлої сесії),
// react-query акуратно ВІДКОЧУЄ стан — і для власника це виглядає так, ніби тап
// «не зарахувався» без жодної причини. Найгірший варіант: він тапає ще раз.
//
// ⚠️ ТОСТ ЛИШЕ ПРО ПОМИЛКИ. Успіх тут не показуємо: він і так видно — саме тим
// оптимістичним оновленням. Тост на кожну вдалу дію перетворив би чек-ін із
// п'яти тапів на п'ять сповіщень.
//
// Доступність: `role="status"` + `aria-live="polite"` — скрінрідер прочитає
// повідомлення, не перериваючи поточну дію (`alert`/`assertive` тут був би
// агресивним: нічого критичного не сталось, дію можна повторити).

export interface Toast {
  id: number;
  text: string;
}

interface ToastApi {
  /** Показати повідомлення про невдачу. */
  notifyError: (text: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Скільки тост висить. 5с — компроміс: встигнути прочитати довше речення
 *  («Не вдалось зберегти…») і не залипнути над екраном, коли власник уже
 *  зайнятий іншим. */
const TOAST_MS = 5000;

export function ToastProvider({
  children,
  onReady,
}: {
  children: ReactNode;
  /**
   * Міст із НЕ-React світу: `MutationCache` живе поза деревом, тож не має
   * доступу до контексту. Провайдер віддає йому свій `notifyError` одразу після
   * монтування — це дозволяє тримати обробку помилок в ОДНОМУ місці (main.tsx)
   * замість того, щоб прокидати колбек у кожен хук мутації.
   */
  onReady?: (notifyError: (text: string) => void) => void;
}) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const notifyError = useCallback((text: string) => {
    const id = nextId.current++;
    setToasts((prev) => {
      // Дедуп: серія тапів по офлайну дала б стос однакових повідомлень —
      // корисної інформації в другому й третьому нуль.
      if (prev.some((t) => t.text === text)) return prev;
      // Кап 3: більше просто не влізе на екран телефона, а найсвіжіше важливіше.
      return [...prev, { id, text }].slice(-3);
    });
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS);
  }, []);

  const api = useMemo(() => ({ notifyError }), [notifyError]);

  // Віддати міст один раз після монтування. `useEffect`, а не рендер: під час
  // рендера не можна мати побічних ефектів, а StrictMode свідомо викликає
  // рендер двічі.
  useEffect(() => {
    onReady?.(notifyError);
  }, [onReady, notifyError]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Над таб-баром, а не під ним: таб-бар фіксований, і тост, схований за
          ним, дорівнює відсутньому тосту. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[92px] z-[60] flex flex-col items-center gap-2 px-5"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className="pointer-events-auto max-w-[420px] rounded-xl border border-neg/40 bg-bg2 px-3.5 py-2.5 text-[12px] text-tx1 shadow-lg"
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/**
 * Доступ до тостів. Поза провайдером — тихий no-op: тост це фідбек, а не
 * механіка, і тест чи ізольований рендер компонента не мають від цього падати.
 */
export function useToast(): ToastApi {
  return useContext(ToastContext) ?? { notifyError: () => {} };
}
