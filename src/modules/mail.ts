// mail (producer, Блок P2c). «N листів про вакансії» у брифінгу.
//
// ⚠️ GMAIL ТУТ БІЛЬШЕ НЕМАЄ (ADR-027, етап 7 редизайну). Листи збирає ядро
// (задача mail-triage кожні 15 хв) і кладе метадані в KV `state.mailTriage`;
// цей модуль лише читає готових кандидатів і виносить вирок LLM. Причина -
// не краса: доки брифінг ходив у Gmail сам, у GitHub Secrets мусив лежати
// GOOGLE_REFRESH_TOKEN, тобто повний доступ до пошти власника мав ще й
// раннер Actions. Тепер токен живе в одному місці - у Cloudflare.
//
// Немає ключа `mailTriage` -> null із попередженням (той самий тихий шлях,
// що раніше при відсутніх GOOGLE_*): брифінг не валиться, а про мовчання
// тріажу власнику каже саме ядро (алерт після трьох невдалих появ).
//
// /briefing.json тепер під owner-auth (H1, web/worker.js checkOwnerRead), але
// Block тут ВСЕ ОДНО не несе subject/from/snippet у `data`, лише агрегований
// лічильник у `summary` — захист углиб (менше приватного в KV-історії брифінгів).

import type { Module, Block, Ctx } from '../core/types.js';
import type { AppConfig } from '../core/config.js';
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

/** Ключ у блобі `state`, який пише ядро (web/core/brief/mail-triage.mjs). */
export const MAIL_TRIAGE_KEY = 'mailTriage';

/** Форма того ключа - рівно те, що читає цей модуль. */
export interface MailTriageState {
  candidates?: { id: string; from?: string; subject?: string; snippet?: string; atMs?: number }[];
  lastRunMs?: number;
  historyId?: string | null;
}

interface MailCandidate {
  id: string;
  subject: string;
  from: string;
  snippet: string;
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
/**
 * Розібрати класифікацію листів.
 *
 * `null` -> LLM НЕ ВІДПОВІЛА структуровано (немає масиву / битий JSON). Це НЕ те
 * саме, що валідний порожній `[]` («переглянув, важливого немає»), і плутати їх
 * не можна: порожня Map в обох випадках означала б «0 важливих», після чого
 * листи позначались прочитаними — і зникали назавжди. Виклик мусить бачити
 * різницю: `[]` — це відповідь, малформат — це збій.
 */
export function parseMailClassification(text: string): Map<number, MailClassification> | null {
  const out = new Map<number, MailClassification>();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const arr: unknown = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(arr)) return null;
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
    return null; // битий JSON — це збій, а не «важливого немає»
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

export function createMailModule(): Module<AppConfig> {
  return {
    id: 'mail',
    kind: 'producer',
    enabled: (config) => config.modules.mail.enabled,
    async run(ctx: Ctx<AppConfig>): Promise<Block | null> {
      const cfg = ctx.config.modules.mail;
      const shown = ctx.state.get<ShownMail>('shownMail') ?? {};
      const cutoff = ctx.clock.now().getTime() - cfg.dedupDays * 86400_000;

      // Кандидатів збирає ЯДРО (задача mail-triage, ADR-027): у брифінгу
      // більше немає GOOGLE_*-секретів, тож і Gmail він не питає. Тут
      // лишається рівно те, чого в ядрі немає, - вирок LLM.
      const triage = ctx.state.get<MailTriageState>(MAIL_TRIAGE_KEY);
      if (!triage) {
        ctx.log.warn('mailTriage у стані немає — тріаж пошти в ядрі ще не робив прогону');
        return null;
      }
      const candidates: MailCandidate[] = (triage.candidates ?? [])
        .filter((c) => {
          const at = shown[c.id] ? Date.parse(shown[c.id]!) : 0;
          return !(at && at >= cutoff);
        })
        .slice(0, cfg.maxCandidates)
        .map((c) => ({
          id: c.id,
          subject: c.subject || '(без теми)',
          from: c.from ?? '',
          snippet: c.snippet ?? '',
        }));

      if (candidates.length === 0) return null;

      // Присвоюється в try; при throw -> catch return (нижче не читається).
      let importantCount: number;
      try {
        const profile = ctx.config.modules.jobs.profile;
        const out = await ctx.llm.complete(buildMailPrompt(profile, candidates), {
          timeoutMs: ctx.config.llm.timeoutMs,
          tag: 'mail',
        });
        const classified = parseMailClassification(out);
        // Малформат -> у catch (нижче): НЕ позначаємо прочитаними й логуємо.
        // Доти порожня Map тут читалась як «0 важливих», листи тихо ставали
        // розглянутими й випадали з вікна query назавжди — навіть якщо насправді
        // LLM просто нічого не відповіла.
        if (classified === null) {
          throw new Error(`відповідь не розпарсилась (${out.slice(0, 120) || 'порожньо'})`);
        }
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

        // Дедуп по РОЗГЛЯНУТИХ листах — лише коли LLM справді класифікувала
        // (валідний масив, хай і порожній). Раз прочитаний лист завтра не стане
        // важливішим, тож повторний розгляд лише палив би виклик.
        //
        // ⚠️ А от «LLM щось повернула» ≠ «LLM класифікувала». Доти тут стояло
        // «навіть малформед: повторний розгляд не допоможе» — і це міркування
        // хибне рівно в найімовірнішому випадку: вичерпаний ліміт підписки
        // повертає ЛЮДСЬКИЙ ТЕКСТ з exit 0 (див. llm.ts), тобто не throw. Він
        // не парсився -> «0 важливих» -> усі листи позначались прочитаними ->
        // запрошення на співбесіду зникало назавжди (dedupDays=3, а далі й сам
        // Gmail-запит newer_than:3d його вже не віддасть), і власник не бачив
        // ані блоку «Пошта», ані попередження. Завтра ліміт відпускає — розгляд
        // ЩЕ ЯК допоміг би. Тепер обидва випадки (ліміт і малформат) ідуть у
        // catch: без позначки, з логом, з ретраєм наступного рану.
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
