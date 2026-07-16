import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { tg, inTelegram } from './telegram.ts';

// Перемикач теми (роадмеп v3, E — фідбек власника: світла+темна; F2 — «Авто»).
// Токени обох тем живуть у index.css; тут лише вибір 'light'|'dark'|'auto' +
// запис у <html data-theme>, звідки CSS-змінні перевизначаються.
//
// Зберігаємо ПЕРЕВАГУ (pref), не обчислену тему: інакше 'auto' застигав би на
// значенні, яке було в момент вибору. Старі збережені 'light'/'dark' лишаються
// валідними — це й є pref.
//
// 'auto' = тема Telegram-клієнта (у вебв'ю) або системна (у браузері), і слухає
// зміни наживо: у Telegram — подія themeChanged, у браузері — matchMedia.

export type Theme = 'light' | 'dark';
export type ThemePref = Theme | 'auto';

const STORAGE_KEY = 'svitanok-theme';

function readInitialPref(): ThemePref {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark' || saved === 'auto') return saved;
  } catch {
    /* localStorage може бути недоступним (приватний режим) — ігноруємо */
  }
  return 'auto';
}

/** Поточна «зовнішня» тема: Telegram-клієнт у вебв'ю, інакше системна. */
function ambientTheme(): Theme {
  if (inTelegram() && tg) return tg.colorScheme === 'light' ? 'light' : 'dark';
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function resolve(pref: ThemePref, ambient: Theme): Theme {
  return pref === 'auto' ? ambient : pref;
}

interface ThemeContextValue {
  /** Застосована тема (те, що видно). */
  theme: Theme;
  /** Вибір власника: 'dark' | 'light' | 'auto'. */
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  /** Швидкий тумблер у хедері: фіксує протилежну до поточної (знімає 'auto'). */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: 'dark',
  pref: 'auto',
  setPref: () => {},
  toggle: () => {},
});

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [pref, setPrefState] = useState<ThemePref>(readInitialPref);
  const [ambient, setAmbient] = useState<Theme>(ambientTheme);
  const theme = resolve(pref, ambient);

  // useLayoutEffect (не useEffect) — застосувати тему до першого кадру, без спалаху.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    // color-scheme — щоб нативні контроли (напр. <input type="time">) малювались
    // у тон темі, а не білою пігулкою на темному тлі.
    root.style.colorScheme = theme;
  }, [theme]);

  useLayoutEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, pref);
    } catch {
      /* ignore */
    }
  }, [pref]);

  // Стежимо за зовнішньою темою ЗАВЖДИ (не лише в 'auto'): так перемикання на
  // 'auto' одразу дає свіже значення, без чекання наступної події.
  useEffect(() => {
    const app = tg;
    if (inTelegram() && app?.onEvent) {
      const onChange = () => setAmbient(ambientTheme());
      app.onEvent('themeChanged', onChange);
      return () => app.offEvent?.('themeChanged', onChange);
    }
    try {
      const mq = window.matchMedia('(prefers-color-scheme: light)');
      const onChange = () => setAmbient(ambientTheme());
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    } catch {
      return undefined; // matchMedia недоступний — лишаємось на початковому
    }
  }, []);

  const setPref = useCallback((p: ThemePref) => setPrefState(p), []);
  const toggle = useCallback(() => {
    setPrefState(resolve(pref, ambient) === 'dark' ? 'light' : 'dark');
  }, [pref, ambient]);

  return (
    <ThemeContext.Provider value={{ theme, pref, setPref, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
