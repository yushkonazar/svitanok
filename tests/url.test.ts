import { describe, it, expect } from 'vitest';
import { canonicalizeUrl, sameUrl, isHttpUrl } from '../src/core/url.js';

describe('url — зрізання ключів (§19.4)', () => {
  it('OpenWeather appid вирізається, секрет не лишається', () => {
    const out = canonicalizeUrl(
      'https://api.openweathermap.org/data/2.5/forecast?lat=49&lon=24&appid=SECRET123&units=metric',
    );
    expect(out).not.toContain('SECRET123');
    expect(out).not.toContain('appid');
    expect(out).toContain('lat=49');
    expect(out).toContain('units=metric');
  });

  it('вирізає apikey/api_key/token/key/access_token', () => {
    for (const k of ['apikey', 'api_key', 'token', 'key', 'access_token', 'client_secret']) {
      const out = canonicalizeUrl(`https://x.com/a?${k}=LEAK&q=1`);
      expect(out, k).not.toContain('LEAK');
      expect(out, k).toContain('q=1');
    }
  });
});

describe('url — канонізація', () => {
  it('нижній регістр схеми й хоста', () => {
    expect(canonicalizeUrl('HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
  });

  it('прибирає utm_* і трекінг', () => {
    const out = canonicalizeUrl('https://x.com/a?utm_source=tg&fbclid=123&id=7');
    expect(out).toBe('https://x.com/a?id=7');
  });

  it('прибирає fragment і трейлінг-слеш', () => {
    expect(canonicalizeUrl('https://x.com/a/#section')).toBe('https://x.com/a');
  });

  it('корінь зберігає слеш', () => {
    expect(canonicalizeUrl('https://x.com/')).toBe('https://x.com/');
  });

  it('сортує query — стабільна форма', () => {
    expect(canonicalizeUrl('https://x.com/a?b=2&a=1')).toBe('https://x.com/a?a=1&b=2');
  });

  it('невалідний URL повертається як є (trim)', () => {
    expect(canonicalizeUrl('  not a url  ')).toBe('not a url');
  });
});

describe('url — isHttpUrl (безпечна схема лінка, M2)', () => {
  it('приймає http/https (у т.ч. верхній регістр)', () => {
    expect(isHttpUrl('https://x.com/a')).toBe(true);
    expect(isHttpUrl('http://x.com')).toBe(true);
    expect(isHttpUrl('HTTPS://X.COM')).toBe(true);
  });

  it('відкидає javascript:/data:/file: та сміття', () => {
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
    expect(isHttpUrl('  not a url  ')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('url — sameUrl (однакова канонізація обох боків, §6 п.4)', () => {
  it('фетчений vs LLM-варіант з трекінгом/регістром — рівні', () => {
    const fetched = 'https://news.example.com/Article?id=42';
    const fromLlm = 'HTTPS://News.Example.com/Article?id=42&utm_campaign=x#top';
    expect(sameUrl(fetched, fromLlm)).toBe(true);
  });

  it('різні статті — не рівні', () => {
    expect(sameUrl('https://x.com/a?id=1', 'https://x.com/a?id=2')).toBe(false);
  });
});
