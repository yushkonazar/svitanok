// Задача `mail-triage` (07 §7, ADR-027, етап 7 PR-2): ядро само тримає
// звʼязок із Gmail і кладе кандидатів у canonical `state` (StateStoreDO;
// KV лишається сумісним snapshot-ом), звідки їх бере брифінг.
// Після цього GOOGLE_* зникають із GitHub Secrets - Actions більше не має
// доступу до пошти власника взагалі.
//
// МЕЖА, ЯКУ ТУТ ПРОВЕДЕНО (відхилення від букви ADR-027 - названо в
// plan.md). Ядро робить ПЛУМБІНГ тріажу: інкрементальний обхід скриньки,
// фільтр категорій, дедуп, ретенцію й видимий збій. ВИРОК («цей лист про
// вакансії», «це запрошення на співбесіду о 15:00») лишається там, де вже
// живе LLM брифінгу - у claude -p всередині Actions (ADR-026: сам брифінг
// не переїжджає). Перенести ще й вирок означало б завести новий профіль
// мозку і новий канал результату останнім етапом - тобто ризикнути єдиним,
// що власник бачить щоранку, заради архітектурної симетрії.
//
// `mailTriage` і `shownMail` живуть у versioned StateStoreDO. Кожен patch
// змінює лише своє поле, тож конкурентні проходи не затирають один одного.

import { loadState, updateState } from '../../kv-store.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { googleGrantedScopes } from '../../google.mjs';
import { hasFeatureScope } from '../google-scopes.mjs';
import {
  gmailProfileHistoryId,
  gmailHistoryAdded,
  gmailSearchIds,
  gmailMessageMeta,
  googleAccessToken,
} from '../../google.mjs';

/** Ключ у блобі `state`, який читає брифінг (src/modules/mail.ts). */
export const MAIL_TRIAGE_KEY = 'mailTriage';
/** Період задачі (07 §7: 15 хв). Планувальник тікає щопʼять - гейт тут. */
export const MAIL_TRIAGE_PERIOD_MS = 15 * 60_000;
/**
 * Запит холодного старту. ⚠️ ДЗЕРКАЛО `modules.mail.query` з config.yml -
 * парність тримає тест: розійдуться - брифінг судитиме листи, яких ядро
 * ніколи не збирало.
 */
export const MAIL_TRIAGE_QUERY = 'in:inbox newer_than:3d -category:promotions -category:social';
/** Скільки кандидатів тягнемо на холодному старті (= maxCandidates брифінгу). */
export const MAIL_COLD_START_LIMIT = 15;
/**
 * Стеля метаданих за одну появу. Рахунок підзапитів (Workers Free: 50 на
 * ВИКЛИК, і в тому ж виклику планувальник виконує решту прострочених задач):
 * стан 1 + скоупи/токен 1 + історія 1-2 + N листів + запис стану 3. При
 * N = 15 виходить ~21 - лишається запас на сусідні задачі тіка. Токен
 * читається РАЗ на прохід і передається в gmailMessageMeta, інакше кожен лист
 * коштував би вдвічі.
 */
export const MAIL_META_PER_TICK = 15;
/** Скільки живе кандидат: стільки ж, скільки вікно `newer_than:3d`. */
export const MAIL_CANDIDATE_TTL_MS = 3 * 86_400_000;
/** Стеля списку - блоб `state` не має рости від пошти. */
export const MAIL_CANDIDATES_CAP = 60;
/** Скільки збоїв поспіль терпимо мовчки, перш ніж сказати вголос. */
export const MAIL_FAIL_ALERT_AT = 3;
/** Мітки Gmail, які брифінг ніколи не розглядав (`-category:*` у запиті). */
export const SKIP_LABELS = ['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL'];

/**
 * Narrow deterministic attention gate. It intentionally does not interpret a
 * mail's truthfulness, infer a calendar event, or call an LLM: those actions
 * need the normal taint/policy path. The returned reason codes are suitable
 * for an owner-facing explanation without persisting the raw message body.
 * @param {{ subject?: unknown, snippet?: unknown }} candidate
 * @returns {{ level: 'critical' | 'attention', reasons: string[] } | null}
 */
export function classifyMailAttention(candidate) {
  const text =
    `${String(candidate.subject ?? '')}\n${String(candidate.snippet ?? '')}`.toLowerCase();
  /** @type {string[]} */
  const critical = [];
  if (
    /\b(interview|technical\s+task|offer|deadline)\b|співбес|тестов.{0,12}завдан|офер|дедлайн/i.test(
      text,
    )
  ) {
    critical.push('interview_or_deadline');
  }
  if (/\b(today|tomorrow|сьогодні|завтра)\b/i.test(text)) critical.push('time_sensitive');
  if (critical.length) return { level: 'critical', reasons: critical };

  /** @type {string[]} */
  const attention = [];
  if (/\b(application|recruiter|recruitment|vacancy|job)\b|заявк|рекрутер|ваканс/i.test(text)) {
    attention.push('job_signal');
  }
  return attention.length ? { level: 'attention', reasons: attention } : null;
}

/**
 * @typedef {{ id: string, from: string, subject: string, snippet: string, atMs: number,
 *   attention?: { level: 'critical' | 'attention', reasons: string[] } }} MailCandidate
 * @typedef {{ historyId: string | null, lastRunMs: number, fails: number,
 *   alerted: boolean, candidates: MailCandidate[], seen: string[] }} MailTriageState
 */

/**
 * Скільки id тримаємо в «уже розібраних». Потрібне, бо кандидатом стає не
 * кожен лист: промо й соцмережі відсіваються тут, а щось могло випасти за
 * ретенцією. Без цього списку такі листи НАЗАВЖДИ лишались би в «недочитаних»,
 * курсор історії застигав би, і тріаж щочверть години тягнув би ті самі
 * п'ятнадцять листів (регресія, знайдена ревʼю виправлень).
 */
export const MAIL_SEEN_CAP = 300;

/**
 * Нормалізувати cache тріажу. Коли відомий `nowMs`, заодно прибрати старі
 * кандидати: навіть за вимкненого Gmail або серії помилок raw headers/snippet
 * не мають лежати довше нашого триденного вікна.
 * @param {unknown} raw @param {number|null} [nowMs] @returns {MailTriageState}
 */
export function normalizeTriageState(raw, nowMs = null) {
  const o = raw && typeof raw === 'object' && !Array.isArray(raw) ? /** @type {any} */ (raw) : {};
  const cutoff = Number.isFinite(nowMs) ? Number(nowMs) - MAIL_CANDIDATE_TTL_MS : null;
  return {
    historyId: typeof o.historyId === 'string' && o.historyId ? o.historyId : null,
    lastRunMs: Number.isFinite(o.lastRunMs) ? Number(o.lastRunMs) : 0,
    fails: Number.isFinite(o.fails) ? Number(o.fails) : 0,
    alerted: o.alerted === true,
    candidates: Array.isArray(o.candidates)
      ? o.candidates.filter(
          (/** @type {any} */ c) =>
            c &&
            typeof c.id === 'string' &&
            (cutoff == null || (Number.isFinite(c.atMs) && Number(c.atMs) >= cutoff)),
        )
      : [],
    seen: Array.isArray(o.seen)
      ? o.seen.filter((/** @type {unknown} */ id) => typeof id === 'string').slice(0, MAIL_SEEN_CAP)
      : [],
  };
}

/**
 * Злити нових кандидатів зі старими: дедуп за id, геть прострочені й уже
 * розглянуті брифінгом, найновіші зверху, стеля списку.
 * @param {MailCandidate[]} previous
 * @param {MailCandidate[]} fresh
 * @param {{ nowMs: number, shown: Record<string, unknown> }} ctx
 */
export function mergeCandidates(previous, fresh, ctx) {
  /** @type {Map<string, MailCandidate>} */
  const byId = new Map();
  for (const c of [...previous, ...fresh]) {
    // Свіжа копія перемагає стару: у неї актуальніші заголовки.
    byId.set(c.id, c);
  }
  const cutoff = ctx.nowMs - MAIL_CANDIDATE_TTL_MS;
  return [...byId.values()]
    .filter((c) => Number(c.atMs) >= cutoff && !(c.id in ctx.shown))
    .sort((a, b) => Number(b.atMs) - Number(a.atMs))
    .slice(0, MAIL_CANDIDATES_CAP);
}

/**
 * Одна поява задачі. Повертає підсумок для логу/тестів; НІКОЛИ не кидає -
 * планувальник має тікати далі, а про збій дізнається власник із алерту.
 * @param {Env} env
 * @param {number} [nowMs]
 */
export async function mailTriageTask(env, nowMs = Date.now()) {
  const state = normalizeTriageState((await readState(env))[MAIL_TRIAGE_KEY], nowMs);
  if (nowMs - state.lastRunMs < MAIL_TRIAGE_PERIOD_MS) return { skipped: 'period' };
  if (!env.GOOGLE_REFRESH_TOKEN) return { skipped: 'no-google' };
  if (!hasFeatureScope(await googleGrantedScopes(env), 'mail')) {
    // Скоуп зняли (перевидання токена без gmail.readonly) - це не «збій
    // мережі», повторювати нема сенсу, але й мовчати не можна.
    await noteFailure(env, nowMs, 'скоуп gmail.readonly не виданий');
    return { skipped: 'no-scope' };
  }

  const sync = await collectIds(env, state);
  if (!sync.ok) {
    await noteFailure(env, nowMs, sync.reason);
    return { failed: sync.reason };
  }

  // ⚠️ КУРСОР РУХАЄТЬСЯ, ЛИШЕ КОЛИ ВСЕ РОЗІБРАНО (ревʼю етапу 7). Доти
  // historyId записувався завжди, а метадані бралися лише для перших 20 id -
  // тобто при сплеску («тридцять листів за чверть години») решта зникала
  // назавжди: наступна поява питала історію вже ВІД нового курсора.
  const blobNow = await readState(env);
  const shownNow =
    blobNow.shownMail && typeof blobNow.shownMail === 'object' ? blobNow.shownMail : {};
  const known = new Set([
    ...state.candidates.map((c) => c.id),
    ...state.seen,
    ...Object.keys(/** @type {Record<string, unknown>} */ (shownNow)),
  ]);
  const pending = sync.ids.filter((id) => !known.has(id));
  // Найновіші вперед: брифінг бере 15 найсвіжіших, а Gmail віддає історію за
  // зростанням - без цього при сплеску власник бачив би найстаріші листи.
  const batch = pending.slice(-MAIL_META_PER_TICK);

  const token = await googleAccessToken(env);
  /** @type {MailCandidate[]} */
  const fresh = [];
  /** @type {string[]} */
  const seenNow = [];
  let metaFailed = 0;
  for (const id of batch) {
    const meta = await gmailMessageMeta(env, id, token);
    if (!meta) {
      // Транзієнтний збій (429/5xx) - лист НЕ рахуємо розібраним: інакше
      // хвиля rate-limit від Gmail тихо губила б листи назавжди.
      metaFailed += 1;
      continue;
    }
    // Розібраний - навіть якщо кандидатом не став (промо, соцмережі). Саме
    // це не давало курсору застигнути.
    seenNow.push(meta.id);
    if (meta.labels.some((l) => SKIP_LABELS.includes(l))) continue;
    const candidate = {
      id: meta.id,
      from: meta.from,
      subject: meta.subject,
      snippet: meta.snippet,
      atMs: meta.atMs,
    };
    const attention = classifyMailAttention(candidate);
    fresh.push({ ...candidate, ...(attention ? { attention } : {}) });
  }
  // Курсор рухається, лише коли ВСЕ пройдено успішно: недочитані сторінки,
  // залишок понад стелю або жоден збій метаданих - усе лишає стару точку.
  const drained = !sync.truncated && pending.length <= MAIL_META_PER_TICK && metaFailed === 0;
  if (metaFailed > 0 && fresh.length === 0) {
    // Нічого не дістали - це збій, і лічильник має його побачити (інакше
    // алерт після трьох невдач не спрацює ніколи).
    await noteFailure(env, nowMs, `метадані не дістались для ${metaFailed} листів`);
    return { failed: 'meta', metaFailed };
  }

  const store = await updateState(env, (blob) => {
    const prev = normalizeTriageState(blob[MAIL_TRIAGE_KEY], nowMs);
    const shown = blob.shownMail && typeof blob.shownMail === 'object' ? blob.shownMail : {};
    return {
      ...blob,
      [MAIL_TRIAGE_KEY]: {
        // Не дочитали - лишаємо СТАРИЙ курсор: наступна поява перепитає те
        // саме вікно, а дедуп за id не дасть дублів.
        historyId: drained ? sync.historyId : (prev.historyId ?? state.historyId),
        lastRunMs: nowMs,
        fails: 0,
        alerted: false,
        candidates: mergeCandidates(prev.candidates, fresh, { nowMs, shown }),
        seen: [...seenNow, ...prev.seen].slice(0, MAIL_SEEN_CAP),
      },
    };
  });
  const saved = normalizeTriageState(store[MAIL_TRIAGE_KEY], nowMs);
  return {
    added: fresh.length,
    candidates: saved.candidates.length,
    cold: sync.cold,
    // Скільки лишилось на наступну появу: і залишок понад стелю, і те, що не
    // дістало метаданих цього разу.
    pending: pending.length - batch.length + metaFailed,
  };
}

/**
 * Які листи розглядати цієї появи: інкремент від historyId або холодний
 * старт (перший запуск / історія застаріла).
 * @param {Env} env @param {MailTriageState} state
 * @returns {Promise<{ ok: true, ids: string[], historyId: string | null, cold: boolean,
 *   truncated: boolean } | { ok: false, reason: string }>}
 */
async function collectIds(env, state) {
  if (state.historyId) {
    const hist = await gmailHistoryAdded(env, { startHistoryId: state.historyId });
    if (hist.ok) {
      return {
        ok: true,
        ids: hist.ids,
        historyId: hist.historyId,
        cold: false,
        truncated: hist.truncated,
      };
    }
    // 404 - точка відліку застаріла (історія Gmail живе ~тиждень). Це не
    // збій: пересинхронізовуємось пошуком, як на першому запуску.
    if (hist.status !== 404) return { ok: false, reason: `history HTTP ${hist.status}` };
  }
  const [profile, search] = await Promise.all([
    gmailProfileHistoryId(env),
    gmailSearchIds(env, { q: MAIL_TRIAGE_QUERY, limit: MAIL_COLD_START_LIMIT }),
  ]);
  if (!search.ok) return { ok: false, reason: `search HTTP ${search.status}` };
  // historyId не дістався - лишаємо null: наступна поява знову зробить
  // холодний старт. Записати сюди здогад означало б тихо пропустити листи.
  return {
    ok: true,
    ids: search.ids,
    historyId: profile.ok ? profile.historyId : null,
    cold: true,
    // Холодний старт бере рівно maxCandidates найсвіжіших - «недочитаного»
    // тут не буває за визначенням.
    truncated: false,
  };
}

/**
 * Порахувати збій і сказати вголос на третьому поспіль. Тиша на перших двох -
 * свідома: мережа Gmail блимає, а алерт кожні 15 хв власник вимкне вже на
 * другий день, і тоді справжній збій теж пройде повз.
 * @param {Env} env @param {number} nowMs @param {string} reason
 */
async function noteFailure(env, nowMs, reason) {
  let shouldAlert = false;
  await updateState(env, (blob) => {
    const prev = normalizeTriageState(blob[MAIL_TRIAGE_KEY], nowMs);
    const fails = prev.fails + 1;
    shouldAlert = fails >= MAIL_FAIL_ALERT_AT && !prev.alerted;
    return {
      ...blob,
      [MAIL_TRIAGE_KEY]: {
        ...prev,
        lastRunMs: nowMs,
        fails,
        alerted: prev.alerted || shouldAlert,
      },
    };
  });
  console.error(`mail-triage: ${reason}`);
  if (shouldAlert) {
    await sendSystemAlert(
      env,
      `Тріаж пошти не працює ${MAIL_FAIL_ALERT_AT} появи поспіль: ${reason}. Брифінг лишиться без блоку «Пошта».`,
      nowMs,
    );
  }
}

/** @param {Env} env @returns {Promise<Record<string, unknown>>} */
async function readState(env) {
  return loadState(env);
}
