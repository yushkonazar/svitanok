import { describe, it, expect } from 'vitest';
// @ts-expect-error — JS-модуль Worker'а без типів (namespace-імпорт).
import * as run from '../web/agent-run-core.mjs';

const {
  AGENT_MAX_STEPS,
  AGENT_RUN_TTL_MS,
  AGENT_STEP_TTL_MS,
  mintRunToken,
  verifyRunToken,
  nextRunToken,
} = run as {
  AGENT_MAX_STEPS: number;
  AGENT_RUN_TTL_MS: number;
  AGENT_STEP_TTL_MS: number;
  mintRunToken: (s: string, o: Record<string, unknown>) => Promise<string>;
  verifyRunToken: (
    s: string,
    t: unknown,
    now?: number,
  ) => Promise<
    | { ok: true; claims: Record<string, unknown> & { expMs: number; deadlineMs: number } }
    | { ok: false; error: string }
  >;
  nextRunToken: (s: string, c: Record<string, unknown>, now?: number) => Promise<string | null>;
};

const SECRET = 'worker-only-secret-abcdef0123456789';
const NOW = 1_752_800_000_000;
const BASE = { runId: 'r1a2b3c4', chatId: 42, threadId: 7, progressMsgId: 555 };

describe('agent-run-core: ран-токен', () => {
  it('змінтований токен проходить перевірку і повертає ті самі клейми', async () => {
    const token = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    const res = await verifyRunToken(SECRET, token, NOW + 1000);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims).toMatchObject({
      runId: 'r1a2b3c4',
      chatId: 42,
      threadId: 7,
      progressMsgId: 555,
      step: 0,
    });
  });

  /* Текст користувача їде в ПІДПИСАНОМУ токені, а не в KV: історія розмови
     пишеться одним записом на фініші, і KV-розсинхрон (~60с без
     read-your-writes) не може її загубити. Кирилиця мусить пережити
     base64url-обіг (TextEncoder -> btoa -> atob -> TextDecoder). */
  it('текст користувача (кирилиця) переживає обіг і не піддається підробці', async () => {
    const userText = 'знайди лист від kontramarka і заплануй подію — «Івасюк», 19:30';
    const token = await mintRunToken(SECRET, { ...BASE, userText, nowMs: NOW });
    const res = await verifyRunToken(SECRET, token, NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.claims.userText).toBe(userText);

    // Крок зберігає текст — фініш на будь-якому кроці пише правильну історію.
    const next = await nextRunToken(SECRET, res.claims);
    const v2 = await verifyRunToken(SECRET, next, NOW);
    if (!v2.ok) throw new Error('unreachable');
    expect(v2.claims.userText).toBe(userText);
  });

  it('задовгий текст користувача обрізається в токені', async () => {
    const token = await mintRunToken(SECRET, { ...BASE, userText: 'я'.repeat(2000), nowMs: NOW });
    const res = await verifyRunToken(SECRET, token, NOW);
    if (!res.ok) throw new Error('unreachable');
    expect(String(res.claims.userText).length).toBe(500);
  });

  it('threadId=null (приватний чат) переживає обіг', async () => {
    const token = await mintRunToken(SECRET, {
      runId: 'r2',
      chatId: 9,
      threadId: null,
      nowMs: NOW,
    });
    const res = await verifyRunToken(SECRET, token, NOW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.claims.threadId).toBeNull();
  });

  /* ── Головна безпекова властивість ────────────────────────────────────────
     Токен підписаний ключем, виведеним із секрету, якого ХОСТ НЕ ЗНАЄ. Якби
     підпис ішов на LLM_HOST_SECRET, скомпрометований хост мінтив би власні
     прогони й качав пошту без жодного повідомлення власника. */
  it('токен, підписаний ІНШИМ секретом, відхиляється (хост не може змінтити прогін)', async () => {
    const forged = await mintRunToken('llm-host-secret-known-to-host', { ...BASE, nowMs: NOW });
    const res = await verifyRunToken(SECRET, forged, NOW);
    expect(res).toEqual({ ok: false, error: 'bad-signature' });
  });

  it('підроблені клейми при валідному підписі старого тіла відхиляються', async () => {
    const token = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    const [, sig] = token.split('.');
    // Зловмисник переписує chatId, лишаючи чужий підпис.
    const tampered =
      btoa(JSON.stringify({ v: 1, r: 'r1', c: 999, t: null, m: null, s: 0, e: NOW + 60_000 }))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '') +
      '.' +
      sig;
    const res = await verifyRunToken(SECRET, tampered, NOW);
    expect(res).toEqual({ ok: false, error: 'bad-signature' });
  });

  it('протухлий токен відхиляється', async () => {
    const token = await mintRunToken(SECRET, { ...BASE, nowMs: NOW, ttlMs: 1000 });
    expect(await verifyRunToken(SECRET, token, NOW + 999)).toMatchObject({ ok: true });
    expect(await verifyRunToken(SECRET, token, NOW + 1001)).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('сміття замість токена не кидає, а віддає bad-format', async () => {
    for (const bad of ['', 'no-dot', '.', 'a.', '.b', 'не-base64.не-base64', null, undefined, 42]) {
      const res = await verifyRunToken(SECRET, bad, NOW);
      expect(res.ok).toBe(false);
    }
  });

  it('порожній секрет не проходить (не вироджуємось у «підпис завжди валідний»)', async () => {
    const token = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    expect(await verifyRunToken('', token, NOW)).toEqual({ ok: false, error: 'no-secret' });
  });
});

describe('agent-run-core: кроки прогону', () => {
  it('nextRunToken інкрементує крок і зберігає runId та адресата', async () => {
    const t0 = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    const v0 = await verifyRunToken(SECRET, t0, NOW);
    expect(v0.ok).toBe(true);
    if (!v0.ok) return;

    const t1 = await nextRunToken(SECRET, v0.claims);
    const v1 = await verifyRunToken(SECRET, t1, NOW);
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.claims.step).toBe(1);
    expect(v1.claims.runId).toBe('r1a2b3c4');
    expect(v1.claims.chatId).toBe(42);
    expect(v1.claims.progressMsgId).toBe(555);
  });

  /* ⚠️ Регресія: якби nextRunToken поновлював дедлайн прогону, петля, що робить
     крок за кроком, продовжувала б собі життя нескінченно й AGENT_RUN_TTL_MS не
     значив би нічого. Дедлайн мусить лишатись прибитим до старту. */
  it('крок НЕ подовжує життя прогону', async () => {
    const t0 = await mintRunToken(SECRET, { ...BASE, nowMs: NOW, ttlMs: 10_000 });
    const v0 = await verifyRunToken(SECRET, t0, NOW);
    if (!v0.ok) throw new Error('unreachable');

    const t1 = await nextRunToken(SECRET, v0.claims, NOW + 5000);
    const v1 = await verifyRunToken(SECRET, t1, NOW + 5000);
    if (!v1.ok) throw new Error('unreachable');
    expect(v1.claims.deadlineMs).toBe(v0.claims.deadlineMs);
    // ...і через 10с той самий ланцюжок кроків уже мертвий.
    expect(await verifyRunToken(SECRET, t1, NOW + 10_001)).toEqual({
      ok: false,
      error: 'expired',
    });
  });

  it('ланцюжок вичерпується рівно на AGENT_MAX_STEPS', async () => {
    let token: string | null = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    let steps = 0;
    while (token) {
      const v = await verifyRunToken(SECRET, token, NOW);
      expect(v.ok).toBe(true);
      if (!v.ok) break;
      steps++;
      token = await nextRunToken(SECRET, v.claims, NOW);
    }
    expect(steps).toBe(AGENT_MAX_STEPS);
  });

  /* ── Звуження вікна реплею (знахідка security-рев'ю) ─────────────────────
     Токен самодостатній, тож той самий крок можна надіслати повторно, а кожен
     виклик виконує інструмент і повертає результат викликачеві. З життям кроку,
     рівним життю прогону, це давало б 5 хвилин необмеженого читання пошти на
     один легітимний токен. Крок мусить протухати НАБАГАТО раніше за прогін. */
  it('крок протухає своїм коротким вікном, хоча прогін ще живий', async () => {
    const token = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    expect(await verifyRunToken(SECRET, token, NOW + AGENT_STEP_TTL_MS - 1)).toMatchObject({
      ok: true,
    });
    // Крок мертвий...
    expect(await verifyRunToken(SECRET, token, NOW + AGENT_STEP_TTL_MS + 1)).toEqual({
      ok: false,
      error: 'expired',
    });
    // ...а прогін у цю мить іще ні (саме тому це два різні поля).
    expect(AGENT_STEP_TTL_MS).toBeLessThan(AGENT_RUN_TTL_MS);
  });

  it('наступний крок дістає СВІЖЕ вікно, але ніколи не переступає дедлайн прогону', async () => {
    const t0 = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    const v0 = await verifyRunToken(SECRET, t0, NOW);
    if (!v0.ok) throw new Error('unreachable');

    // Крок видано майже наприкінці життя прогону.
    const late = NOW + AGENT_RUN_TTL_MS - 5_000;
    const t1 = await nextRunToken(SECRET, v0.claims, late);
    const v1 = await verifyRunToken(SECRET, t1, late);
    if (!v1.ok) throw new Error('unreachable');

    expect(v1.claims.expMs).toBeGreaterThan(v0.claims.expMs); // вікно свіже
    expect(v1.claims.deadlineMs).toBe(v0.claims.deadlineMs); // дедлайн той самий
    expect(v1.claims.expMs).toBeLessThanOrEqual(v1.claims.deadlineMs); // і не за нього
  });

  it('прогін помирає за дедлайном, навіть якщо крок щойно видано', async () => {
    const t0 = await mintRunToken(SECRET, { ...BASE, nowMs: NOW });
    const v0 = await verifyRunToken(SECRET, t0, NOW);
    if (!v0.ok) throw new Error('unreachable');
    const past = NOW + AGENT_RUN_TTL_MS + 1;
    const t1 = await nextRunToken(SECRET, v0.claims, past);
    expect(await verifyRunToken(SECRET, t1, past)).toEqual({ ok: false, error: 'expired' });
  });

  it('токен із кроком за стелею відхиляється навіть із валідним підписом', async () => {
    const over = await mintRunToken(SECRET, { ...BASE, step: AGENT_MAX_STEPS, nowMs: NOW });
    expect(await verifyRunToken(SECRET, over, NOW)).toEqual({
      ok: false,
      error: 'too-many-steps',
    });
  });

  it('бюджети лишаються осмисленими', () => {
    expect(AGENT_MAX_STEPS).toBeGreaterThanOrEqual(4); // пошта -> тіло -> календар -> пропозиція
    expect(AGENT_RUN_TTL_MS).toBeGreaterThan(60_000); // інакше сенс переходу втрачено
  });
});

/* Durable Object для лічильника кроків (Фаза 4 аудиту).
 *
 * Токен самодостатній, тому РЕПЛЕЙНИЙ: поки він живий, той самий крок можна
 * надіслати вдруге, і кожен виклик виконає інструмент (читання пошти!) та
 * віддасть результат викликачеві. Досі це звужували двома запобіжниками —
 * коротким життям кроку і надгробком у KV, — але KV не має read-your-writes,
 * тож надгробок, покладений секунду тому, міг бути ще не видним. Рішення, яке
 * аудит називав правильним із самого початку: лічильник у DO, де read-modify-
 * write атомарний.
 *
 * Тут — чиста ухвала; сам DO і його сховище — у agent-run-do.test.ts. */
describe('agent-run-core: ухвала про крок (DO)', () => {
  const { decideStepClaim, agentRunDoName } = run as {
    decideStepClaim: (
      state: Record<string, unknown> | null,
      step: number,
    ) => { ok: boolean; error?: string; state?: Record<string, unknown> };
    agentRunDoName: (claims: Record<string, unknown>) => string;
  };

  it('перший крок прогону приймається й запамʼятовується', () => {
    const d = decideStepClaim(null, 0);
    expect(d.ok).toBe(true);
    expect(d.state).toMatchObject({ lastStep: 0 });
  });

  it('кроки йдуть уперед: 0 -> 1 -> 2', () => {
    let state: Record<string, unknown> | null = null;
    for (const step of [0, 1, 2]) {
      const d = decideStepClaim(state, step);
      expect(d.ok).toBe(true);
      state = d.state!;
    }
    expect(state).toMatchObject({ lastStep: 2 });
  });

  it('ПОВТОР того самого кроку відхиляється — це і є реплей', () => {
    const first = decideStepClaim(null, 3);
    expect(decideStepClaim(first.state!, 3)).toMatchObject({ ok: false, error: 'step-replayed' });
    // Так само й крок «назад»: легітимна петля лише зростає.
    expect(decideStepClaim(first.state!, 2)).toMatchObject({ ok: false, error: 'step-replayed' });
  });

  it('крок для завершеного прогону відхиляється (надгробок, тепер атомарний)', () => {
    expect(decideStepClaim({ lastStep: 1, finishedMs: NOW }, 2)).toMatchObject({
      ok: false,
      error: 'run-finished',
    });
  });

  it('крок поза стелею відхиляється незалежно від токена', () => {
    expect(decideStepClaim(null, AGENT_MAX_STEPS)).toMatchObject({
      ok: false,
      error: 'too-many-steps',
    });
    expect(decideStepClaim(null, -1).ok).toBe(false);
    expect(decideStepClaim(null, Number.NaN).ok).toBe(false);
  });

  it('імʼя DO включає дедлайн — колізія 8-символьного runId не воскресить чужий стан', () => {
    const a = agentRunDoName({ runId: 'r1a2b3c4', deadlineMs: NOW + 300_000 });
    const b = agentRunDoName({ runId: 'r1a2b3c4', deadlineMs: NOW + 999_000 });
    expect(a).toContain('r1a2b3c4');
    expect(a).not.toBe(b);
  });
});
