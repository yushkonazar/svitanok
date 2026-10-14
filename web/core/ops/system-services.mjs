import { cachedGoogleAudit } from '../google-scopes.mjs';
import { loadSettings } from '../../kv-store.mjs';
import { NEWS_SNAPSHOT_KEY } from '../brief/news-snapshot.mjs';
import { NEWS_FEEDS } from '../brief/news-catalog.mjs';
import { PUBLIC_LEISURE_SOURCES } from '../leisure/catalog.mjs';
/** @param {unknown} value */
function date(value) {
  const ms =
    typeof value === 'number' && value > 0
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
/** @param {Env} env @param {string} key */
async function kv(env, key) {
  const raw = await env.BRIEFING.get(key);
  return raw ? JSON.parse(raw) : null;
}
/** @param {Env} env @param {string} key */
async function fact(env, key) {
  if (!env.DB) throw new Error('storage');
  const row = await env.DB.prepare(
    "SELECT value_json,updated_at FROM facts WHERE kind='setting' AND key=?",
  )
    .bind(key)
    .first();
  return row ? { ...JSON.parse(String(row.value_json)), storedAt: row.updated_at } : null;
}
/** @param {string|null} checkedAt @param {number} nowMs @param {number} freshMs */
function freshness(checkedAt, nowMs, freshMs) {
  return !checkedAt ? 'unknown' : nowMs - Date.parse(checkedAt) > freshMs ? 'stale' : 'observed';
}
/** Cached operational metadata only. No provider probe, model call or account payload.
 * @param {Env} env @param {number} nowMs */
export async function readSystemServices(env, nowMs) {
  const readers = [
    {
      id: 'mono',
      title: 'Monobank',
      href: '/finance',
      read: async () => {
        if (!env.MONO_TOKEN)
          return {
            state: 'not-configured',
            detail: 'Підключи Monobank у налаштуваннях.',
            checkedAt: null,
          };
        const job = await fact(env, 'mono_bank_refresh');
        const checkedAt = date(job?.completedAt ?? job?.balanceUpdatedAt);
        return {
          state: job?.active ? 'running' : freshness(checkedAt, nowMs, 86400000),
          checkedAt,
          detail: job?.active
            ? `Оновлення триває: ${Number(job.done ?? 0)} із ${Number(job.total ?? 0)} кроків.`
            : checkedAt
              ? 'Час останнього записаного оновлення. Актуальність балансу й виписки перевіряй окремо.'
              : 'Ще немає метаданих ручного оновлення; це не доказ відсутності банківських операцій.',
          metrics: [
            { label: 'Баланс оновлено', value: date(job?.balanceUpdatedAt) ?? 'Немає даних' },
          ],
        };
      },
    },
    {
      id: 'news',
      title: 'Новини й переклад',
      href: '/news',
      read: async () => {
        const settings = await loadSettings(env);
        if (settings.modules?.news === false)
          return { state: 'off', detail: 'Новини вимкнені в налаштуваннях.', checkedAt: null };
        const snapshot = await kv(env, NEWS_SNAPSHOT_KEY);
        const checkedAt = date(snapshot?.generatedAt);
        const enabled = Array.isArray(snapshot?.sources)
          ? snapshot.sources.filter((/** @type {any} */ s) => s.enabled !== false)
          : [];
        const failed = enabled.filter((/** @type {any} */ s) => s.ok === false);
        const partial = failed.length > 0;
        const sources = enabled.map((/** @type {any} */ s) => ({
          label: NEWS_FEEDS.find((f) => f.name === s.name)?.name ?? 'Джерело',
          state: s.ok === false ? 'unavailable' : s.state === 'empty' ? 'empty' : 'observed',
          checkedAt: date(snapshot?.attemptedAt),
          count: Number(s.count ?? 0),
        }));
        return {
          state: partial
            ? 'degraded'
            : freshness(checkedAt, nowMs, Number(snapshot?.intervalHours ?? 3) * 3600000 + 3600000),
          checkedAt,
          detail: partial
            ? `${failed.length} із ${enabled.length} джерел недоступні. Збережена добірка залишається доступною.`
            : checkedAt
              ? 'Остання успішно сформована добірка; доступність джерел перевіряється під час її оновлення.'
              : 'Добірка ще не записана.',
          sources,
        };
      },
    },
    {
      id: 'leisure',
      title: 'Дозвілля',
      href: '/leisure',
      read: async () => {
        if (!env.DB) throw new Error('storage');
        const [row, jobRow] = await Promise.all([
          env.DB.prepare('SELECT data_json FROM leisure_editions ORDER BY week DESC LIMIT 1')
            .bind()
            .first(),
          env.DB.prepare("SELECT data_json FROM leisure_records WHERE id='catalog-job'")
            .bind()
            .first(),
        ]);
        const edition = row ? JSON.parse(String(row.data_json)) : null;
        const job = jobRow ? JSON.parse(String(jobRow.data_json)) : null;
        const checkedAt = date(edition?.createdAt);
        const sources = (Array.isArray(edition?.sources) ? edition.sources : []).map(
          (/** @type {any} */ s) => ({
            label: PUBLIC_LEISURE_SOURCES.find((source) => source.id === s.id)?.name ?? 'Джерело',
            state: ['ok', 'empty', 'unavailable'].includes(s.status) ? s.status : 'unknown',
            checkedAt: date(s.checkedAt),
            count: Number(s.count ?? 0),
          }),
        );
        const failed = sources.filter((/** @type {any} */ s) => s.state === 'unavailable').length;
        return {
          state: job?.active
            ? 'running'
            : failed
              ? 'degraded'
              : freshness(checkedAt, nowMs, 8 * 86400000),
          checkedAt,
          detail: job?.active
            ? `Оновлення каталогу: ${Number(job.done ?? 0)} із ${Number(job.total ?? 0)} кроків.`
            : failed
              ? `${failed} джерел недоступні. Добірка може бути неповною.`
              : 'Каталог і список рекомендацій використовують спільні записи.',
          sources,
        };
      },
    },
    {
      id: 'memory',
      title: 'Пам’ять асистента',
      href: '/memory',
      read: async () => {
        if (!env.DB) throw new Error('storage');
        const row = /** @type {any} */ (
          await env.DB.prepare(
            `SELECT COUNT(CASE WHEN status IN ('pending','indexed') THEN 1 END) AS pending, COUNT(CASE WHEN status='failed' THEN 1 END) AS failed, MAX(ready_at) AS readyAt FROM memory_projection_versions current
             WHERE current.status<>'retired' AND NOT EXISTS(SELECT 1 FROM memory_projection_versions newer WHERE newer.thread_id=current.thread_id AND newer.created_at>current.created_at AND newer.status<>'retired')`,
          )
            .bind()
            .first()
        );
        const pending = Number(row?.pending ?? 0),
          failed = Number(row?.failed ?? 0);
        return {
          state: failed ? 'degraded' : pending ? 'running' : row?.readyAt ? 'observed' : 'empty',
          checkedAt: date(row?.readyAt),
          detail: failed
            ? 'Частина записів очікує відновлення індексації; вихідні записи залишаються в базі.'
            : pending
              ? 'Триває індексація пам’яті.'
              : 'Технічний стан індексації. Правильність фактів перевіряй у каталозі пам’яті.',
          metrics: [
            { label: 'Очікує індексації', value: String(pending) },
            { label: 'Збоїв індексації', value: String(failed) },
          ],
        };
      },
    },
    {
      id: 'calendar',
      title: 'Календар Google',
      href: '/settings',
      read: async () => {
        const access = await cachedGoogleAudit(env, nowMs);
        const configured = access.configured;
        const read = access.verified ? access.features.calendar_read : null;
        const write = access.verified ? access.features.calendar : null;
        return {
          state: !configured
            ? 'not-configured'
            : !access.verified
              ? 'unknown'
              : !read
                ? 'access'
                : 'configured',
          checkedAt: access.checkedAt,
          detail: !configured
            ? 'Потрібне підключення Google.'
            : !access.verified
              ? 'Доступ налаштовано, але кешовані права ще не підтверджені.'
              : 'Наявні права перевірено за кешем; жива доступність API не перевірялася.',
          metrics: [
            {
              label: 'Читання календаря',
              value: read == null ? 'Невідомо' : read ? 'Дозволено' : 'Немає доступу',
            },
            {
              label: 'Запис у календар',
              value: write == null ? 'Невідомо' : write ? 'Дозволено' : 'Немає доступу',
            },
          ],
        };
      },
    },
    {
      id: 'backup',
      title: 'Резервна копія',
      href: '/system',
      read: async () => {
        const saved = await fact(env, 'last_backup');
        const state = await kv(env, 'backupState');
        const checkedAt = date(saved?.storedAt);
        const blocked = state?.blocked && (!saved?.date || state.date >= saved.date);
        return {
          state: blocked ? 'degraded' : freshness(checkedAt, nowMs, 8 * 86400000),
          checkedAt,
          detail: blocked
            ? 'Остання спроба резервування потребує перевірки.'
            : saved
              ? 'Записана успішна копія. Дата не підтверджує перевірку відновлення.'
              : 'Ще немає підтвердження успішного резервування.',
          metrics: [
            {
              label: 'Дата копії',
              value:
                typeof saved?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.date)
                  ? saved.date
                  : 'Немає даних',
            },
            { label: 'Перевірка відновлення', value: 'Немає підтвердженої дати' },
          ],
        };
      },
    },
  ];
  return Promise.all(
    readers.map(async ({ id, title, href, read }) => {
      try {
        return { id, title, href, available: true, ...(await read()) };
      } catch {
        return {
          id,
          title,
          href,
          available: false,
          state: 'unavailable',
          detail: 'Не вдалося прочитати метадані. Інші функції можуть працювати.',
          checkedAt: null,
        };
      }
    }),
  );
}
