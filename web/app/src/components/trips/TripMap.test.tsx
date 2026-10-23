import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TripMap, trustedMapFrame } from './TripMap.tsx';
import * as api from '../../api/trips.ts';
vi.mock('../../api/trips.ts', async (original) => ({
  ...(await original<typeof api>()),
  fetchTripMap: vi.fn(),
}));
vi.mock('../../telegram.ts', () => ({ openLink: vi.fn() }));
beforeEach(() => vi.mocked(api.fetchTripMap).mockReset());
function mount(onPick = vi.fn()) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={cache}>
      <TripMap id="fixture-trip" kind="stay" version="one" onPick={onPick} />
    </QueryClientProvider>,
  );
  return onPick;
}
describe('isolated trip map', () => {
  it('shows an external action when map credentials are absent and loads no third-party frame', async () => {
    vi.mocked(api.fetchTripMap).mockResolvedValue({
      enabled: false,
      external_url: 'https://www.google.com/maps/search/?api=1&query=Prague',
      message: 'Мапу ще не підключено.',
    });
    mount();
    expect(await screen.findByText('Мапу ще не підключено.')).toBeVisible();
    expect(screen.queryByTitle('Google Maps')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Відкрити Google Maps ↗' })).toBeVisible();
  });
  it('rejects same-origin and foreign map frame addresses', () => {
    expect(trustedMapFrame(window.location.origin + '/app/travel-map.html')).toBe('');
    expect(
      trustedMapFrame('https://maps.svitanok.yushko.dev.attacker.invalid/travel-map.html'),
    ).toBe('');
    expect(trustedMapFrame('https://user:pass@maps.svitanok.yushko.dev/travel-map.html')).toBe('');
  });
  it('accepts marker clicks only from its separate host and only for known points', async () => {
    vi.mocked(api.fetchTripMap).mockResolvedValue({
      enabled: true,
      external_url: 'https://www.google.com/maps/',
      api_key: 'fixture-browser-key',
      map_id: 'fixture-map',
      frame_url: 'https://maps.svitanok.yushko.dev/travel-map.html',
      center: { lat: 50.08, lon: 14.42 },
      markers: [{ id: 'fixture-hotel', title: 'Hotel', lat: 50.08, lon: 14.42 }],
    });
    const onPick = mount();
    const frame = (await screen.findByTitle('Google Maps')) as HTMLIFrameElement;
    expect(new URL(frame.src).origin).not.toBe(window.location.origin);
    expect(frame.src).not.toContain('fixture-browser-key');
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: 'https://maps.svitanok.yushko.dev',
        data: { type: 'svitanok-map-pick', id: 'fixture-hotel' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'https://attacker.invalid',
        data: { type: 'svitanok-map-pick', id: 'fixture-hotel' },
      }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'https://maps.svitanok.yushko.dev',
        data: { type: 'svitanok-map-pick', id: 'foreign-point' },
      }),
    );
    expect(onPick).not.toHaveBeenCalled();
    window.dispatchEvent(
      new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'https://maps.svitanok.yushko.dev',
        data: { type: 'svitanok-map-pick', id: 'fixture-hotel' },
      }),
    );
    await waitFor(() => expect(onPick).toHaveBeenCalledExactlyOnceWith('fixture-hotel'));
  });
});
