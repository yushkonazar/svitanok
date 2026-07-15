import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { initTelegram } from './telegram.ts';
import './index.css';

initTelegram();

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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
