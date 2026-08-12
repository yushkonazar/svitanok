import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  validateInitData,
  allowedUserIds,
  isPrimaryOwner,
  checkOwner,
  checkPrimaryOwner,
  // @ts-expect-error — JS-модуль Worker'а без типів.
} from '../web/auth-core.mjs';

/* Єдина безпекова поверхня дашборда, витягнута з worker.js (Фаза 5).
 *
 * HTTP-тести (worker-multi-user-auth.test.ts) перевіряють, що двері зачинені
 * ЗЗОВНІ. Тут перевіряється сам замок — і саме ті випадки, до яких через HTTP
 * не догукатись: вироджений секрет при не заданому токені, протухла підпис-дата,
 * порожній список дозволених. Спільна властивість усіх трьох — fail-closed:
 * misconfig має ВІДМОВЛЯТИ, а не пускати. */

const BOT_TOKEN = '123456:test-bot-token';

/** Зібрати валідний initData за алгоритмом Telegram (той самий, що в проді). */
function signInitData(
  fields: Record<string, string>,
  token = BOT_TOKEN,
  authDate = Math.floor(Date.now() / 1000),
) {
  const params: Record<string, string> = { auth_date: String(authDate), ...fields };
  const dataCheck = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(dataCheck).digest('hex');
  return new URLSearchParams({ ...params, hash }).toString();
}

const OWNER = { id: 4242, first_name: 'Назар' };
const ownerInit = () => signInitData({ user: JSON.stringify(OWNER) });

describe('validateInitData — підпис Telegram', () => {
  it('коректний підпис -> user', async () => {
    const v = await validateInitData(ownerInit(), BOT_TOKEN);
    expect(v?.user).toMatchObject({ id: 4242 });
  });

  /* ⚠️ Найтихіша з можливих дір. Без явної перевірки токена enc.encode(undefined)
     дає порожні байти, і секрет вироджується в HMAC("WebAppData","") — ПУБЛІЧНУ
     константу, яку порахує будь-хто. Тобто вікно ротації секрету чи битий конфіг
     перетворювали б misconfig на відкриті двері. */
  it('НЕ заданий botToken -> null, а не «підпис зійшовся»', async () => {
    const forged = signInitData({ user: JSON.stringify(OWNER) }, '');
    expect(await validateInitData(forged, undefined)).toBeNull();
    expect(await validateInitData(forged, '')).toBeNull();
  });

  it('чужий токен, підроблений hash, відсутній hash -> null', async () => {
    expect(await validateInitData(ownerInit(), 'інший-токен')).toBeNull();
    const tampered = ownerInit().replace(/hash=[0-9a-f]+/, 'hash=' + 'a'.repeat(64));
    expect(await validateInitData(tampered, BOT_TOKEN)).toBeNull();
    expect(await validateInitData('user=%7B%7D', BOT_TOKEN)).toBeNull();
  });

  it('підпис старший за 24 години -> null (перехоплений initData не вічний)', async () => {
    const old = Math.floor(Date.now() / 1000) - 86_401;
    const stale = signInitData({ user: JSON.stringify(OWNER) }, BOT_TOKEN, old);
    expect(await validateInitData(stale, BOT_TOKEN)).toBeNull();
  });
});

describe('allowedUserIds / isPrimaryOwner — fail-closed', () => {
  it('жодної змінної -> порожній Set і false (нікому не довіряємо)', () => {
    expect(allowedUserIds({}).size).toBe(0);
    expect(isPrimaryOwner({}, 4242)).toBe(false);
  });

  it('співвласники читаються і зі старої назви змінної (вікно перейменування)', () => {
    const withNew = allowedUserIds({
      TELEGRAM_OWNER_USER_ID: '1',
      TELEGRAM_COOWNER_USER_IDS: '2, 3',
    });
    const withOld = allowedUserIds({
      TELEGRAM_OWNER_USER_ID: '1',
      TELEGRAM_ALLOWED_USER_IDS: '2, 3',
    });
    expect([...withNew]).toEqual(['1', '2', '3']);
    expect([...withOld]).toEqual([...withNew]);
  });

  it('співвласник — ЧИТАЧ, не другий власник (S1/B1)', () => {
    const env = { TELEGRAM_OWNER_USER_ID: '1', TELEGRAM_COOWNER_USER_IDS: '2' };
    expect(allowedUserIds(env).has('2')).toBe(true);
    expect(isPrimaryOwner(env, 2)).toBe(false);
    expect(isPrimaryOwner(env, 1)).toBe(true);
    expect(isPrimaryOwner(env, '1')).toBe(true); // id приходить і рядком, і числом
  });
});

describe('checkOwner / checkPrimaryOwner — дивитись ≠ міняти', () => {
  const env = {
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: '1',
    TELEGRAM_COOWNER_USER_IDS: String(OWNER.id),
  };

  it('співвласник ПРОХОДИТЬ читання і НЕ проходить запис', async () => {
    const init = ownerInit();
    expect(await checkOwner(init, env)).toMatchObject({ ok: true });
    expect(await checkPrimaryOwner(init, env)).toMatchObject({ ok: false, status: 403 });
  });

  it('битий підпис -> 401 (не 403): це «не довели, хто ти», а не «тобі не можна»', async () => {
    expect(await checkOwner('user=%7B%7D&hash=deadbeef', env)).toMatchObject({
      ok: false,
      status: 401,
    });
  });

  it('порожній список дозволених -> 403 навіть із валідним підписом', async () => {
    const res = await checkOwner(ownerInit(), { TELEGRAM_BOT_TOKEN: BOT_TOKEN });
    expect(res).toMatchObject({ ok: false, status: 403 });
  });
});
