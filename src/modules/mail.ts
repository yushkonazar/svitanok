// mail (producer, Блок P2c). Gmail тріаж read-only: важливі листи (відповіді
// на заявки, запрошення на співбесіду) -> «N листів про вакансії» у брифінгу.
// Metadata-only fetch (subject+from+snippet, НІКОЛИ format=full/тіло листа) —
// мінімізація приватності. LLM-класифікація (claude -p, plain-text відповідь
// — той самий стиль, що jobs.ts buildScorePrompt/parseScores, БЕЗ json-schema
// на цьому боці). Дедуп проти shownMail. Деградує тихо (§6): без GOOGLE_*
// секретів чи при 401/мережевій помилці -> null, не валить брифінг.
//
// ⚠️ /briefing.json НЕАВТЕНТИФІКОВАНИЙ (web/worker.js, немає owner-check на
// відміну від /api/vote чи /api/event) — Block тут НІКОЛИ не несе
// subject/from/snippet у `data`, лише агрегований лічильник у `summary`.

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import {
  googleCreds,
  googleAccessToken,
  withTimeout,
  type GoogleOAuthCreds,
} from '../core/google-auth.js';

const MAIL_PRIORITY = 56; // після jobs (55), перед mock

type ShownMail = Record<string, string>; // Gmail message id -> ISO дата, коли розглянуто

interface MailCandidate {
  id: string;
  subject: string;
  from: string;
  snippet: string;
}

export interface MailModuleOptions {
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}

/** Українське відмінювання "лист/листи/листів" за числом. */
export function pluralizeLysty(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return 'листів';
  if (mod10 === 1) return 'лист';
  if (mod10 >= 2 && mod10 <= 4) return 'листи';
  return 'листів';
}

export function buildMailPrompt(profile: string, candidates: MailCandidate[]): string {
  return [
    'Ти — асистент, що сортує пошту кандидата на роботу. Профіль кандидата:',
    profile,
    'Для КОЖНОГО листа визнач, чи він ВАЖЛИВИЙ (стосується пошуку роботи: відповідь',
    'на заявку, запрошення на співбесіду, тестове завдання, відмова тощо).',
    'Спам/реклама/розсилки/новини — НЕ важливі.',
    'Листи:',
    ...candidates.map((c, i) => `${i + 1}. Від: ${c.from}\nТема: ${c.subject}\n${c.snippet}`),
    'Поверни ЛИШЕ JSON-масив без прози:',
    '[{"i":1,"important":true}]',
  ].join('\n');
}

/** Розпарсити класифікацію у map index(1-based) -> {important}; малформат -> порожньо. */
export function parseMailClassification(text: string): Map<number, { important: boolean }> {
  const out = new Map<number, { important: boolean }>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return out;
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return out;
    for (const x of arr) {
      if (x && typeof x === 'object') {
        const o = x as Record<string, unknown>;
        const i = typeof o.i === 'number' ? o.i : NaN;
        if (Number.isInteger(i)) out.set(i, { important: o.important === true });
      }
    }
  } catch {
    /* малформат -> порожня map -> 0 важливих (не валимо) */
  }
  return out;
}

export function createMailModule(opts: MailModuleOptions = {}): Module<AppConfig> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 30000;

  async function listMessageIds(
    token: string,
    query: string,
    maxResults: number,
  ): Promise<string[]> {
    const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/messages');
    url.searchParams.set('q', query);
    url.searchParams.set('maxResults', String(maxResults));
    const res = await withTimeout(
      (signal) =>
        fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal }),
      timeoutMs,
    );
    if (!res.ok) throw new Error(`Gmail list HTTP ${res.status}`);
    const json = (await res.json()) as { messages?: { id: string }[] };
    return (json.messages ?? []).map((m) => m.id);
  }

  /** Metadata-only (subject+from+snippet) — НІКОЛИ format=full (без тіла листа). */
  async function fetchCandidate(token: string, id: string): Promise<MailCandidate | null> {
    const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}`);
    url.searchParams.set('format', 'metadata');
    url.searchParams.append('metadataHeaders', 'Subject');
    url.searchParams.append('metadataHeaders', 'From');
    const res = await withTimeout(
      (signal) =>
        fetchImpl(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal }),
      timeoutMs,
    );
    if (!res.ok) return null; // одиничний лист не вдався -> пропустити, не валити весь тріаж
    const json = (await res.json()) as {
      snippet?: string;
      payload?: { headers?: { name: string; value: string }[] };
    };
    const headers = json.payload?.headers ?? [];
    const subject = headers.find((h) => h.name === 'Subject')?.value ?? '(без теми)';
    const from = headers.find((h) => h.name === 'From')?.value ?? '';
    return { id, subject, from, snippet: json.snippet ?? '' };
  }

  return {
    id: 'mail',
    kind: 'producer',
    enabled: (config) => config.modules.mail.enabled,
    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const cfg = ctx.config.modules.mail;
      const c: GoogleOAuthCreds | null = googleCreds(env);
      if (!c) {
        ctx.log.warn('GOOGLE_* секрети відсутні — mail пропущено');
        return null;
      }

      const shown = ctx.state.get<ShownMail>('shownMail') ?? {};
      const cutoff = ctx.clock.now().getTime() - cfg.dedupDays * 86400_000;

      let candidates: MailCandidate[];
      try {
        const token = await googleAccessToken(c, { fetchImpl, timeoutMs });
        const ids = await listMessageIds(token, cfg.query, cfg.maxCandidates);
        const freshIds = ids.filter((id) => {
          const at = shown[id] ? Date.parse(shown[id]!) : 0;
          return !(at && at >= cutoff);
        });
        const settled = await Promise.allSettled(freshIds.map((id) => fetchCandidate(token, id)));
        candidates = settled.flatMap((r) => (r.status === 'fulfilled' && r.value ? [r.value] : []));
      } catch (e) {
        // Деградуємо тихо (§6): не валимо брифінг.
        ctx.log.warn(`mail недоступний: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }

      if (candidates.length === 0) return null;

      let importantCount = 0;
      try {
        const profile = ctx.config.modules.jobs.profile;
        const out = await ctx.llm.complete(buildMailPrompt(profile, candidates), {
          timeoutMs: ctx.config.llm.timeoutMs,
        });
        const classified = parseMailClassification(out);
        importantCount = candidates.filter((_, i) => classified.get(i + 1)?.important).length;
      } catch (e) {
        ctx.log.warn(
          `mail: класифікація не вдалась (0 важливих цього разу): ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      // Дедуп по РОЗГЛЯНУТИХ листах (не лише «важливих») — на відміну від
      // jobs.ts (позначає лише «picked», бо вакансії конкурують за обмежений
      // слот і мають сенс переоцінюватись завтра); лист один раз прочитаний
      // LLM не стає завтра важливішим — повторний розгляд лише витрачає виклик.
      const today = ctx.clock.todayKey();
      const nextShown: ShownMail = { ...shown };
      for (const cand of candidates) nextShown[cand.id] = today;
      ctx.state.set('shownMail', nextShown);

      if (importantCount === 0) return null;

      return {
        id: 'mail',
        title: 'Пошта',
        icon: '📧',
        summary: `${importantCount} ${pluralizeLysty(importantCount)} про вакансії`,
        priority: MAIL_PRIORITY,
      };
    },
  };
}
