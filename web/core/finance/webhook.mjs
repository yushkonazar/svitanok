// Вебхук Monobank (01 §3.6, S-4-1…S-4-5, S-4-12, етап 6 PR-1).
//
// ⚠️ ЄДИНИЙ, крім `/api/telegram` і публічного `/api/status`, маршрут, куди
// стукає хтось ззовні з ЧУЖИМ тілом. Тому чотири бар'єри, і кожен - до того,
// як тіло взагалі розбирається:
//   1. секрет у ШЛЯХУ (Mono тіла не підписує - 01 §7 «Підробка вебхука Mono»),
//      порівняння константночасне;
//   2. стеля тіла (StatementItem - менше кілобайта; 8 КБ із запасом);
//   3. форма: type=StatementItem і мінімальні поля, інакше 400 без роботи;
//   4. Імпортуємо лише `account` з перевіреного каталогу рахунків і банок.
//
// Шлях НАВМИСНО під префіксом `/api/`: правило WAF зони - starts_with(uri.path,
// "/api/") з винятками `/api/telegram` і `/api/agent-step`, тож ліміт 60/10 с
// діє тут без жодних змін конфігу. Назва поза цим префіксом (наприклад
// `/webhook/mono`, як у чернетці 01 §3.6) тихо вивела б публічний ендпоїнт
// з-під ліміту, а WAF із репозиторію не налаштувати.
//
// Для відомого рахунку облік виконується у waitUntil. Подію з невідомого
// рахунку відкладаємо до перевірки каталогу. Пропущене добирає виписка.

import { json, readJsonBody } from '../../http-core.mjs';
import { constantTimeEqual } from '../../tg-core.mjs';
import { isMonoAccountId, MonoTooSoonError, parseStatementItem } from '../adapters/mono.mjs';
import { sendSystemAlert } from '../tg/outbox.mjs';
import { ingestTransaction, readMonoAccounts, writeMonoClientAccounts } from './store.mjs';
import { readMonoClientInfo } from './bank-refresh.mjs';
import { announceTransaction } from './notify.mjs';
import { monoAlertClaim } from '../mono-alert-gate/client.mjs';
import {
  claimMonoWebhookCatalogRefresh,
  completeMonoWebhook,
  enqueueMonoWebhook,
  readMonoWebhookInbox,
} from '../mono-reconcile/client.mjs';
import {
  MONO_UNKNOWN_ALERT_KEY,
  MONO_UNKNOWN_ALERT_WINDOW_MS,
} from '../mono-alert-gate/contract.mjs';

/** Префікс маршруту; далі в шляху - секрет. */
export const MONO_WEBHOOK_PREFIX = '/api/mono/';
/** Стеля тіла: один StatementItem - сотні байтів. */
export const MAX_MONO_BODY_BYTES = 8 * 1024;
/** Скільки алертів «чужий рахунок» на добу: далі лише лог (не робимо самі собі флуд). */
export { MONO_UNKNOWN_ALERT_KEY as UNKNOWN_ALERT_KEY };

/**
 * Адреса вебхука для цього воркера. Джерело - той самий origin, що обслуговує
 * запит: у ядра немає окремого конфіга з власним доменом, а вигаданий
 * домен-константа розійшовся б із реальністю при переїзді.
 * @param {Env} env @param {string} origin
 */
export function monoWebhookUrl(env, origin) {
  const secret = String(env.MONO_WEBHOOK_SECRET ?? '').trim();
  if (!secret) throw new Error('MONO_WEBHOOK_SECRET не заданий - вебхук Mono неможливий');
  return `${origin}${MONO_WEBHOOK_PREFIX}${secret}`;
}

/**
 * @param {Request} request @param {Env} env
 * @param {ExecutionContext} [ctx] @param {number} [nowMs]
 */
export async function handleMonoWebhook(request, env, ctx = undefined, nowMs = Date.now()) {
  const expected = String(env.MONO_WEBHOOK_SECRET ?? '').trim();
  if (!expected) return json({ ok: false, error: 'no-webhook-secret' }, 500);
  const raw = new URL(request.url).pathname.slice(MONO_WEBHOOK_PREFIX.length);
  /** @type {string} */
  let given;
  try {
    given = decodeURIComponent(raw);
  } catch {
    // Криве відсоткове екранування («/api/mono/%») - те саме «не туди
    // потрапив», що й чужий секрет. Без цього URIError виходив би 500-ю, і
    // сторонній однією пробою відрізняв би наявний маршрут від відсутнього.
    given = raw;
  }
  if (!constantTimeEqual(given, expected)) {
    // Без деталей: 404, а не 401 - стороннім не підказуємо, що тут щось є.
    return json({ ok: false, error: 'not-found' }, 404);
  }

  // Mono перевіряє адресу порожнім GET перед тим, як її зберегти: без 200 на
  // GET `setWebhook` мовчки не спрацював би.
  if (request.method === 'GET') return json({ ok: true });
  if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405);

  const parsedBody = await readJsonBody(request, MAX_MONO_BODY_BYTES);
  if (!parsedBody.ok) return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  const body = /** @type {any} */ (parsedBody.body);
  if (body?.type !== 'StatementItem') return json({ ok: false, error: 'bad-type' }, 400);
  const account = body?.data?.account;
  const item = parseStatementItem(body?.data?.statementItem);
  if (!isMonoAccountId(account) || !item) return json({ ok: false, error: 'bad-item' }, 400);

  const accounts = await readMonoAccounts(env).catch((/** @type {any} */ e) => {
    console.error('mono: рахунки власника не прочитані', e?.message);
    return null;
  });
  if (accounts == null) return json({ ok: false, error: 'accounts-unavailable' }, 503);
  const known = accounts.find((a) => a.id === account);
  if (!known) {
    // Persist temporarily outside the ledger. Catalog proof is still required
    // before this delivery can become an operation.
    let queued;
    try {
      queued = await enqueueMonoWebhook(env, account, item, nowMs);
    } catch {
      return json({ ok: false, error: 'inbox-unavailable' }, 503);
    }
    const reason = accounts.length
      ? 'Mono надіслав операцію для невідомого рахунку. Перевірю список рахунків і банок під час звірки.'
      : 'Mono надіслав операцію до оновлення списку рахунків. Звірка перевірить виписки доступних рахунків.';
    console.warn(`mono: ${reason}`);
    const alert = alertOncePerDay(env, reason, nowMs).catch(() => {
      console.error('mono: не вдалося поставити в чергу сповіщення про невідомий рахунок');
    });
    if (ctx?.waitUntil) ctx.waitUntil(alert);
    else await alert;
    return json(
      queued
        ? { ok: true, queued: 'unverified-account' }
        : { ok: true, ignored: 'unverified-account' },
    );
  }

  const work = async () => {
    try {
      const { inserted, tx } = await ingestTransaction(env, {
        item,
        account,
        accountCurrency: known.currency,
        bankKind: known.bankKind,
        checkedAt: new Date(nowMs).toISOString(),
        checkSource: 'webhook',
      });
      if (inserted && tx) await announceTransaction(env, tx, nowMs);
    } catch (/** @type {any} */ e) {
      // Після 200 Mono не повторює доставку. Відкладемо її до звірки.
      console.error(`mono: транзакція ${item.id} не оброблена (звірка добере)`, e?.message);
      await enqueueMonoWebhook(env, account, item, nowMs).catch(() => false);
    }
  };
  if (ctx?.waitUntil) ctx.waitUntil(work());
  else await work();
  return json({ ok: true });
}

/** Replay after the bank catalog confirms ownership. No queued data enters the
 * ledger while its account is missing from that catalog.
 * @param {Env} env @param {import('./store.mjs').StoredAccount[]} accounts @param {number} nowMs */
export async function recoverMonoWebhooks(env, accounts, nowMs) {
  const pending = await readMonoWebhookInbox(env, nowMs);
  if (!pending.length) return null;
  let roster = new Map(accounts.map((account) => [account.id, account]));
  if (
    pending.some((entry) => !roster.has(entry.account)) &&
    (await claimMonoWebhookCatalogRefresh(env, nowMs))
  ) {
    try {
      const fresh = await writeMonoClientAccounts(env, await readMonoClientInfo(env, nowMs), nowMs);
      if (fresh.length) roster = new Map(fresh.map((account) => [account.id, account]));
    } catch (error) {
      if (!(error instanceof MonoTooSoonError))
        console.error('mono: каталог для відкладених подій недоступний');
    }
  }
  let recovered = 0;
  for (const entry of pending.filter((candidate) => roster.has(candidate.account)).slice(0, 4)) {
    const account = roster.get(entry.account);
    if (!account) continue;
    await ingestTransaction(env, {
      item: entry.item,
      account: account.id,
      accountCurrency: account.currency,
      bankKind: account.bankKind,
      checkedAt: new Date(entry.receivedAt).toISOString(),
      checkSource: 'webhook',
      silent: true,
    });
    await completeMonoWebhook(env, entry.receipt);
    recovered++;
  }
  return recovered ? { recoveredMonoWebhooks: recovered } : null;
}

/**
 * Алерт «чужий рахунок» - не частіше разу на добу: адресу знає хтось третій,
 * і потік підробок не має перетворитись на потік повідомлень власнику.
 * @param {Env} env @param {string} text @param {number} nowMs
 */
async function alertOncePerDay(env, text, nowMs) {
  let last = 0;
  try {
    last = Number((await env.BRIEFING.get(MONO_UNKNOWN_ALERT_KEY)) ?? 0);
  } catch (/** @type {any} */ e) {
    console.error('mono: мітка алерту не записана', e?.message);
  }
  const claim = await monoAlertClaim(env, last, nowMs, MONO_UNKNOWN_ALERT_WINDOW_MS);
  if (!claim.ok) return false;
  return sendSystemAlert(env, `⚠️ ${text}`, nowMs);
}

/**
 * `POST /internal/test/mono` (07 §3, 01 §5) - підміна вебхука тестовою
 * транзакцією для приймання етапу 6: реальна 1-гривнева покупка не завжди під
 * рукою, а перевірити треба весь шлях - прапорці, текст, кнопки.
 *
 * Автентифікація ДВОРІВНЕВА і обидва рівні обовʼязкові:
 *   - зовні маршрут `/internal/*` закритий Cloudflare Access (05-ops);
 *   - усередині - заголовок `X-Test: 1` (явний намір) і `X-Mono-Secret`, що
 *     дорівнює `MONO_WEBHOOK_SECRET`, константночасно.
 * Другий рівень - НЕ надмірність: перевірка «є заголовок Access» довіряла б
 * наявності заголовка, який підробити тривіально, якби маршрут колись
 * опинився повз Access. Секрет вебхука власник і так має - нового не заводимо.
 *
 * Транзакція лягає з `raw_json.test = 1` і не входить у суми та звіти
 * (`store.NOT_TEST_SQL`), але прапорці рахуються по-справжньому.
 *
 * @param {Request} request @param {Env} env @param {number} [nowMs]
 */
export async function handleMonoTest(request, env, nowMs = Date.now()) {
  if (env.ASSISTANT_V2 !== 'shadow' && env.ASSISTANT_V2 !== 'on') {
    return json({ ok: false, error: 'not-found' }, 404);
  }
  if (request.method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405);
  const expected = String(env.MONO_WEBHOOK_SECRET ?? '').trim();
  if (!expected) return json({ ok: false, error: 'no-webhook-secret' }, 500);
  if (request.headers.get('X-Test') !== '1') return json({ ok: false, error: 'not-found' }, 404);
  if (!constantTimeEqual(request.headers.get('X-Mono-Secret') ?? '', expected)) {
    return json({ ok: false, error: 'not-found' }, 404);
  }

  const parsedBody = await readJsonBody(request, MAX_MONO_BODY_BYTES);
  if (!parsedBody.ok) return json({ ok: false, error: parsedBody.error }, parsedBody.status);
  const body = /** @type {any} */ (parsedBody.body);
  const amount = Number(body?.amount);
  if (!Number.isInteger(amount) || amount === 0) {
    return json({ ok: false, error: 'amount: ціле число копійок, відʼємне для списання' }, 400);
  }
  const accounts = await readMonoAccounts(env);
  const account = accounts.find((a) => a.id === String(body?.account ?? '')) ?? accounts[0];
  if (!account) return json({ ok: false, error: 'no-accounts' }, 409);

  const item = parseStatementItem({
    id:
      typeof body?.id === 'string' && body.id
        ? body.id
        : `test-${crypto.randomUUID().slice(0, 12)}`,
    time: Number.isFinite(Number(body?.time)) ? Number(body.time) : Math.floor(nowMs / 1000),
    description: String(body?.description ?? 'Тестова покупка'),
    mcc: Number.isInteger(Number(body?.mcc)) ? Number(body.mcc) : 5999,
    amount,
    operationAmount: Number.isInteger(Number(body?.operationAmount))
      ? Number(body.operationAmount)
      : amount,
    currencyCode: Number.isInteger(Number(body?.currencyCode)) ? Number(body.currencyCode) : 980,
    hold: false,
    balance: Number.isInteger(Number(body?.balance)) ? Number(body.balance) : null,
  });
  if (!item) return json({ ok: false, error: 'bad-item' }, 400);

  const { inserted, tx } = await ingestTransaction(env, {
    item,
    account: account.id,
    accountCurrency: account.currency,
    test: true,
  });
  const announced = inserted && tx ? await announceTransaction(env, tx, nowMs) : false;
  return json({
    ok: true,
    inserted,
    announced,
    id: item.id,
    ...(tx ? { category: tx.category, flags: tx.flags } : {}),
  });
}
