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
const MAX_REDIRECTS = 5;

// Деякі RSS-сервери віддають 403 без User-Agent — шлемо явний.
const USER_AGENT =
  'Mozilla/5.0 (compatible; svitanok-bot/1.0; +https://github.com/yushkonazar/svitanok)';

export function createFetcher(opts: FetcherOptions): SourceFetcher {
  const allow = new Set(opts.allowlist.map((h) => h.toLowerCase()));
  const fetchImpl = opts.fetchImpl ?? fetch;

  const ensureAllowed = (u: string): string => {
    const host = new URL(u).hostname.toLowerCase();
    if (!allow.has(host)) {
      throw new Error(`fetch заблоковано (не в allowlist): ${host}`);
    }
    return host;
  };

  // Ручне слідування редиректам: КОЖЕН хоп звіряємо з allowlist (анти-SSRF §8).
  // `redirect: 'follow'` йшов би куди завгодно поза allowlist — це послаблювало
  // б задекларовану гарантію (M3). У Node (undici) `manual` віддає 3xx+Location.
  async function once(startUrl: string): Promise<string> {
    let url = startUrl;
    for (let hop = 0; ; hop++) {
      ensureAllowed(url);
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
      let res: Response;
      let body: string | null = null;
      try {
        res = await fetchImpl(url, {
          signal: ctrl.signal,
          redirect: 'manual',
          headers: {
            'user-agent': USER_AGENT,
            accept: 'application/rss+xml, application/xml, text/xml, */*',
          },
        });
        // Тіло — ПІД тим самим таймаутом (B14). Доти clearTimeout спрацьовував
        // одразу після заголовків, і зависла стрічка тіла (RSS-сервер віддав
        // 200 й замовк) тримала прогін до 360-хв ліміту job'а. Читаємо лише
        // для фінальної відповіді: у 3xx тіло не потрібне, а редирект іде
        // наступним хопом зі своїм свіжим таймаутом.
        if (res.ok) body = await res.text();
      } finally {
        clearTimeout(timer);
      }
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`fetch редирект ${res.status} без Location для ${url}`);
        if (hop >= MAX_REDIRECTS) {
          throw new Error(`fetch забагато редиректів (>${MAX_REDIRECTS}) від ${startUrl}`);
        }
        url = new URL(loc, url).toString(); // відносний Location -> абсолютний
        continue;
      }
      if (!res.ok) throw new Error(`fetch HTTP ${res.status} для ${url}`);
      return body ?? '';
    }
  }

  return {
    async fetch(url: string): Promise<string> {
      // Швидкий відсів заблокованого хоста ДО ретрай-циклу (кожен хоп once()
      // теж перевіряє — редиректи).
      ensureAllowed(url);
      let lastErr: unknown;
      for (let attempt = 0; attempt <= opts.retries; attempt++) {
        try {
          return await once(url);
        } catch (e) {
          lastErr = e;
          const why = e instanceof Error ? e.message : String(e);
          opts.log?.warn(`fetch спроба ${attempt + 1} впала для ${url}: ${why}`);
          if (attempt < opts.retries) await delay(backoffMs(attempt));
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    },
  };
}
