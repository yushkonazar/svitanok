import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/core/config.js';
import {
  prepareContent,
  validatePreparedBatch,
  contentResponse,
  type Candidate,
} from '../src/core/content-preparation.js';
import {
  batchSchema,
  contentIdentity,
  DEFAULT_CONTENT_PREFERENCES,
  monthDays,
} from '../web/core/brief/daily-content.mjs';
import oldFacts from '../src/data/verified-facts.json' with { type: 'json' };
import oldQuotes from '../src/data/verified-stoic.json' with { type: 'json' };
import { octoberFacts, octoberQuotes } from '../src/data/content-october.js';

export function nextContentMonth(now: Date) {
  const kyivDate = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const [year, month] = kyivDate.split('-').map(Number);
  return new Date(Date.UTC(year!, month!, 1)).toISOString().slice(0, 7);
}
export async function main() {
  const account = process.env.CF_ACCOUNT_ID?.trim(),
    token = process.env.CF_API_TOKEN?.trim(),
    namespace = process.env.KV_NAMESPACE_ID?.trim(),
    apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!account || !token || !namespace || !apiKey)
    throw new Error('Monthly content credentials missing');
  const month = process.env.CONTENT_MONTH?.trim() || nextContentMonth(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid content month');
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/values/`;
  async function read(key: string): Promise<unknown> {
    const res = await fetch(base + encodeURIComponent(key), {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Content storage read HTTP ${res.status}`);
    return res.json();
  }
  async function write(key: string, value: unknown) {
    const res = await fetch(base + encodeURIComponent(key), {
      method: 'PUT',
      signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    if (!res.ok) throw new Error(`Content storage write HTTP ${res.status}`);
  }
  const existing = batchSchema.safeParse(await read(`dailyContent:batch:${month}`));
  if (existing.success && existing.data.month === month) {
    console.log(`Content ${month} already prepared; no provider calls.`);
    return;
  }
  const stored = await read('dailyContent:ledger');
  if (stored !== null && !Array.isArray(stored))
    throw new Error('Content ledger corrupted; refusing to replace it');
  const legacy = [...oldFacts, ...octoberFacts].map((n) => ({
    ...n,
    id: contentIdentity(n, 'fact'),
  }));
  const legacyQuotes = [...oldQuotes, ...octoberQuotes].map((n) => ({
    ...n,
    id: contentIdentity(n, 'quote'),
  }));
  const previous = [...legacy, ...legacyQuotes, ...((stored as Candidate[]) ?? [])] as Candidate[];
  if (previous.length > 5000) throw new Error('Content ledger requires editorial maintenance');
  const before = (await read(`dailyContent:status:${month}`)) as {
    attempts?: number;
    paidCalls?: number;
    searchCalls?: number;
  } | null;
  const staging = batchSchema.safeParse(await read(`dailyContent:staging:${month}`));
  const reviewed = await read(`dailyContent:review:${month}`);
  const savedCandidates = (await read(`dailyContent:candidates:${month}`)) as {
    facts?: unknown;
    quotes?: unknown;
  } | null;
  const candidates =
    Array.isArray(savedCandidates?.facts) &&
    Array.isArray(savedCandidates?.quotes) &&
    savedCandidates.facts.length >= monthDays(month) &&
    savedCandidates.quotes.length >= monthDays(month)
      ? savedCandidates
      : null;
  const attempts = before?.attempts ?? 0;
  let paidCalls = before?.paidCalls ?? attempts * 2;
  let searchCalls = before?.searchCalls ?? Math.min(attempts, 3);
  if (!staging.success && !reviewed && paidCalls >= 6)
    throw new Error('Monthly paid attempt cap reached; using reviewed reserve');
  const now = new Date().toISOString();
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(now));
  const startDay = today.slice(0, 7) === month ? Number(today.slice(-2)) + 1 : 1;
  if (startDay > monthDays(month))
    throw new Error('Current month has no remaining days; prepare next month');
  try {
    let batch;
    if (staging.success) {
      if (staging.data.month !== month) throw new Error('Staging month mismatch');
      validatePreparedBatch(staging.data);
      batch = staging.data;
    } else {
      await write(`dailyContent:status:${month}`, {
        month,
        state: 'preparing',
        attempts: attempts + 1,
        paidCalls,
        searchCalls,
        updatedAt: now,
      });
      const preferences = (await read('dailyContent:preferences')) as Record<
        string,
        unknown
      > | null;
      const feedbackList = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${account}/storage/kv/namespaces/${namespace}/keys?prefix=dailyContent%3Afeedback%3A&limit=1000`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) },
      );
      if (!feedbackList.ok) throw new Error('Content feedback unavailable');
      const feedbackKeys = (await feedbackList.json()) as { result?: Array<{ name: string }> };
      const reactions: unknown[] = [];
      const reactionKeys = ['fact', 'quote'].flatMap((kind) =>
        (feedbackKeys.result ?? [])
          .filter((key) => key.name.startsWith(`dailyContent:feedback:${kind}:`))
          .slice(-50),
      );
      for (let i = 0; i < reactionKeys.length; i += 6)
        reactions.push(
          ...(await Promise.all(reactionKeys.slice(i, i + 6).map((key) => read(key.name)))),
        );
      batch = await prepareContent({
        month,
        apiKey,
        model: loadConfig().llm.model,
        now,
        previous,
        preferences: { ...(preferences ?? DEFAULT_CONTENT_PREFERENCES), reactions },
        candidates,
        startDay,
        reviewed,
        reviewCheckpoint: (value) => write(`dailyContent:review:${month}`, value),
        checkpoint: (value) => write(`dailyContent:candidates:${month}`, value),
        respond: async (request) => {
          if (paidCalls >= 6 || (request.search && searchCalls >= 3))
            throw new Error('Monthly paid attempt cap reached; using reviewed reserve');
          paidCalls++;
          if (request.search) searchCalls++;
          await write(`dailyContent:status:${month}`, {
            month,
            state: 'preparing',
            attempts: attempts + 1,
            paidCalls,
            searchCalls,
            updatedAt: new Date().toISOString(),
          });
          return contentResponse(request);
        },
      });
      await write(`dailyContent:staging:${month}`, batch);
    }
    const ledger = new Map(((stored as Candidate[]) ?? []).map((n) => [n.id, n]));
    for (const n of [...batch.facts, ...batch.quotes]) ledger.set(n.id, n);
    await write('dailyContent:ledger', [...ledger.values()]);
    await write(`dailyContent:batch:${month}`, batch);
    await write(`dailyContent:status:${month}`, {
      month,
      state: 'ready',
      attempts: staging.success ? attempts : attempts + 1,
      paidCalls,
      searchCalls,
      updatedAt: now,
      facts: batch.facts.length,
      quotes: batch.quotes.length,
      startDay: batch.startDay ?? 1,
      calendarDays: monthDays(month) - (batch.startDay ?? 1) + 1,
    });
    console.log(
      `Content ${month} ready: ${batch.facts.length} facts, ${batch.quotes.length} quotes. Daily reads cost no provider calls.`,
    );
  } catch (error) {
    await write(`dailyContent:status:${month}`, {
      month,
      state: 'reserve',
      attempts: staging.success ? attempts : attempts + 1,
      paidCalls,
      searchCalls,
      updatedAt: now,
    });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Content preparation failed');
    process.exitCode = 1;
  });
