// HTTP-примітиви Worker'а (Фаза 5, модуляризація worker.js).
//
// Дві дрібні речі, які вживає КОЖЕН ендпоінт, — і саме тому вони мають жити
// окремо: інакше будь-який новий модуль-хендлер тягнув би за собою імпорт із
// worker.js і замикав цикл.

export const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });

/**
 * Стеля тіла запиту (S3). Найбільше законне тіло тут — повний блоб settings
 * (сотні байтів) і Telegram-апдейт (одиниці КБ), тож 16КБ — це запас на два
 * порядки, а не межа для реального вжитку.
 */
const MAX_REQUEST_BODY_BYTES = 16 * 1024;

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
 */
export async function readJsonBody(request) {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, status: 413, error: 'body-too-large' };
  }
  let raw;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, status: 400, error: 'bad-json' };
  }
  // Байти, не символи: кирилиця в UTF-8 — два байти на літеру, тож перевірка
  // по .length пропускала б удвічі більше за задекларовану межу.
  if (new TextEncoder().encode(raw).length > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, status: 413, error: 'body-too-large' };
  }
  try {
    return { ok: true, body: JSON.parse(raw) };
  } catch {
    return { ok: false, status: 400, error: 'bad-json' };
  }
}
