import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
type Message = { source: unknown; origin: string; data: Record<string, unknown> };
function fixture() {
  let receive: (event: Message) => void = () => {};
  const parent = { postMessage: vi.fn() },
    scripts: { src: string }[] = [];
  const browser = {
    parent,
    location: { href: 'https://svitanok.yushko.dev/app/travel-map.html' },
    addEventListener: (_name: string, listener: typeof receive) => {
      receive = listener;
    },
  };
  runInNewContext(
    readFileSync(new URL('../web/app/public/travel-map-frame.js', import.meta.url), 'utf8'),
    {
      window: browser,
      document: {
        referrer: 'https://svitanok.yushko.dev/app/',
        createElement: () => ({}),
        head: { appendChild: (script: { src: string }) => scripts.push(script) },
      },
      URL,
      URLSearchParams,
      setTimeout: vi.fn(),
      clearTimeout: vi.fn(),
    },
  );
  const data = {
    type: 'svitanok-map-config',
    key: 'fixture-browser-key',
    mapId: 'fixture-map',
    center: { lat: 50.08, lon: 14.42 },
    markers: [],
  };
  return {
    parent,
    scripts,
    receive: (source: unknown, origin: string) => receive({ source, origin, data }),
  };
}
describe('sandboxed map bootstrap', () => {
  it('does not load Google for a foreign embedding website or a foreign window', () => {
    const f = fixture();
    f.receive(f.parent, 'https://attacker.invalid');
    f.receive({}, 'https://svitanok.yushko.dev');
    expect(f.scripts).toHaveLength(0);
  });
  it('loads the configured map only once for its own embedding application', () => {
    const f = fixture();
    f.receive(f.parent, 'https://svitanok.yushko.dev');
    f.receive(f.parent, 'https://svitanok.yushko.dev');
    expect(f.scripts).toHaveLength(1);
    const url = new URL(f.scripts[0]!.src);
    expect(url.hostname).toBe('maps.googleapis.com');
    expect(url.searchParams.get('key')).toBe('fixture-browser-key');
    expect(f.parent.postMessage).not.toHaveBeenCalled();
  });
});
