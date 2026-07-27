import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { ThemeProvider } from './theme.tsx';
import { SavedProvider } from './saved.tsx';
import { initTelegram } from './telegram.ts';
import './index.css';

initTelegram();

// Скрол вкладок веде App.tsx (скидання на зміну маршруту), а не браузер.
// Обовʼязково саме тут, а не в компоненті: при HashRouter кожен перехід — це
// запис в історії, і зі стандартним 'auto' браузер САМ повертає запамʼятовану
// позицію для цього хеша — ПІСЛЯ нашого layout-ефекту. Тобто без цього рядка
// скидання «спрацьовує» й тут же відкочується: перехід «Статистика (прогорнуто
// вниз) -> Сьогодні» приземлявся не вгорі, а там, де «Сьогодні» лишили минулого
// разу. 'manual' знімає це втручання; за собою прибираємо теж ми.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

// TanStack Query — кеш + рефетч даних дашборда (E1). Дані живуть 1 хв свіжими;
// рефетч після мутацій (збереження/голос) — через invalidate у відповідних хуках.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// HashRouter (не BrowserRouter): /app віддається статикою Workers Assets без
// SPA-rewrite, тож роутинг тримаємо в хеші (/app/#/stats) — жодного серверного
// налаштування, а deep-link усе одно шеряться.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SavedProvider>
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
        </ThemeProvider>
      </SavedProvider>
    </QueryClientProvider>
  </StrictMode>,
);
