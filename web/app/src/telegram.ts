// Тонка обгортка над Telegram WebApp SDK (window.Telegram.WebApp). initData —
// авторизація власника (Worker валідує HMAC+owner). Поза Telegram tg=null -> апка
// деградує на SAMPLE-дані (E1). Тут лише читання/сигнали, жодної логіки авторизації
// (вона на сервері, §safety: клієнту не довіряємо).

export type HomeScreenStatus = 'unsupported' | 'unknown' | 'added' | 'missed';

interface TelegramBackButton {
  show: () => void;
  hide: () => void;
  onClick: (cb: () => void) => void;
  offClick: (cb: () => void) => void;
}

// Bot API 6.9+. На відміну від localStorage — гарантовано персистить між
// окремими запусками Mini App (синк на боці Telegram, не WebView-сховище,
// яке платформа може чистити між сесіями). Callback-based, як і весь
// нативний SDK Telegram.
interface TelegramCloudStorage {
  setItem: (key: string, value: string, cb?: (err: unknown, success?: boolean) => void) => void;
  getItem: (key: string, cb: (err: unknown, value?: string) => void) => void;
  removeItem: (key: string, cb?: (err: unknown, success?: boolean) => void) => void;
}

interface TelegramLocationData {
  latitude: number;
  longitude: number;
}

// Bot API 8.0+. Нативна геолокація Telegram — йде через дозвіл САМОГО
// Telegram (host app, OS-рівень), не через web Geolocation API/Permissions-
// Policy WebView. init() обовʼязковий перед getLocation() — виставляє
// isLocationAvailable/isAccessGranted.
interface TelegramLocationManager {
  isLocationAvailable?: boolean;
  isAccessGranted?: boolean;
  init: (cb?: () => void) => void;
  getLocation: (cb: (data: TelegramLocationData | null) => void) => void;
  // Відкриває системні налаштування дозволів (Bot API 8.0+) — коли
  // isLocationAvailable/isAccessGranted false, це майже завжди ОС-рівень
  // (вимкнена геолокація на пристрої або немає дозволу в самого Telegram),
  // не щось виправне кодом. Пряме посилання замість «шукай сам у налаштуваннях».
  openSettings?: () => void;
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
  onEvent?: (
    event: 'themeChanged' | 'homeScreenAdded' | 'homeScreenChecked',
    cb: (payload?: { status: HomeScreenStatus }) => void,
  ) => void;
  offEvent?: (
    event: 'themeChanged' | 'homeScreenAdded' | 'homeScreenChecked',
    cb: (payload?: { status: HomeScreenStatus }) => void,
  ) => void;
  // Bot API 8.0+: ярлик на домашній екран пристрою — обходить усю навігацію
  // Telegram (menu-кнопка недоступна в групах, reply-клавіатура ненадійна на
  // Desktop у супергрупах/форум-темах), один тап із робочого столу напряму в
  // Mini App.
  addToHomeScreen?: () => void;
  checkHomeScreenStatus?: (cb: (status: HomeScreenStatus) => void) => void;
  BackButton?: TelegramBackButton;
  HapticFeedback?: {
    impactOccurred?: (style: 'light' | 'medium' | 'heavy') => void;
    notificationOccurred?: (type: 'success' | 'warning' | 'error') => void;
  };
  CloudStorage?: TelegramCloudStorage;
  LocationManager?: TelegramLocationManager;
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

/**
 * Статус ярлика на домашньому екрані (Bot API 8.0+). callback — той самий
 * стиль, що й у SDK: 'unsupported' лишається дефолтом (не 'unknown'), щоб
 * старий клієнт/старий Telegram трактувався як «немає кнопки», а не «є, але
 * незрозуміло» — консервативніший фолбек для UI, який вирішує, показувати
 * кнопку «Додати на головний екран» чи ні.
 */
export function checkHomeScreenStatus(cb: (status: HomeScreenStatus) => void): void {
  if (!tg?.checkHomeScreenStatus) {
    cb('unsupported');
    return;
  }
  try {
    tg.checkHomeScreenStatus(cb);
  } catch {
    cb('unsupported');
  }
}

/** Показати системний промпт «Додати Світанок на головний екран» (Bot API 8.0+). */
export function addToHomeScreen(): void {
  try {
    tg?.addToHomeScreen?.();
  } catch {
    /* хост може не підтримувати — no-op */
  }
}

/**
 * CloudStorage (Bot API 6.9+) — тонкі Promise-обгортки над callback-API.
 * null/no-op на будь-який збій чи відсутність підтримки (старий клієнт,
 * поза Telegram) — виклики лишаються простим await без окремого error-шляху,
 * той самий «м'який» контракт, що й fetchLiveWeather.
 */
export function cloudGetItem(key: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!tg?.CloudStorage?.getItem) {
      resolve(null);
      return;
    }
    try {
      tg.CloudStorage.getItem(key, (err, value) => resolve(err ? null : (value ?? null)));
    } catch {
      resolve(null);
    }
  });
}

export function cloudSetItem(key: string, value: string): void {
  try {
    tg?.CloudStorage?.setItem?.(key, value);
  } catch {
    /* старий клієнт/збій — тихо ігноруємо */
  }
}

export function cloudRemoveItem(key: string): void {
  try {
    tg?.CloudStorage?.removeItem?.(key);
  } catch {
    /* те саме */
  }
}

export type TelegramLocationResult =
  | { ok: true; lat: number; lon: number }
  | { ok: false; reason: 'unsupported' | 'unavailable' | 'denied' };

/**
 * Нативна геолокація Telegram (Bot API 8.0+, LocationManager) — ЗАМІСТЬ
 * navigator.geolocation, коли доступна. Хост-девайс власника мовчки НІКОЛИ
 * не відповідав на стандартний web Geolocation API (ні успіхом, ні
 * помилкою, навіть довго після власного timeout) — ознака, що сам API
 * заблокований на рівні WebView, в якому Telegram рендерить Mini App
 * (Permissions-Policy на iframe тощо), а не відмова дозволу користувачем.
 * LocationManager іде через дозвіл САМОГО Telegram (host app), в обхід
 * цього шару. 'unsupported' — старий клієнт без LocationManager узагалі
 * (виклик коду лишає фолбек на navigator.geolocation).
 *
 * Захисний timeout: у сирцях офіційного SDK (telegram-web-app.js) init()
 * на клієнті зі старою версією просто МОВЧКИ повертається — checkVersion()
 * не пропускає, і переданий колбек ніколи не викликається. Обʼєкт
 * LocationManager при цьому МОЖЕ існувати (перевірено — старий/фолбек
 * клієнт логує «LocationManager is not supported in version X», але саму
 * властивість не приховує), тож перевірка `!lm` це не ловить. Без таймауту
 * це той самий клас «тихого зависання» назавжди, що вже був з
 * navigator.geolocation (PR #234) — тепер закритий і тут.
 */
export function getTelegramLocation(): Promise<TelegramLocationResult> {
  return new Promise((resolve) => {
    const lm = tg?.LocationManager;
    if (!lm) {
      resolve({ ok: false, reason: 'unsupported' });
      return;
    }

    let settled = false;
    const settle = (r: TelegramLocationResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const timeoutId = setTimeout(() => settle({ ok: false, reason: 'unsupported' }), 8_000);

    try {
      lm.init(() => {
        if (!lm.isLocationAvailable) {
          clearTimeout(timeoutId);
          settle({ ok: false, reason: 'unavailable' });
          return;
        }
        try {
          lm.getLocation((data) => {
            clearTimeout(timeoutId);
            if (data) settle({ ok: true, lat: data.latitude, lon: data.longitude });
            else settle({ ok: false, reason: 'denied' });
          });
        } catch {
          clearTimeout(timeoutId);
          settle({ ok: false, reason: 'unsupported' });
        }
      });
    } catch {
      clearTimeout(timeoutId);
      settle({ ok: false, reason: 'unsupported' });
    }
  });
}

/**
 * Відкрити системні налаштування дозволу геолокації (Bot API 8.0+) — коли
 * getTelegramLocation() дав reason:'unavailable'/'denied', це майже завжди
 * ОС-рівень (вимкнена геолокація на пристрої або немає дозволу в самого
 * Telegram), не щось виправне кодом. Пряме посилання замість «шукай сам».
 */
export function openLocationSettings(): void {
  try {
    tg?.LocationManager?.openSettings?.();
  } catch {
    /* старий клієнт/збій — тихо ігноруємо */
  }
}
