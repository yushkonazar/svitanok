import { parseNuxtData } from '../web/core/leisure/nuxt-data.mjs';
import { collectSource, PUBLIC_LEISURE_SOURCES } from '../web/core/leisure/catalog.mjs';
import { DEFAULT_LEISURE_SETTINGS, selectLeisureEdition } from '../web/core/leisure/model.mjs';
import { kyivDateKey } from '../web/kyiv-time.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
const now = Date.now(),
  day = kyivDateKey(new Date(now));
if (process.argv.includes('--catalog')) {
  const results = await Promise.allSettled(
    PUBLIC_LEISURE_SOURCES.map((s) => collectSource(s, now, DEFAULT_LEISURE_SETTINGS)),
  );
  const items = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  const selection = selectLeisureEdition(items, [], [], DEFAULT_LEISURE_SETTINGS, now);
  const report = {
    at: new Date(now).toISOString(),
    sources: results.map((r, i) => ({
      id: PUBLIC_LEISURE_SOURCES[i]?.id,
      status: r.status,
      count: r.status === 'fulfilled' ? r.value.length : 0,
      ...(r.status === 'rejected' ? { error: String(r.reason?.message ?? 'failed') } : {}),
    })),
    items,
    selection,
  };
  mkdirSync('.workspace', { recursive: true });
  writeFileSync('.workspace/leisure-source-report.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        sources: report.sources,
        selected: selection.ids.map((id) => items.find((i) => i.id === id)?.title),
        future: selection.futureIds.map((id) => items.find((i) => i.id === id)?.title),
      },
      null,
      2,
    ),
  );
} else {
  for (const url of [
    `https://planetakino.ua/schedule/?cinema=forum-lviv&date=${day}`,
    `https://planetakino.ua/schedule/?cinema=king-cross-leopolis&date=${day}`,
  ]) {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers: {
        'user-agent': 'Svitanok/0.4 leisure personal catalogue',
        accept: 'text/html,application/json',
      },
    });
    const html = await response.text();
    mkdirSync('.workspace', { recursive: true });
    writeFileSync(`.workspace/planeta-${url.includes('forum') ? 'forum' : 'king'}.html`, html);
    const state = parseNuxtData(html),
      data = state?.data?.[0],
      movie = data?.movie ?? data?.movies?.[0];
    console.log(
      JSON.stringify(
        {
          url,
          parsed: !!state,
          status: response.status,
          redirect: response.headers.get('location'),
          length: html.length,
          dataKeys: Object.keys(data ?? {}),
          selected: data?.selectCinema ?? data?.selectCinemaOption,
          selectCinema: data?.selectCinema,
          cinemaOptions: data?.cinemaOptions,
          sessionIds: movie?.offlineRental?.sessions?.slice(0, 3).map((s) => s.id),
          cinemaState: state?.state?.cinemas?.selectedCinema,
          movie: movie
            ? { title: movie.name, sessionCount: movie.offlineRental?.sessions?.length }
            : null,
        },
        null,
        2,
      ),
    );
  }
}
