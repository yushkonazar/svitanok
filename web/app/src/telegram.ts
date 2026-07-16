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
  version?: string;
  isVersionAtLeast?: (v: string) => boolean;
  ready: () => void;
  expand: () => void;
  openLink: (url: string) => void;
  // Bot API 7.7+: гасить НАТИВНИЙ жест Telegram «свайп вниз = закрити/згорнути».
  // CSS touch-action тут безсилий — жест живе на контейнері вебвʼю, поза сторінкою.
  disableVerticalSwipes?: () => void;
  enableVerticalSwipes?: () => void;
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

/**
 * Дозволити/заборонити нативний свайп «вниз = закрити апку» (Bot API 7.7+).
 *
 * Навіщо: канбан тягне картку пальцем ВНИЗ, і Telegram сприймає це як
 * pull-to-dismiss — апка починає закриватись замість перетягування. Жест
 * нативний (UIPanGestureRecognizer на контейнері WKWebView), тож ні
 * touch-action, ні preventDefault до нього не дістають — лише хост-API.
 *
 * Озброюється він лише коли сторінка вгорі (scrollTop === 0) і тягнеш униз —
 * тому баг і ловився саме на верхній картці.
 *
 * Старий клієнт (< 7.7) методу не має: isVersionAtLeast гейтить, бо виклик там
 * лише насмітить у консоль попередженням і нічого не зробить.
 */
export function setVerticalSwipes(enabled: boolean): void {
  if (!tg?.isVersionAtLeast?.('7.7')) return;
  try {
    if (enabled) tg.enableVerticalSwipes?.();
    else tg.disableVerticalSwipes?.();
  } catch {
    /* хост може не підтримувати — не валимо жест через це */
  }
}
