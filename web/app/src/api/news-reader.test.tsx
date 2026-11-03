import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { renderHook, act, waitFor, render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { StrictMode, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { NewsScreen } from '../components/news/NewsScreen.tsx';
import { useNewsStoryAction } from './hooks.ts';
import { newsDemoSnapshot } from './news-demo.ts';
vi.mock('../telegram.ts', () => ({ inTelegram: () => false, haptic: vi.fn(), tg: null }));
beforeEach(() => {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value),
    removeItem: (key: string) => data.delete(key),
  });
});
afterEach(() => {
  onlineManager.setOnline(true);
  vi.unstubAllGlobals();
});
it('completes automatic read synchronization under StrictMode before enabling following', async () => {
  vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <StrictMode>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={['/news']}>
          <NewsScreen />
        </MemoryRouter>
      </QueryClientProvider>
    </StrictMode>,
  );
  const open = await screen.findByRole('button', {
    name: 'Відкрити: Австралія перевіряє зв’язки другого пілота Flydubai з країною',
  });
  fireEvent.click(open);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Стежити за подією' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Стежити за подією' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Стежу' })).toHaveAttribute('aria-pressed', 'true'),
  );
  qc.clear();
  vi.restoreAllMocks();
});
it('settles demo reader actions even when the browser reports offline and preserves server-like state', async () => {
  onlineManager.setOnline(false);
  const qc = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    }),
    snapshot = newsDemoSnapshot();
  qc.setQueryData(['newsSnapshot'], snapshot);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useNewsStoryAction(), { wrapper }),
    item = snapshot.groups[0]!.items[0]!;
  await act(async () => {
    await result.current.mutateAsync({
      type: 'story',
      storyId: item.url,
      action: 'read',
      version: item.publishedAt,
    });
  });
  await waitFor(() => expect(result.current.isPending).toBe(false));
  expect(
    qc.getQueryData<ReturnType<typeof newsDemoSnapshot>>(['newsSnapshot'])?.reader?.readVersions[
      item.url
    ],
  ).toContain(item.publishedAt);
  await act(async () => {
    await result.current.mutateAsync({ type: 'story', storyId: item.url, action: 'follow' });
  });
  expect(
    qc.getQueryData<ReturnType<typeof newsDemoSnapshot>>(['newsSnapshot'])?.reader?.following[
      item.url
    ]?.item.title,
  ).toBe(item.title);
  qc.clear();
});
