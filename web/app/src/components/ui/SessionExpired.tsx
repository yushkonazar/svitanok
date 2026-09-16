import { useEffect, useRef } from 'react';
import { closeApp, haptic } from '../../telegram.ts';

/**
 * Єдиний blocking state для 401/403 від персонального API. Це навмисно не
 * ErrorState з «повторити»: старий Telegram initData не стане чинним від
 * повторного fetch. Власник має відкрити Mini App заново з чату.
 */
export function SessionExpired() {
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  return (
    <main
      role="alert"
      aria-live="assertive"
      className="relative mx-auto flex min-h-[100dvh] w-full max-w-[430px] items-center px-5"
    >
      <section className="w-full rounded-[var(--radius-card)] border border-glassb bg-glass p-6 shadow-2xl">
        <div
          className="mb-4 grid h-11 w-11 place-items-center rounded-2xl bg-a1/15 text-[22px]"
          aria-hidden="true"
        >
          ↻
        </div>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-[20px] font-extrabold tracking-[-0.02em]"
        >
          Сесію завершено
        </h1>
        <p className="mt-2 text-[13px] leading-[1.6] text-tx2">
          Дані не показано. Повернися в чат і відкрий «Svitanok» ще раз — Telegram передасть нову
          сесію.
        </p>
        <button
          type="button"
          onClick={() => {
            haptic('light');
            closeApp();
          }}
          className="mt-5 w-full rounded-xl bg-a1 px-4 py-3 text-[13px] font-extrabold text-onacc"
        >
          Повернутися в чат
        </button>
      </section>
    </main>
  );
}
