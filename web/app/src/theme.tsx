import { createContext, useCallback, useContext, useLayoutEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { tg } from './telegram.ts';

// Перемикач теми (роадмеп v3, E — фідбек власника: світла+темна). Токени обох
// тем живуть у index.css; тут лише стан 'light'|'dark' + запис у <html data-theme>,
// звідки CSS-змінні перевизначаються. Дефолт: збережений вибір -> тема Telegram
// (colorScheme) -> темна.

export type Theme = 'light' | 'dark';
const STORAGE_KEY = 'svitanok-theme';

function readInitialTheme(): Theme {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* localStorage може бути недоступним (приватний режим) — ігноруємо */
  }
  return tg?.colorScheme === 'light' ? 'light' : 'dark';
}

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: 'dark', toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(readInitialTheme);

  // useLayoutEffect (не useEffect) — застосувати тему до першого кадру, без спалаху.
  useLayoutEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
