// HTTP-таймаути брифінгу: AbortController-обгортка й fetch-JSON під тим самим
// таймаутом. Файл народився як «Google-конектор» (OAuth refresh-token grant для
// calendar.ts і mail.ts) - звідси назва.
//
// ⚠️ OAUTH ТУТ БІЛЬШЕ НЕМАЄ (ADR-027, етап 7 редизайну): брифінг не ходить ані
// в Gmail, ані в Calendar - обидва блоки приходять із KV, які наповнює ядро.
// Разом із кодом пішли й секрети GOOGLE_* із GitHub Secrets. Лишились дві
// загальні функції, які імпортують weather.ts і state-kv.ts; перейменування
// файла - окремий рух, щоб не змішувати його з видаленням доступу.

/** AbortController-обгортка з таймаутом — спільна для token-обміну й API-викликів. */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fetch + читання тіла В ОДНОМУ таймаут-вікні (B14).
 *
 * `withTimeout(signal => fetch(...))` покриває лише ЗАГОЛОВКИ: щойно прийшов
 * статус, промісе резолвиться, timer знімається у finally — і `await
 * res.json()` тягне стрічку тіла вже без жодної межі. Сервер, що віддав
 * заголовки й завис на тілі, підвішував увесь прогін брифінгу до 360-хв ліміту
 * job'а GitHub Actions: ні алерту, ні падіння — просто ран, що не кінчається.
 * Тут abort лишається озброєним, доки тіло не прочитане, а undici привʼязує
 * читання тіла до signal запиту — тож обривається саме воно.
 *
 * НЕ кидає на HTTP-помилку: віддає {ok,status,body} і лишає обробку викликачу
 * (у кожного модуля своя — throw, null чи пропуск елемента). Тіло читаємо лише
 * для ok-відповідей: на 4xx/5xx воно нікому не потрібне, а читати його — ще
 * одне таке саме вікно зависання.
 *
 * Живе тут поруч із withTimeout, який модулі вже імпортують саме звідси
 * (calendar/mail); винесення обох у власний http-модуль — окремий рефактор.
 */
export async function fetchJsonWithTimeout<T = unknown>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; body: T | null }> {
  return withTimeout(async (signal) => {
    const res = await fetchImpl(url, { ...init, signal });
    return {
      ok: res.ok,
      status: res.status,
      body: res.ok ? ((await res.json()) as T) : null,
    };
  }, timeoutMs);
}
