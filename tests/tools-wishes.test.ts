// wishes.* (етап 5 PR-3, 07 §4): create/update через policy (T0 з «↩»),
// delete T1, list із останньою/найнижчою ціною, search; гроші - копійки в
// payload_json, у відповіді - «3 299 грн»; purchase з url → PriceTrack одразу,
// без привʼязки - чесна примітка; status done зупиняє ланцюг; «↩» create
// видаляє рядок і ланцюг.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runWishesCreate,
  runWishesUpdate,
  runWishesList,
  runWishesSearch,
  runWishesDelete,
  findWish,
  toMinor,
} from '../web/core/tools/wishes.mjs';
import { applyPolicy, resolveUndo, resolveProposal } from '../web/core/policy/proposals.mjs';
import { readChainState } from '../web/core/chains/state.mjs';
import { TOOLS } from '../web/core/tools/index.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const MIGRATIONS = ['0001_base.sql', '0002_assistant.sql', '0004_ideas_travel.sql'];
const NOW = Date.parse('2026-09-07T07:00:00.000Z');

function setup(withBinding = true) {
  const d1 = d1FromSqlite(MIGRATIONS);
  const created: { id: string; params: unknown }[] = [];
  const events: { id: string; ev: unknown }[] = [];
  const env = workerEnv({
    DB: d1.stub,
    TELEGRAM_CHAT_ID: '555',
    TOPIC_ASSISTANT: '99',
    ...(withBinding
      ? {
          PRICE_TRACK: {
            create: async (o: { id: string; params: unknown }) => void created.push(o),
            get: async (id: string) => ({
              sendEvent: async (ev: unknown) => void events.push({ id, ev }),
            }),
          } as unknown as Env['PRICE_TRACK'],
        }
      : {}),
  });
  return { db: d1.db, env, created, events };
}

const URL_HD = 'https://rozetka.com.ua/ua/philips_hd9200/p1/';

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('реєстр і гроші', () => {
  it('wishes.* у TOOLS: list/search читання, create/update/delete write', () => {
    expect(TOOLS['wishes.list']!.write).toBeUndefined();
    expect(TOOLS['wishes.search']!.write).toBeUndefined();
    expect(TOOLS['wishes.create']!.write).toEqual({ kind: 'wishes.create' });
    expect(TOOLS['wishes.update']!.write).toEqual({ kind: 'wishes.update' });
    expect(TOOLS['wishes.delete']!.write).toEqual({ kind: 'wishes.delete' });
  });

  it('toMinor: число/рядок в основних одиницях → копійки; порожнє → null; сміття - помилка', () => {
    expect(toMinor(3299)).toBe(329900);
    expect(toMinor(12.99)).toBe(1299);
    expect(toMinor('3 299,50')).toBe(329950);
    expect(toMinor(null)).toBeNull();
    expect(toMinor('')).toBeNull();
    expect(() => toMinor('дорого')).toThrow(/не число/);
    expect(() => toMinor(-5)).toThrow(/не число/);
  });
});

describe('create', () => {
  it('purchase з url → рядок + PriceTrack (chains kind price, інстанс); текст для власника з target', async () => {
    const { env, db, created } = setup();
    const { result, prev } = await runWishesCreate(
      env,
      { type: 'purchase', title: 'Philips HD9200', url: URL_HD, target_price: 2999 },
      NOW,
      { chatId: 555, threadId: '99' },
    );
    expect(result).toMatchObject({
      type: 'purchase',
      title: 'Philips HD9200',
      target_price: '2 999 грн',
      tracking: true,
      text: 'Відстежую ціну «Philips HD9200» щодня; скажу при −5 % або ≤ 2 999 грн.',
    });
    expect(prev).toEqual({ id: result.id });
    const row = db
      .prepare('SELECT type, payload_json, status FROM wishes WHERE id = ?')
      .get(result.id);
    expect(row).toEqual({
      type: 'purchase',
      payload_json: JSON.stringify({ url: URL_HD, target_price: 299900, currency: 'UAH' }),
      status: 'active',
    });
    expect(created).toHaveLength(1);
    const chain = await readChainState(env, String(result.chain_id));
    expect(chain).toMatchObject({
      status: 'running',
      state: {
        wish_id: result.id,
        url: URL_HD,
        target_price: 299900,
        chat_id: 555,
        thread_id: '99',
      },
    });
  });

  it('purchase без url - примітка, без ланцюга; без привʼязки PRICE_TRACK - примітка, бажання записано', async () => {
    const { env, created } = setup();
    const noUrl = await runWishesCreate(env, { type: 'purchase', title: 'Щось' }, NOW);
    expect(noUrl.result.note).toMatch(/без url/);
    expect(created).toHaveLength(0);
    const { env: env2, db } = setup(false);
    const out = await runWishesCreate(env2, { type: 'purchase', title: 'X', url: URL_HD }, NOW);
    expect(out.result).toMatchObject({
      tracking: false,
      note: expect.stringContaining('PRICE_TRACK'),
    });
    expect(db.prepare('SELECT count(*) AS n FROM wishes').get()).toEqual({ n: 1 });
  });

  it('кривий type / порожній title / кривий url або валюта - відмова до запису', async () => {
    const { env, db } = setup();
    await expect(runWishesCreate(env, { type: 'car', title: 'x' }, NOW)).rejects.toThrow(/type/);
    await expect(runWishesCreate(env, { type: 'game', title: '  ' }, NOW)).rejects.toThrow(/title/);
    await expect(
      runWishesCreate(env, { type: 'purchase', title: 'x', url: 'javascript:alert(1)' }, NOW),
    ).rejects.toThrow(/http/);
    await expect(
      runWishesCreate(env, { type: 'purchase', title: 'x', url: 'not a url' }, NOW),
    ).rejects.toThrow(/некоректний/);
    await expect(
      runWishesCreate(env, { type: 'game', title: 'x', currency: 'гривня' }, NOW),
    ).rejects.toThrow(/ISO/);
    expect(db.prepare('SELECT count(*) AS n FROM wishes').get()).toEqual({ n: 0 });
  });

  it('через policy: T0 з «↩»; «↩» видаляє бажання і зупиняє ланцюг (подія stop)', async () => {
    const { env, db, events } = setup();
    const out = await applyPolicy(
      env,
      {
        kind: 'wishes.create',
        payload: { type: 'purchase', title: 'HD9200', url: URL_HD },
        threadId: '99',
        chatId: 555,
        tainted: false,
      },
      NOW,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    const id = (out.result as { id: string }).id;
    expect(await resolveUndo(env, out.undo!.id, NOW + 1000)).toEqual({
      ok: true,
      status: 'undone',
    });
    expect(db.prepare('SELECT count(*) AS n FROM wishes').get()).toEqual({ n: 0 });
    expect(events.map((e) => e.ev)).toEqual([{ type: 'price', payload: { action: 'stop' } }]);
    expect(await findWish(env, id)).toBeNull();
  });
});

describe('update / list / search / delete', () => {
  it('update: title/target/status; done зупиняє ланцюг; знімок для «↩» повертає поля', async () => {
    const { env, db, events } = setup();
    const { result: c } = await runWishesCreate(
      env,
      { type: 'purchase', title: 'HD9200', url: URL_HD, target_price: 3000 },
      NOW,
    );
    const { result, prev } = await runWishesUpdate(
      env,
      { id: c.id, title: 'Philips HD9200/90', target_price: 2800, status: 'done' },
      NOW + 1,
    );
    expect(result).toEqual({
      id: c.id,
      title: 'Philips HD9200/90',
      status: 'done',
      tracking_stopped: true,
    });
    expect(events).toHaveLength(1);
    expect(
      JSON.parse(
        String(db.prepare('SELECT payload_json FROM wishes WHERE id = ?').get(c.id)!.payload_json),
      ),
    ).toEqual({
      url: URL_HD,
      target_price: 280000,
      currency: 'UAH',
    });
    expect(prev).toEqual({
      id: c.id,
      title: 'HD9200',
      payload_json: JSON.stringify({ url: URL_HD, target_price: 300000, currency: 'UAH' }),
      status: 'active',
    });
    // Через policy з «↩»: поля назад.
    const out = await applyPolicy(
      env,
      { kind: 'wishes.update', payload: { id: c.id, title: 'Інше' }, tainted: false },
      NOW + 2,
    );
    if (out.mode !== 'executed') throw new Error(`mode ${out.mode}`);
    await resolveUndo(env, out.undo!.id, NOW + 3);
    expect(db.prepare('SELECT title FROM wishes WHERE id = ?').get(c.id)).toEqual({
      title: 'Philips HD9200/90',
    });
    await expect(runWishesUpdate(env, { id: 'nope' }, NOW)).rejects.toThrow(/немає/);
    await expect(runWishesUpdate(env, { id: c.id, status: 'lost' }, NOW)).rejects.toThrow(/status/);
  });

  it('findWish: id, точна назва або унікальна частина; кілька збігів - помилка з переліком, не «немає»', async () => {
    const { env } = setup();
    const a = await runWishesCreate(env, { type: 'game', title: 'Hades II' }, NOW);
    expect((await findWish(env, 'hades'))?.id).toBe(a.result.id);
    const b = await runWishesCreate(env, { type: 'game', title: 'Hades' }, NOW + 1);
    // Точний збіг виграє в частковому; неоднозначне - помилка, щоб модель
    // уточнила, а не створила дубль.
    expect((await findWish(env, 'Hades'))?.id).toBe(b.result.id);
    await expect(findWish(env, 'ades')).rejects.toThrow(/підходить до кількох бажань/);
    expect((await findWish(env, a.result.id))?.title).toBe('Hades II');
    expect(await findWish(env, 'нема такого')).toBeNull();
  });

  it('list: активні за замовчуванням, з останньою/найнижчою ціною; фільтри type/status/all; search за назвою', async () => {
    const { env, db } = setup();
    const p = await runWishesCreate(
      env,
      { type: 'purchase', title: 'HD9200', url: URL_HD, target_price: 3000 },
      NOW,
    );
    await runWishesCreate(env, { type: 'game', title: 'Hades II' }, NOW + 1);
    const done = await runWishesCreate(env, { type: 'game', title: 'Старе' }, NOW + 2);
    await runWishesUpdate(env, { id: done.result.id, status: 'done' }, NOW + 3);
    for (const [at, price] of [
      ['2026-09-01T00:00:00Z', 349900],
      ['2026-09-06T00:00:00Z', 329900],
    ] as const) {
      db.prepare(
        `INSERT INTO price_points (id, wish_id, at, source, price, currency, url, is_low) VALUES (?, ?, ?, 'Comfy', ?, 'UAH', 'https://comfy.ua/x', 1)`,
      ).run(`pp-${price}`, p.result.id, at, price);
    }
    const list = (await runWishesList(env, {})).result;
    expect(list.map((w) => w.title)).toEqual(['Hades II', 'HD9200']);
    expect(list[1]).toMatchObject({
      type: 'purchase',
      url: URL_HD,
      target_price: '3 000 грн',
      last_price: '3 299 грн',
      last_at: '2026-09-06',
      min_price: '3 299 грн',
    });
    expect(list[0]).toMatchObject({ last_price: null, min_price: null, target_price: null });
    expect(
      (await runWishesList(env, { type: 'game', status: 'all' })).result.map((w) => w.title),
    ).toEqual(['Старе', 'Hades II']);
    expect((await runWishesList(env, { status: 'done' })).result.map((w) => w.title)).toEqual([
      'Старе',
    ]);
    await expect(runWishesList(env, { type: 'x' })).rejects.toThrow(/type/);
    expect((await runWishesSearch(env, { q: 'hades' })).result.map((w) => w.title)).toEqual([
      'Hades II',
    ]);
  });

  it('delete: T1 через policy; після ✅ - рядок, ціни й ланцюг геть', async () => {
    const { env, db, events } = setup();
    const p = await runWishesCreate(env, { type: 'purchase', title: 'HD9200', url: URL_HD }, NOW);
    db.prepare(
      `INSERT INTO price_points (id, wish_id, at, source, price, currency, url, is_low) VALUES ('pp', ?, 'x', 's', 1, 'UAH', null, 1)`,
    ).run(p.result.id);
    const out = await applyPolicy(
      env,
      { kind: 'wishes.delete', payload: { id: p.result.id }, threadId: '99', tainted: false },
      NOW,
    );
    if (out.mode !== 'proposed') throw new Error(`mode ${out.mode}`);
    const res = await resolveProposal(env, { id: out.proposal.id, choice: 'ok' }, NOW + 1);
    expect(res).toMatchObject({
      ok: true,
      executed: true,
      result: { deleted: true, title: 'HD9200' },
    });
    expect(db.prepare('SELECT count(*) AS n FROM wishes').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM price_points').get()).toEqual({ n: 0 });
    expect(events).toHaveLength(1);
    expect((await readChainState(env, String(p.result.chain_id)))?.status).toBe('cancelled');
    await expect(runWishesDelete(env, { id: 'nope' }, NOW)).rejects.toThrow(/немає/);
  });
});
