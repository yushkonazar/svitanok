// mail (producer, Блок P2c). Gmail тріаж read-only: важливі листи (відповіді
// на заявки, запрошення на співбесіду) -> «N листів про вакансії» у брифінгу.
// Metadata-only fetch (subject+from+snippet, НІКОЛИ format=full/тіло листа) —
// мінімізація приватності. LLM-класифікація (claude -p, plain-text відповідь
// — той самий стиль, що jobs.ts buildScorePrompt/parseScores, БЕЗ json-schema
// на цьому боці). Дедуп проти shownMail. Деградує тихо (§6): без GOOGLE_*
// секретів чи при 401/мережевій помилці -> null, не валить брифінг.
//
// /briefing.json тепер під owner-auth (H1, web/worker.js checkOwnerRead), але
// Block тут ВСЕ ОДНО не несе subject/from/snippet у `data`, лише агрегований
// лічильник у `summary` — захист углиб (менше приватного в KV-історії брифінгів).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
import {
  googleCreds,
  googleAccessToken,
  withTimeout,
  type GoogleOAuthCreds,
} from '../core/google-auth.js';
import { kyivLocalToUtcMs } from '../core/tz.js';
import { escapeHtml } from '../core/telegram.js';

const MAIL_PRIORITY = 56; // після jobs (55), перед mock
const MAX_PROPOSAL_ITEMS = 5;
const PROPOSAL_MAX_FUTURE_DAYS = 60;

// Bus-ключ для детектованих запрошень на співбесіду (Блок P2c) — consume у
// runBriefing() (src/orchestrator.ts), НЕ з середини цього модуля: Ctx
// навмисно не має notifier, усе відправлення централізоване.
export const MAIL_PROPOSAL_BUS_KEY = 'mail.interviewProposal';

export interface MailProposalItem {
  kind: 'event';
  title: string;
  whenMs: number;
  durationMin: number;
  from: string; // відправник листа — показуємо у пропозиції (захист від спуфнутих «запрошень», M4)
}

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

export interface MailClassification {
  important: boolean;
  interview: boolean;
  dateISO?: string;
  time?: string;
  title?: string;
}

export function buildMailPrompt(profile: string, candidates: MailCandidate[]): string {
  return [
    'Ти — асистент, що сортує пошту кандидата на роботу. Профіль кандидата:',
    profile,
    'Для КОЖНОГО листа визнач:',
    '- important: чи він ВАЖЛИВИЙ (стосується пошуку роботи: відповідь на заявку,',
    '  запрошення на співбесіду, тестове завдання, відмова тощо). Спам/реклама/',
    '  розсилки/новини — НЕ важливі.',
    '- interview: чи це КОНКРЕТНЕ запрошення на співбесіду з датою й часом.',
    '  Якщо так — додай dateISO ("YYYY-MM-DD"), time ("HH:MM", 24-годинний,',
    '  КИЇВСЬКИЙ час) і коротке title (напр. "Співбесіда — Назва компанії").',
    '  Не вгадуй дату/час, якщо їх немає в листі явно — тоді interview:false.',
    'Листи:',
    ...candidates.map((c, i) => `${i + 1}. Від: ${c.from}\nТема: ${c.subject}\n${c.snippet}`),
    'Поверни ЛИШЕ JSON-масив без прози:',
    '[{"i":1,"important":true,"interview":true,"dateISO":"2026-07-14","time":"15:00",' +
      '"title":"Співбесіда — Acme"}]',
  ].join('\n');
}

/** Розпарсити класифікацію у map index(1-based) -> MailClassification; малформат -> порожньо. */
export function parseMailClassification(text: string): Map<number, MailClassification> {
  const out = new Map<number, MailClassification>();
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
        if (Number.isInteger(i)) {
          out.set(i, {
            important: o.important === true,
            interview: o.interview === true,
            dateISO: typeof o.dateISO === 'string' ? o.dateISO : undefined,
            time: typeof o.time === 'string' ? o.time : undefined,
            title: typeof o.title === 'string' ? o.title.trim() : undefined,
          });
        }
      }
    }
  } catch {
    /* малформат -> порожня map -> 0 важливих (не валимо) */
  }
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/**
 * Календарна валідність (не лише формат) — Date.parse/Date.UTC МОВЧКИ
 * "перекочують" неіснуючі дати (напр. 2026-02-30 -> 2026-03-02), тож самого
 * DATE_RE недостатньо: перевіряємо round-trip через компоненти.
 */
function isValidCalendarDate(dateISO: string): boolean {
  if (!DATE_RE.test(dateISO)) return false;
  const [y, m, d] = dateISO.split('-').map(Number) as [number, number, number];
  const asDate = new Date(Date.UTC(y, m - 1, d));
  return (
    asDate.getUTCFullYear() === y && asDate.getUTCMonth() === m - 1 && asDate.getUTCDate() === d
  );
}

/**
 * Санітарна перевірка dateISO+time від LLM -> whenMs, або null (галюцинація,
 * малий формат, неіснуюча дата, поза розумним діапазоном). LLM НІКОЛИ сам не
 * рахує фінальний час (той самий інваріант, що P2a/P2b) — лише дає
 * структуровані dateISO+time, конвертацію в UTC робить kyivLocalToUtcMs
 * (DST-aware, детерміновано).
 */
export function sanitizeInterviewWhen(
  dateISO: string | undefined,
  time: string | undefined,
  nowMs: number,
): number | null {
  if (!dateISO || !time || !isValidCalendarDate(dateISO) || !TIME_RE.test(time)) return null;
  const [hh, mm] = time.split(':').map(Number);
  if (hh === undefined || mm === undefined || hh > 23 || mm > 59) return null;
  const whenMs = kyivLocalToUtcMs(dateISO, hh, mm);
  if (!Number.isFinite(whenMs)) return null;
  const minMs = nowMs - 3600_000; // трохи запасу в минуле (годинні пояси/затримка)
  const maxMs = nowMs + PROPOSAL_MAX_FUTURE_DAYS * 86400_000;
  if (whenMs < minMs || whenMs > maxMs) return null;
  return whenMs;
}

/** Telegram-текст пропозиції (HTML, ескейпнуті назви) — над кнопками ✅/❌ (orchestrator.ts). */
export function formatMailProposalMessage(items: MailProposalItem[]): string {
  const lines = ['📧 <b>Знайшов запрошення на співбесіду:</b>', ''];
  const fmt = new Intl.DateTimeFormat('uk-UA', {
    timeZone: 'Europe/Kyiv',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  items.forEach((it, i) => {
    lines.push(`${i + 1}. 📅 ${escapeHtml(it.title)} — ${fmt.format(new Date(it.whenMs))}`);
    // Від кого — щоб не сплутати спуфнуте «запрошення» зі справжнім (M4).
    if (it.from) lines.push(`   <i>від ${escapeHtml(it.from)}</i>`);
  });
  return lines.join('\n');
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

      // Присвоюється в try; при throw -> catch return (нижче не читається).
      let importantCount: number;
      try {
        const profile = ctx.config.modules.jobs.profile;
        const out = await ctx.llm.complete(buildMailPrompt(profile, candidates), {
          timeoutMs: ctx.config.llm.timeoutMs,
        });
        const classified = parseMailClassification(out);
        importantCount = candidates.filter((_, i) => classified.get(i + 1)?.important).length;

        const nowMs = ctx.clock.now().getTime();
        const proposalItems: MailProposalItem[] = [];
        candidates.forEach((cand, i) => {
          const cls = classified.get(i + 1);
          if (!cls?.interview || !cls.title) return;
          const whenMs = sanitizeInterviewWhen(cls.dateISO, cls.time, nowMs);
          if (whenMs === null) return;
          proposalItems.push({
            kind: 'event',
            title: cls.title,
            whenMs,
            durationMin: 60,
            from: cand.from,
          });
        });
        if (proposalItems.length > 0) {
          ctx.bus.set(MAIL_PROPOSAL_BUS_KEY, {
            items: proposalItems.slice(0, MAX_PROPOSAL_ITEMS),
          });
        }

        // Дедуп по РОЗГЛЯНУТИХ листах — ЛИШЕ якщо LLM реально відповів (навіть
        // малформед: повторний розгляд не допоможе). При ЗБОЇ виклику (throw
        // нижче: таймаут/мережа) НЕ позначаємо — інакше лист випав би з вікна
        // query (newer_than) і був би втрачений назавжди через одну помилку.
        // На відміну від jobs.ts (позначає лише «picked») лист, раз прочитаний
        // LLM, не стає завтра важливішим — повторний розгляд лише палить виклик.
        const today = ctx.clock.todayKey();
        const nextShown: ShownMail = { ...shown };
        for (const cand of candidates) nextShown[cand.id] = today;
        ctx.state.set('shownMail', nextShown);
      } catch (e) {
        // Класифікація впала -> НЕ позначаємо shownMail: листи розглянуться
        // знову наступного рану (не втрачаємо через транзієнтну LLM-помилку).
        ctx.log.warn(
          `mail: класифікація не вдалась (ретрай наступного разу): ${e instanceof Error ? e.message : String(e)}`,
        );
        return null;
      }

      if (importantCount === 0) return null;

      return {
        id: 'mail',
        title: 'Пошта',
        icon: '📧',
        summary: `${importantCount} ${pluralizeLysty(importantCount)} про вакансії`,
        // Число окремо (Фаза B3, щоденний рядок) — щоб не парсити summary-текст.
        data: { count: importantCount },
        priority: MAIL_PRIORITY,
      };
    },
  };
}
