import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { ThemeProvider } from './theme.tsx';
import { SavedProvider } from './saved.tsx';
import { ToastProvider } from './components/ui/Toast.tsx';
import { mutationErrorText } from './lib/mutationError.ts';
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
// ⚠️ Клієнт створюється ПІСЛЯ рендера провайдера тостів? Ні — навпаки: тости
// живуть у React-дереві, а MutationCache — поза ним. Тому міст односторонній:
// кеш кладе текст у чергу-«поштову скриньку», а провайдер її читає (див.
// pendingToasts нижче). Альтернатива — прокидати notifyError у КОЖЕН хук
// мутації — саме те дублювання, через яке фідбек і не зʼявився досі.
const pendingToasts: string[] = [];
let deliverToast: ((text: string) => void) | null = null;

/** Викликається провайдером, щойно він змонтувався: віддає накопичене й бере
 *  доставку на себе. */
function attachToastSink(sink: (text: string) => void) {
  deliverToast = sink;
  while (pendingToasts.length) sink(pendingToasts.shift()!);
}

const queryClient = new QueryClient({
  // ОДНЕ місце на всі мутації (аудит C2: «немає видимого фідбеку помилок
  // мутацій» — найбільша прогалина фронтенду). Кожна мутація дашборда оновлює
  // екран оптимістично, і react-query при помилці тихо ВІДКОЧУЄ стан: без
  // цього рядка тап виглядав як «не зарахувався» без причини.
  mutationCache: new MutationCache({
    onError: (error) => {
      const text = mutationErrorText(error);
      if (deliverToast) deliverToast(text);
      else pendingToasts.push(text);
    },
  }),
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
      <ToastProvider onReady={attachToastSink}>
        <SavedProvider>
        <ThemeProvider>
          <HashRouter>
            <App />
          </HashRouter>
          </ThemeProvider>
        </SavedProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
