// Тонка обгортка над Telegram WebApp SDK (window.Telegram.WebApp). initData —
// авторизація власника (Worker валідує HMAC+owner). Поза Telegram tg=null -> апка
// деградує на SAMPLE-дані (E1). Тут лише читання/сигнали, жодної логіки авторизації
// (вона на сервері, §safety: клієнту не довіряємо).

interface TelegramWebApp {
  initData: string;
  colorScheme?: 'light' | 'dark';
  ready: () => void;
  expand: () => void;
  openLink: (url: string) => void;
  HapticFeedback?: {
    impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred?: (type: 'success' | 'warning' | 'error') => void;
  };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export const tg: TelegramWebApp | null = window.Telegram?.WebApp ?? null;

/** Чи ми всередині Telegram із initData (інакше — демо/SAMPLE поза Telegram). */
export const inTelegram = (): boolean => !!tg && typeof tg.initData === 'string' && tg.initData.length > 0;

/** Ініціалізувати Mini App (ready+expand) — викликати раз на старті. */
export function initTelegram(): void {
  if (!tg) return;
  try {
    tg.ready();
    tg.expand();
  } catch {
    /* поза Telegram методи можуть кинути — ігноруємо */
  }
}

/** Відкрити зовнішнє посилання (у Telegram — через openLink, інакше нова вкладка). */
export function openLink(url: string): void {
  if (tg?.openLink) tg.openLink(url);
  else window.open(url, '_blank', 'noopener');
}

/** Тактильний відгук (no-op поза Telegram). */
export function haptic(kind: 'light' | 'success' | 'warning' | 'error' = 'light'): void {
  const hf = tg?.HapticFeedback;
  if (!hf) return;
  if (kind === 'light') hf.impactOccurred?.('light');
  else hf.notificationOccurred?.(kind);
}
