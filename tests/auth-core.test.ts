import { workerEnv } from './helpers/env.js';
import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  validateInitData,
  allowedUserIds,
  isPrimaryOwner,
  checkOwner,
  checkPrimaryOwner,
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

  /* ⚠️ ТА САМА ДІРА, лише на крок глибше — і саме її стара перевірка `!botToken`
     пропускала. Токен із пробілів falsy НЕ є, тож секрет ставав
     HMAC("WebAppData", " "): не публічна константа, але простір кандидатів
     мізерний, а `user.id` підписант задає сам. Тобто це був не «не той
     секрет», а обхід авторизації Mini App цілком. */
  it('токен із самих пробілів -> null (не власний валідний секрет)', async () => {
    for (const blank of [' ', '   ', '\n', '\r\n', '\t']) {
      const forged = signInitData({ user: JSON.stringify(OWNER) }, blank);
      expect(await validateInitData(forged, blank)).toBeNull();
    }
  });

  /* Хвостовий перенос рядка в секреті — задокументована пастка цього проєкту
     (копіювання з панелі). Без trim він давав ІНШИЙ HMAC і тихо клав
     авторизацію дашборда цілком: Telegram підписує чистим токеном, а ми
     звіряли брудним. */
  it('токен із хвостовим переносом рядка працює так само, як чистий', async () => {
    const init = ownerInit(); // підписано ЧИСТИМ BOT_TOKEN
    expect(await validateInitData(init, BOT_TOKEN + '\r\n')).not.toBeNull();
    expect(await validateInitData(init, ` ${BOT_TOKEN} `)).not.toBeNull();
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

  /* SV-B3 — ДРУГИЙ бік того самого вікна.
   *
   * Доти перевірялась лише верхня межа, і `auth_date` із майбутнього проходив
   * без обмежень: підпис-бо валідний, а дату підписує той самий, хто підписує
   * initData. Практичний наслідок — не «дивна дата», а ключ без терміну
   * придатності: 24-годинне вікно для нього просто ніколи не наставало. */
  const withSkew = (deltaSec: number) =>
    signInitData(
      { user: JSON.stringify(OWNER) },
      BOT_TOKEN,
      Math.floor(Date.now() / 1000) + deltaSec,
    );

  it('дата з далекого майбутнього -> null, а не вічний перепустк', async () => {
    expect(await validateInitData(withSkew(10 * 365 * 86_400), BOT_TOKEN)).toBeNull();
    expect(await validateInitData(withSkew(3600), BOT_TOKEN)).toBeNull();
    expect(await validateInitData(withSkew(301), BOT_TOKEN)).toBeNull();
  });

  it('розбіжність годинників у межах допуску проходить', async () => {
    // Клієнт, що спішить на хвилину, — це норма, а не атака.
    expect(await validateInitData(withSkew(60), BOT_TOKEN)).not.toBeNull();
    expect(await validateInitData(withSkew(0), BOT_TOKEN)).not.toBeNull();
  });

  it('нижня межа вікна не зрушила: 24 години мінус хвилина ще валідні', async () => {
    // Гарантія проти «полагодили майбутнє, зламали сесію»: Telegram видає
    // auth_date РАЗ на запуск Mini App, тож звуження вікна вниз віддавало б
    // 401 апці, відкритій довше за нього.
    expect(await validateInitData(withSkew(-86_340), BOT_TOKEN)).not.toBeNull();
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
  const env = workerEnv({
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    TELEGRAM_OWNER_USER_ID: '1',
    TELEGRAM_COOWNER_USER_IDS: String(OWNER.id),
  });

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
    const res = await checkOwner(ownerInit(), workerEnv({ TELEGRAM_BOT_TOKEN: BOT_TOKEN }));
    expect(res).toMatchObject({ ok: false, status: 403 });
  });
});
