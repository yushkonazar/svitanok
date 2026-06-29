// SourceFetcher — тільки allowlist по хосту, таймаут, ретрай з бекофом (§8).
// Використовується ЛИШЕ для джерел із config (RSS/API). Лінки з контенту/LLM
// server-side не відкриваємо (анти-SSRF, §8).

import type { SourceFetcher, Logger } from './types.js';

export interface FetcherOptions {
  /** Дозволені хости (напр. ['feeds.bbci.co.uk']). */
  allowlist: string[];
  timeoutMs: number;
  retries: number;
  log?: Logger;
  fetchImpl?: typeof fetch;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.min(500 * 2 ** attempt, 5000);

// Деякі RSS-сервери віддають 403 без User-Agent — шлемо явний.
const USER_AGENT =
  'Mozilla/5.0 (compatible; svitanok-bot/1.0; +https://github.com/yushkonazar/svitanok)';

export function createFetcher(opts: FetcherOptions): SourceFetcher {
  const allow = new Set(opts.allowlist.map((h) => h.toLowerCase()));
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function once(url: string): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await fetchImpl(url, {
        signal: ctrl.signal,
        redirect: 'follow',
        headers: {
          'user-agent': USER_AGENT,
          accept: 'application/rss+xml, application/xml, text/xml, */*',
        },
      });
      if (!res.ok) throw new Error(`fetch HTTP ${res.status} для ${url}`);
      return await res.text();
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async fetch(url: string): Promise<string> {
      const host = new URL(url).hostname.toLowerCase();
      if (!allow.has(host)) {
        throw new Error(`fetch заблоковано (не в allowlist): ${host}`);
      }
      let lastErr: unknown;
      for (let attempt = 0; attempt <= opts.retries; attempt++) {
        try {
          return await once(url);
        } catch (e) {
          lastErr = e;
          opts.log?.warn(`fetch спроба ${attempt + 1} впала для ${host}`);
          if (attempt < opts.retries) await delay(backoffMs(attempt));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}
