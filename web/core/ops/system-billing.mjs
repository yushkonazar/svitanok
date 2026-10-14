import { validDate } from './system-period.mjs';
/** No billing request runs while opening the page. Dedicated credentials and
 * explicit manual mode are required; generation/OAuth keys are never reused. */
export const BILLING_GUIDES = [
  {
    provider: 'openai',
    title: 'OpenAI',
    supported: true,
    url: 'https://developers.openai.com/api/docs/guides/admin-apis',
    steps: [
      'Виділи проєкт Світанку, щоб рахунок не містив інші застосунки.',
      'Додай OPENAI_BILLING_ADMIN_KEY і OPENAI_BILLING_PROJECT_ID у серверні секрети.',
      'Після погодження доступу встанови SYSTEM_BILLING_MODE=manual. Баланс передплати цим API не визначається.',
    ],
  },
  {
    provider: 'deepgram',
    title: 'Deepgram',
    supported: true,
    url: 'https://developers.deepgram.com/reference/manage/billing/list',
    steps: [
      'Обери проєкт Світанку й окремий ключ із доступом до білінгу.',
      'Додай DEEPGRAM_BILLING_API_KEY та DEEPGRAM_BILLING_PROJECT_ID у серверні секрети.',
      'Після погодження доступу встанови SYSTEM_BILLING_MODE=manual.',
    ],
  },
  {
    provider: 'claude',
    title: 'Claude',
    supported: false,
    url: 'https://platform.claude.com/docs/en/manage-claude/usage-cost-api',
    steps: [
      'Спершу уточни спосіб оплати: Claude Console API чи підписка.',
      'Організаційний білінг і підписка потребують різних можливостей доступу.',
      'API-еквівалент SDK залишається окремим показником. Автоматичного читання рахунку в цій версії немає.',
    ],
  },
  {
    provider: 'google',
    title: 'Google',
    supported: false,
    url: 'https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery',
    steps: [
      'За потреби погодь експорт Cloud Billing у BigQuery.',
      'Потрібні окремі права читання набору даних; запити та зберігання можуть оплачуватися.',
      'Лічильники Maps не є рахунком. Конектор експорту підключається окремо.',
    ],
  },
  {
    provider: 'cloudflare',
    title: 'Cloudflare і сервер',
    supported: false,
    url: 'https://developers.cloudflare.com/analytics/graphql-api/getting-started/authentication/api-token-auth/',
    steps: [
      'Для аналітики підготуй токен Account Analytics → Read.',
      'Аналітика ресурсів не є повним рахунком Cloudflare.',
      'Оплату сервера та фіксовані підписки потрібно обліковувати окремо; конектор поки не підключено.',
    ],
  },
];
/** @param {Env} env @param {string} provider */
function configured(env, provider) {
  return (
    env.SYSTEM_BILLING_MODE === 'manual' &&
    (provider === 'openai'
      ? Boolean(env.OPENAI_BILLING_ADMIN_KEY && env.OPENAI_BILLING_PROJECT_ID)
      : provider === 'deepgram'
        ? Boolean(env.DEEPGRAM_BILLING_API_KEY && env.DEEPGRAM_BILLING_PROJECT_ID)
        : false)
  );
}
/** @param {string} provider @param {{from:string,to:string}} period */
function key(provider, period) {
  return `${provider}:${period.from}:${period.to}`;
}
/** @param {Env} env @param {{from:string,to:string}} period */
export async function readSystemBilling(env, period) {
  const items = await Promise.all(
    BILLING_GUIDES.map(async (guide) => {
      let row = null;
      try {
        row = env.DB
          ? await env.DB.prepare(
              'SELECT snapshot_json,collected_at,error_class,attempted_at FROM system_billing_snapshots WHERE id=?',
            )
              .bind(key(guide.provider, period))
              .first()
          : null;
      } catch {
        /* No schema yet: setup stays usable. */
      }
      const snapshot = safeSnapshot(row?.snapshot_json);
      return {
        ...guide,
        configured: configured(env, guide.provider),
        snapshot,
        errorClass: [
          'access',
          'quota',
          'provider',
          'format',
          'scope',
          'incomplete',
          'network',
        ].includes(String(row?.error_class))
          ? String(row?.error_class)
          : null,
        attemptedAt: row?.attempted_at ?? null,
      };
    }),
  );
  return { connected: items.some((i) => i.snapshot != null), balance: null, items };
}
/** @param {unknown} raw */
function safeSnapshot(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : null;
    if (
      !value ||
      typeof value.costUsd !== 'number' ||
      !Number.isFinite(value.costUsd) ||
      value.currency !== 'USD' ||
      !validDate(value.from) ||
      !validDate(value.to) ||
      !Number.isFinite(Date.parse(value.collectedAt)) ||
      !(
        value.balanceUsd === null ||
        (typeof value.balanceUsd === 'number' && Number.isFinite(value.balanceUsd))
      )
    )
      return null;
    return {
      costUsd: value.costUsd,
      balanceUsd: value.balanceUsd,
      currency: 'USD',
      timeZone: value.timeZone === 'Europe/Kyiv' ? 'Europe/Kyiv' : 'provider',
      from: value.from,
      to: value.to,
      basis: 'provider-reported',
      provisional: true,
      collectedAt: new Date(value.collectedAt).toISOString(),
    };
  } catch {
    return null;
  }
}
/** @param {string} url @param {string} authorization @param {typeof fetch} fetchImpl */
async function requestJson(url, authorization, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { authorization },
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'access'
        : response.status === 429
          ? 'quota'
          : 'provider',
    );
  return /** @type {Record<string, any>} */ (await response.json());
}
/** @param {unknown} value */
function amount(value) {
  const n =
    typeof value === 'number' || (typeof value === 'string' && /^-?\d+(\.\d+)?$/.test(value))
      ? Number(value)
      : NaN;
  if (!Number.isFinite(n)) throw new Error('format');
  return n;
}
/** @param {Env} env @param {{from:string,to:string,since:string,until:string}} period @param {typeof fetch} fetchImpl */
export async function fetchOpenAiBilling(env, period, fetchImpl) {
  const url = new URL('https://api.openai.com/v1/organization/costs');
  url.searchParams.set('start_time', String(Date.parse(period.since) / 1000));
  url.searchParams.set(
    'end_time',
    String(Math.floor(Math.min(Date.now(), Date.parse(period.until)) / 1000)),
  );
  url.searchParams.set('project_ids', String(env.OPENAI_BILLING_PROJECT_ID));
  url.searchParams.set('group_by', 'project_id');
  url.searchParams.set('limit', '180');
  let nano = 0,
    pages = 0;
  const seen = new Set();
  while (true) {
    const body = await requestJson(
      url.toString(),
      `Bearer ${env.OPENAI_BILLING_ADMIN_KEY}`,
      fetchImpl,
    );
    if (!Array.isArray(body.data)) throw new Error('format');
    for (const bucket of body.data) {
      if (!Array.isArray(bucket.results)) throw new Error('format');
      for (const result of bucket.results) {
        if (
          result.project_id !== env.OPENAI_BILLING_PROJECT_ID ||
          String(result.amount?.currency).toLowerCase() !== 'usd'
        )
          throw new Error('scope');
        nano += Math.round(amount(result.amount.value) * 1e9);
      }
    }
    if (!body.has_more) break;
    if (
      typeof body.next_page !== 'string' ||
      !body.next_page ||
      seen.has(body.next_page) ||
      ++pages >= 8
    )
      throw new Error('incomplete');
    seen.add(body.next_page);
    url.searchParams.set('page', body.next_page);
  }
  return {
    costUsd: nano / 1e9,
    balanceUsd: null,
    currency: 'USD',
    timeZone: 'Europe/Kyiv',
    from: period.from,
    to: period.to,
    basis: 'provider-reported',
    provisional: true,
  };
}
/** Deepgram accepts dates, not exact Kyiv instants; do not assume its timezone.
 * @param {Env} env @param {{from:string,to:string}} period @param {typeof fetch} fetchImpl */
export async function fetchDeepgramBilling(env, period, fetchImpl) {
  const project = String(env.DEEPGRAM_BILLING_PROJECT_ID);
  if (!/^[A-Za-z0-9-]{1,100}$/.test(project)) throw new Error('scope');
  const base = `https://api.deepgram.com/v1/projects/${project}`;
  const url = new URL(`${base}/billing/breakdown`);
  url.searchParams.set('start', period.from);
  url.searchParams.set('end', period.to);
  const [cost, balances] = await Promise.all([
    requestJson(url.toString(), `Token ${env.DEEPGRAM_BILLING_API_KEY}`, fetchImpl),
    requestJson(`${base}/balances`, `Token ${env.DEEPGRAM_BILLING_API_KEY}`, fetchImpl),
  ]);
  if (!Array.isArray(cost.results) || !Array.isArray(balances.balances)) throw new Error('format');
  if (cost.start !== period.from || cost.end !== period.to) throw new Error('scope');
  const usdBalances = balances.balances.filter((b) => String(b.units).toUpperCase() === 'USD');
  return {
    costUsd: cost.results.reduce((sum, r) => sum + Math.round(amount(r.dollars) * 1e9), 0) / 1e9,
    balanceUsd: usdBalances.length
      ? usdBalances.reduce((sum, b) => sum + amount(b.amount), 0)
      : null,
    currency: 'USD',
    timeZone: 'provider',
    from: period.from,
    to: period.to,
    basis: 'provider-reported',
    provisional: true,
  };
}
/** One owner-triggered read with an atomic per-period lease. Failures preserve
 * the previous successful snapshot and never expose provider error payloads.
 * @param {Env} env @param {string} provider @param {{from:string,to:string,since:string,until:string}} period @param {number} [nowMs] @param {typeof fetch} [fetchImpl] */
export async function refreshSystemBilling(
  env,
  provider,
  period,
  nowMs = Date.now(),
  fetchImpl = fetch,
) {
  if (!['openai', 'deepgram'].includes(provider)) return { ok: false, error: 'unsupported' };
  if (!configured(env, provider)) return { ok: false, error: 'not-configured' };
  if (!env.DB) return { ok: false, error: 'storage' };
  const id = key(provider, period),
    token = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `INSERT INTO system_billing_snapshots(id,provider,attempted_at,lease_until,lease_token) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET attempted_at=excluded.attempted_at,lease_until=excluded.lease_until,lease_token=excluded.lease_token
    WHERE system_billing_snapshots.lease_until<=? RETURNING id`,
  )
    .bind(id, provider, new Date(nowMs).toISOString(), nowMs + 180000, token, nowMs)
    .all();
  if (!claim.results?.length) return { ok: false, error: 'cooldown' };
  try {
    const value =
      provider === 'openai'
        ? await fetchOpenAiBilling(env, period, fetchImpl)
        : await fetchDeepgramBilling(env, period, fetchImpl);
    const snapshot = { ...value, collectedAt: new Date(nowMs).toISOString() };
    await env.DB.prepare(
      'UPDATE system_billing_snapshots SET snapshot_json=?,collected_at=?,error_class=NULL,lease_until=? WHERE id=? AND lease_token=?',
    )
      .bind(JSON.stringify(snapshot), snapshot.collectedAt, nowMs + 60000, id, token)
      .run();
    return { ok: true, snapshot };
  } catch (error) {
    const classification =
      error instanceof Error &&
      ['access', 'quota', 'provider', 'format', 'scope', 'incomplete'].includes(error.message)
        ? error.message
        : 'network';
    await env.DB.prepare(
      'UPDATE system_billing_snapshots SET error_class=?,lease_until=? WHERE id=? AND lease_token=?',
    )
      .bind(classification, nowMs + 60000, id, token)
      .run();
    return { ok: false, error: classification };
  }
}
