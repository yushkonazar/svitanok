import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів.
import worker from '../web/worker.js';
import { memoryKv } from './helpers/kv.js';

/* Інтеграційні тести /brief -> workflow_dispatch.
 *
 * Регресія, заради якої файл існує: ручний /brief ішов у GitHub БЕЗ inputs.force,
 * тож після ранкової доставки guard (scripts/guard.mjs) бачив lastSent===today,
 * друкував «send=false :: idempotent» і завершував воркфлоу УСПІХОМ. Бот при
 * цьому вже написав «Запустив генерацію — прийде за кілька хвилин»: жодної
 * помилки ніде, і жодного брифінгу. Автоматичний (крон) шлях, навпаки, force
 * мати НЕ повинен — саме ідемпотентність не дає йому надіслати 48 брифінгів за
 * ранкове вікно.
 *
 * Той самий стиль, що worker-agenda.test.ts: справжній worker.fetch, стаб fetch.
 */

const WEBHOOK_SECRET = 'tg-webhook-secret-abcdef';
const OWNER = 4242;

let kv: Map<string, string>;
let tg: { method: string; body: Record<string, unknown> }[];
let dispatches: { url: string; body: Record<string, unknown> }[];
let dispatchStatus: number;

function env(overrides: Record<string, unknown> = {}) {
  return {
    BRIEFING: {
      ...memoryKv(kv),
    },
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    TELEGRAM_BOT_TOKEN: 'bot-token',
    TELEGRAM_OWNER_USER_ID: String(OWNER),
    GH_DISPATCH_TOKEN: 'gh-token',
    ...overrides,
  };
}

function ctx() {
  const promises: Promise<unknown>[] = [];
  return {
    waitUntil: (p: Promise<unknown>) => void promises.push(p),
    settle: () => Promise.all(promises),
  };
}

async function sendCommand(text: string, e = env(), updateId = 1) {
  const c = ctx();
  await worker.fetch(
    new Request('https://svitanok.example/api/telegram', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Telegram-Bot-Api-Secret-Token': WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: updateId,
        message: { message_id: 1, chat: { id: OWNER }, from: { id: OWNER }, text },
      }),
    }),
    e,
    c,
  );
  await c.settle();
}

const lastSendText = () =>
  [...tg].reverse().find((c) => c.method === 'sendMessage')?.body.text as string | undefined;

beforeEach(() => {
  kv = new Map();
  tg = [];
  dispatches = [];
  dispatchStatus = 204;
  vi.stubGlobal('fetch', async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes('api.github.com')) {
      dispatches.push({ url, body });
      // null, а не '': конструктор Response забороняє тіло при 204 (саме цей
      // статус і віддає GitHub на успішний workflow_dispatch).
      return new Response(null, { status: dispatchStatus });
    }
    if (url.includes('api.telegram.org')) {
      tg.push({ method: url.split('/').pop() ?? '', body });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('/brief -> workflow_dispatch', () => {
  it('шле inputs.force_window — «зараз, поза вікном», але без перезапису (B2)', async () => {
    await sendCommand('/brief');

    expect(dispatches).toHaveLength(1);
    expect(dispatches[0]?.body).toMatchObject({ ref: 'main', inputs: { force_window: 'true' } });
    // Повний обхід (force) бот НЕ просить НІКОЛИ: повторний прогін того самого
    // дня опублікував би майже порожній брифінг поверх ранкового.
    expect(
      (dispatches[0]?.body as { inputs: Record<string, unknown> }).inputs.force,
    ).toBeUndefined();
    expect(lastSendText()).toContain('Запустив генерацію');
  });

  it('прапорець — рядок, а не boolean: REST API workflow_dispatch приймає лише string-inputs', async () => {
    await sendCommand('/brief');

    const inputs = (dispatches[0]?.body as { inputs: Record<string, unknown> }).inputs;
    expect(typeof inputs.force_window).toBe('string');
  });

  it('брифінг за сьогодні вже надіслано -> чесна відповідь, БЕЗ dispatch (B2)', async () => {
    // Раніше /brief тут ішов у GitHub із повним force, прогін перебирав уже
    // показані новини/вакансії й публікував майже порожній блоб поверх
    // ранкового — назавжди, включно з історією `briefing:<дата>`.
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Kyiv',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
    kv.set('state', JSON.stringify({ lastSentDate: today }));

    await sendCommand('/brief');

    expect(dispatches).toHaveLength(0);
    expect(lastSendText()).toContain('уже надіслано');
  });

  it('без GH_DISPATCH_TOKEN — чесна помилка, а не «прийде за кілька хвилин»', async () => {
    await sendCommand('/brief', env({ GH_DISPATCH_TOKEN: undefined }));

    expect(dispatches).toHaveLength(0);
    expect(lastSendText()).toContain('Не вдалося запустити');
  });

  it('збій GitHub не сіє кулдаун — повтор одразу доступний', async () => {
    dispatchStatus = 500;
    await sendCommand('/brief');
    expect(lastSendText()).toContain('Не вдалося запустити');

    dispatchStatus = 204;
    await sendCommand('/brief', env(), 2);
    expect(dispatches).toHaveLength(2);
    expect(lastSendText()).toContain('Запустив генерацію');
  });

  it('кулдаун після успіху: другий /brief підряд не палить ще один запуск', async () => {
    await sendCommand('/brief');
    await sendCommand('/brief', env(), 2);

    expect(dispatches).toHaveLength(1);
    expect(lastSendText()).toContain('нещодавно запускався');
  });
});

/* Слаг репозиторію в URL диспетчу (P4). Раніше він був зашитий у cron.mjs, тож
 * форк чи перейменування вимагали правки коду. Дефолт лишається той самий —
 * новий обовʼязковий секрет тут завів би прод у стан «брифінг не диспатчиться,
 * доки власник не поставить змінну в двох місцях». */
describe('workflow_dispatch — слаг репозиторію', () => {
  it('без GH_REPO — дефолтний слаг', async () => {
    await sendCommand('/brief');
    expect(dispatches[0]?.url).toBe(
      'https://api.github.com/repos/yushkonazar/svitanok/actions/workflows/brief.yml/dispatches',
    );
  });

  it('GH_REPO перекриває слаг', async () => {
    await sendCommand('/brief', env({ GH_REPO: 'someone/fork' }));
    expect(dispatches[0]?.url).toBe(
      'https://api.github.com/repos/someone/fork/actions/workflows/brief.yml/dispatches',
    );
  });

  it('порожній GH_REPO — дефолт, а не порожній сегмент шляху', async () => {
    await sendCommand('/brief', env({ GH_REPO: '   ' }));
    expect(dispatches[0]?.url).toContain('/repos/yushkonazar/svitanok/');
  });
});
