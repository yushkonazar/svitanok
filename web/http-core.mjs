// HTTP-примітиви Worker'а (Фаза 5, модуляризація worker.js).
//
// Дві дрібні речі, які вживає КОЖЕН ендпоінт, — і саме тому вони мають жити
// окремо: інакше будь-який новий модуль-хендлер тягнув би за собою імпорт із
// worker.js і замикав цикл.

/**
 * JSON-відповідь із правильним content-type.
 * @param {unknown} obj
 * @param {number} [status]
 */
export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Стеля тіла `/api/*` (S3). Найбільше законне тіло тут — повний блоб settings,
 * сотні байтів, тож 16 КБ — запас на два порядки, а не межа для вжитку.
 */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

/**
 * Стеля тіла ВЕБХУКА Telegram — окрема, і це не послаблення заради спокою.
 *
 * 16 КБ менші за максимальний ЗАКОННИЙ апдейт: `message.text` до 4096 символів,
 * кирилиця в UTF-8 — два байти на літеру, а якщо повідомлення є відповіддю, у
 * тому ж апдейті їде вкладений `reply_to_message` такого самого розміру. Разом
 * із масивами `entities` і службовими полями це переходить за 16 КБ, тобто
 * стеля відкидала б апдейт, який Telegram має повне право надіслати — а бот
 * відповідав би 413 і не обробляв повідомлення власника взагалі.
 *
 * 128 КБ лишають DoS-захист осмисленим (на три порядки менше за 100 МБ, які
 * Cloudflare пропустив би сам) і водночас не ріжуть законний трафік.
 */
export const MAX_WEBHOOK_BODY_BYTES = 128 * 1024;

/**
 * Прочитати тіло, зупинившись на першому байті ПОНАД стелю.
 *
 * Навіщо потоком, а не `request.text()`: той матеріалізує тіло ЦІЛКОМ, і лише
 * потім його можна зміряти — тобто на запиті без `Content-Length` (chunked)
 * стеля спрацьовувала б уже після того, як памʼять витрачено, а перевірка по
 * байтах робила б із рядка ще одну повну копію. Тут памʼять обмежена стелею
 * плюс один шматок, скільки б відправник не надіслав.
 *
 * @param {Request} request
 * @param {number} maxBytes
 * @returns {Promise<{ ok: true, raw: string } | { ok: false, tooLarge: boolean }>}
 */
async function readCappedBody(request, maxBytes) {
  const stream = request.body;
  if (!stream) return { ok: false, tooLarge: false }; // тіла немає (GET/DELETE)

  const reader = stream.getReader();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        // Решту не дочитуємо: саме це й відрізняє стелю від лічильника.
        await reader.cancel();
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }

  const joined = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.byteLength;
  }
  return { ok: true, raw: new TextDecoder().decode(joined) };
}

/**
 * Розібрати JSON-тіло з жорсткою стелею розміру (S3) -> {ok:true,body} |
 * {ok:false,status,error}.
 *
 * Навіщо ДО request.json(): без цього кожен ендпоінт спершу матеріалізує в
 * памʼяті скільки завгодно даних, і лише потім бачить, що вони не потрібні —
 * тобто вартість запиту задає той, хто його шле. Content-Length — дешевий
 * ранній відсів; для запитів без нього (chunked) рахуємо реально прочитане.
 *
 * ⚠️ Rate-limit сам по собі тут НЕ вирішується — це конфіг Cloudflare WAF на
 * /api/*, поза кодом (див. AUDIT §8 S3).
 *
 * ⚠️ ТІЛО МУСИТЬ БУТИ ПЛОСКИМ ОБʼЄКТОМ. `JSON.parse` радо віддає масив, рядок,
 * число чи `null` — і кожен викликач далі індексує його як обʼєкт. `'x'.type`
 * тихо дає undefined, `[].initData` теж, тож помилковий запит проходив би
 * далі мовчки, замість зупинитись на межі. Жоден `/api/*` не приймає
 * не-обʼєкт, тож перевірка нічого легітимного не відкидає.
 *
 * `KvBlob`, а не `unknown`: перевірка стверджує лише ФОРМУ, не вміст. Поля й
 * далі валідує кожен ендпоінт сам (`typeof body.title === 'string'`,
 * `cleanCheckin`, `isSafeKey`) — цей рядок їх не заміняє.
 *
 * @param {Request} request
 * @param {number} [maxBytes] стеля; вебхук Telegram передає власну (див. вище)
 * @returns {Promise<{ ok: true, body: KvBlob }
 *   | { ok: false, status: number, error: string }>}
 */
export async function readJsonBody(request, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return { ok: false, status: 413, error: 'body-too-large' };
  }
  // Байти, не символи: кирилиця в UTF-8 — два байти на літеру, тож перевірка
  // по .length пропускала б удвічі більше за задекларовану межу. Заголовку не
  // віримо: він може брехати в обидва боки, рахуємо реально прочитане.
  const read = await readCappedBody(request, maxBytes);
  if (!read.ok) {
    return read.tooLarge
      ? { ok: false, status: 413, error: 'body-too-large' }
      : { ok: false, status: 400, error: 'bad-json' };
  }
  try {
    const parsed = JSON.parse(read.raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'bad-json' };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, status: 400, error: 'bad-json' };
  }
}
