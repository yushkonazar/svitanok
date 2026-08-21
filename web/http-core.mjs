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
 * @returns {Promise<{ ok: true, body: KvBlob }
 *   | { ok: false, status: number, error: string }>}
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
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: 'bad-json' };
    }
    return { ok: true, body: parsed };
  } catch {
    return { ok: false, status: 400, error: 'bad-json' };
  }
}
