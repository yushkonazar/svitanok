// Тонка обгортка над Telegram WebApp SDK (window.Telegram.WebApp). initData —
// авторизація власника (Worker валідує HMAC+owner). Поза Telegram tg=null -> апка
// деградує на SAMPLE-дані (E1). Тут лише читання/сигнали, жодної логіки авторизації
// (вона на сервері, §safety: клієнту не довіряємо).

interface TelegramBackButton {
  show: () => void;
  hide: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string };
  colorScheme?: 'light' | 'dark';
  ready: () => void;
  expand: () => void;
  openLink: (url: string) => void;
  // themeChanged — для теми «Авто» (F2): користувач перемкнув тему в самому
  // Telegram, а Mini App має піти за ним, не чекаючи перезапуску.
  onEvent?: (event: 'themeChanged', cb: () => void) => void;
  offEvent?: (event: 'themeChanged', cb: () => void) => void;
  BackButton?: TelegramBackButton;
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

/**
 * Deep-link параметр Telegram Mini App: t.me/Bot/app?startapp=stats -> 'stats'.
 * Апка мапить його на початкову вкладку (App). Поза Telegram — undefined.
 */
export function startParam(): string | undefined {
  const p = tg?.initDataUnsafe?.start_param;
  return typeof p === 'string' && p.length > 0 ? p : undefined;
}

/**
 * Керування нативною кнопкою «Назад» Telegram. Показуємо її поза домашньою
 * вкладкою; клік веде на домашню (App). Повертає функцію відписки (no-op поза
 * Telegram), щоб ефект React міг прибрати обробник.
 */
export function setBackButton(visible: boolean, onClick: () => void): () => void {
  const bb = tg?.BackButton;
  if (!bb) return () => {};
  if (visible) {
    bb.onClick(onClick);
    bb.show();
    return () => {
      bb.offClick(onClick);
      bb.hide();
    };
  }
  bb.hide();
  return () => {};
}
