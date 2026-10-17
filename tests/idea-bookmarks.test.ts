import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { d1FromSqlite } from './helpers/d1.js';
import { workerEnv } from './helpers/env.js';
import { buildInitData } from './helpers/init-data.js';
import {
  changeBookmark,
  readBookmark,
  readBookmarks,
  startBookmarkFormulation,
  finishBookmarkFormulation,
} from '../web/core/ideas/bookmark-store.mjs';
import {
  bookmarkCommand,
  bookmarkHash,
  bookmarkMeta,
  changedBookmarkTags,
  validateIdeaBrief,
  ideaGptPrompt,
} from '../web/core/ideas/bookmark-model.mjs';
import { IDEA_AREAS, ideaEcosystemContext } from '../web/core/ideas/ecosystem.mjs';
import {
  generateIdeaBrief,
  runBookmarkFormulation,
  IdeaFormulation,
} from '../web/core/ideas/formulation.mjs';
import {
  runIdeasCreate,
  runIdeasUpdate,
  runIdeasSearch,
  runIdeasDelete,
  findIdea,
} from '../web/core/tools/ideas.mjs';
import { handleBookmarks } from '../web/api-bookmarks.mjs';
import { buildBackupDocument, restoreSql } from '../web/core/backup/core.mjs';
import { ALL_MIGRATIONS } from './helpers/migrations.js';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const BRIEF = {
  title: 'Показати умови винагороди',
  problem: 'Покупку важко зіставити з майбутніми платежами.',
  outcome: 'Винагорода має зрозумілу умову доступності.',
  userFlow: ['Відкрити винагороду й переглянути умови.'],
  minimumScope: ['Використати наявні дані фінансів.'],
  futureScope: [],
  integrations: ['План і фінанси мають спільні правила.'],
  implementation: ['Перевірити актуальний код перед зміною.'],
  acceptance: ['Невідомий залишок не позначено як достатній.'],
  risks: ['Прогноз не є фактичним доходом.'],
  questions: ['Який запас потрібно залишати?'],
};
let d1: ReturnType<typeof d1FromSqlite>;
let env: Env;
const command = (op: string, payload: Record<string, unknown> = {}, extra = {}) => ({
  op,
  payload,
  commandId: crypto.randomUUID(),
  ...extra,
});
async function create(body = 'Хочу бачити майбутні платежі поруч із винагородою') {
  const c = command('create', { body, area: 'plan', kind: 'improvement' });
  const receipt = await changeBookmark(env, c, NOW);
  return { c, receipt, ...(await readBookmark(env, receipt.id)) };
}
async function write(id: string, op: string, payload: Record<string, unknown> = {}, at = NOW) {
  const { item } = await readBookmark(env, id);
  const c = command(op, payload, { id, version: item.version });
  return { c, receipt: await changeBookmark(env, c, at) };
}
async function queued(id: string) {
  return (await write(id, 'formulate')).receipt.formulationId as string;
}
async function running(id: string) {
  const requestId = await queued(id);
  d1.db.prepare("UPDATE idea_formulations SET status='running' WHERE id=?").run(requestId);
  return requestId;
}
const step = () => ({
  do: vi.fn(async (_name: string, options: unknown, callback?: () => Promise<unknown>) =>
    callback ? callback() : (options as () => Promise<unknown>)(),
  ),
});

beforeEach(() => {
  d1 = d1FromSqlite(
    [
      '0001_base.sql',
      '0002_assistant.sql',
      '0003_telemetry.sql',
      '0004_ideas_travel.sql',
      '0008_fts.sql',
      '0011_ideas_number.sql',
      '0044_idea_bookmarks.sql',
    ],
    { atomicBatch: true },
  );
  env = workerEnv({
    DB: d1.stub,
    OPENAI_API_KEY: 'local-test-key',
    TELEGRAM_BOT_TOKEN: 'test-token',
    TELEGRAM_OWNER_USER_ID: '42',
    TELEGRAM_ALLOWED_USER_IDS: '43',
    IDEA_FORMULATION: {
      create: vi.fn().mockResolvedValue({}),
      get: vi.fn().mockRejectedValue(new Error('absent')),
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  d1.db.close();
});

describe('bookmarks share the assistant registry without losing edits', () => {
  it('atomically captures one note, retries reordered input and exposes it through existing tools/FTS', async () => {
    const { c, receipt, item } = await create();
    expect(item).toMatchObject({ number: 1, status: 'нова', area: 'plan', kind: 'improvement' });
    expect(
      await changeBookmark(
        env,
        {
          payload: { kind: 'improvement', area: 'plan', body: c.payload.body },
          commandId: c.commandId,
          op: 'create',
        },
        NOW + 1,
      ),
    ).toEqual(receipt);
    expect(d1.db.prepare('SELECT COUNT(*) n FROM ideas').get()).toEqual({ n: 1 });
    expect(d1.db.prepare("SELECT value FROM counters WHERE name='ideas'").get()).toEqual({
      value: 1,
    });
    expect((await findIdea(env, '#1'))?.body_md).toBe(c.payload.body);
    expect((await runIdeasSearch(env, { q: 'винагородою' })).result).toHaveLength(1);
    expect(await readBookmarks(env, { q: 'винагородою' })).toMatchObject({
      items: [{ id: receipt.id }],
    });
    await expect(
      changeBookmark(env, { ...c, payload: { body: 'Інший запис' } }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('rolls back counter, FTS and events together when a write fails', async () => {
    d1.db.exec(
      "CREATE TRIGGER reject_capture BEFORE INSERT ON idea_events BEGIN SELECT RAISE(ABORT,'test failure'); END;",
    );
    await expect(create()).rejects.toThrow('test failure');
    expect(d1.db.prepare('SELECT COUNT(*) n FROM ideas_fts').get()).toEqual({ n: 0 });
    expect(d1.db.prepare('SELECT COUNT(*) n FROM ideas').get()).toEqual({ n: 0 });
    expect(d1.db.prepare("SELECT value FROM counters WHERE name='ideas'").get()).toEqual({
      value: 0,
    });
  });
  it('preserves unrelated tags, synchronizes search and detects legacy edits with the same timestamp', async () => {
    const { item } = await create();
    await runIdeasUpdate(
      env,
      { id: item.id, tags: ['personal', 'surface:plan', 'kind:idea'] },
      NOW,
    );
    const before = await readBookmark(env, item.id);
    await write(item.id, 'edit', {
      title: 'Новий заголовок',
      body: 'Оновлена деталь',
      area: 'finance',
      kind: 'bug',
    });
    expect((await findIdea(env, item.id))?.tags_json).toBe(
      '["personal","surface:finance","kind:bug"]',
    );
    expect((await readBookmarks(env, { q: 'деталь' })).items).toHaveLength(1);
    expect((await readBookmarks(env, { q: 'винагородою' })).items).toHaveLength(0);
    await expect(
      changeBookmark(
        env,
        command('edit', { body: 'Втрачена зміна' }, { id: item.id, version: before.item.version }),
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect((await findIdea(env, item.id))?.body_md).toBe('Оновлена деталь');
  });
  it('detects a competing edit inside the atomic transaction and leaves no command receipt', async () => {
    const { item } = await create();
    const original = d1.stub.batch;
    d1.stub.batch = async (statements) => {
      d1.stub.batch = original;
      d1.db.prepare('UPDATE ideas SET body_md=? WHERE id=?').run('Правка з Telegram', item.id);
      return original(statements);
    };
    const c = command('edit', { body: 'Моя правка' }, { id: item.id, version: item.version });
    await expect(changeBookmark(env, c, NOW)).rejects.toMatchObject({ status: 409 });
    expect(
      d1.db.prepare('SELECT id FROM idea_bookmark_commands WHERE id=?').get(c.commandId),
    ).toBeUndefined();
    expect((await findIdea(env, item.id))?.body_md).toBe('Правка з Telegram');
  });
  it('includes legacy Svitanok ideas, isolates other domains and paginates equal timestamps without skips', async () => {
    await runIdeasCreate(env, { title: 'Чужий напрям', domain: 'побут' }, NOW);
    for (let i = 0; i < 32; i++) await create(`Думка ${i}`);
    const first = await readBookmarks(env);
    const second = await readBookmarks(env, { cursor: first.cursor! });
    expect(first.items).toHaveLength(30);
    expect(second.items).toHaveLength(2);
    expect(new Set([...first.items, ...second.items].map((r) => r.id)).size).toBe(32);
    const id = first.items[0]!.id;
    await write(id, 'status', { status: 'зроблено' });
    expect((await readBookmarks(env, { status: 'зроблено' })).items).toHaveLength(1);
    expect((await readBookmarks(env, { status: 'all' })).cursor).toBeTruthy();
    expect((await readBookmarks(env)).items.some((r) => r.id === id)).toBe(false);
    await expect(readBookmark(env, 'not-found')).rejects.toMatchObject({ status: 404 });
  });
  it.each([
    { q: 'x'.repeat(121) },
    { status: 'unknown' },
    { cursor: '{' },
    { cursor: '{"at":false,"id":1}' },
  ])('rejects invalid list filters %j', async (query) => {
    await expect(readBookmarks(env, query)).rejects.toMatchObject({ status: 400 });
  });
  it('keeps approved plans while archiving, and supports the assistant hard-delete with FK cascade', async () => {
    const { item } = await create();
    await write(item.id, 'status', { status: 'погоджено' });
    expect((await findIdea(env, item.id))?.plan_approved_at).toBe(new Date(NOW).toISOString());
    await queued(item.id);
    await runIdeasDelete(env, { id: item.id });
    expect(d1.db.prepare('SELECT COUNT(*) n FROM idea_formulations').get()).toEqual({ n: 0 });
    expect((await readBookmarks(env, { status: 'all' })).items).toHaveLength(0);
  });
});

describe('background formulation is explicit, versioned and recoverable', () => {
  it('shares a completed proposal with the assistant while retaining the source and copyable GPT prompt', async () => {
    const { item } = await create();
    const request = await queued(item.id),
      steps = step();
    const generate = vi.fn().mockResolvedValue(BRIEF);
    expect(await runBookmarkFormulation(env, request, steps, generate)).toEqual({
      status: 'ready',
    });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(steps.do).toHaveBeenCalledWith(
      'formulate',
      { retries: { limit: 0, delay: 0 }, timeout: '2 minutes' },
      expect.any(Function),
    );
    const after = await readBookmark(env, item.id),
      f = after.formulations[0]!;
    expect(after.item.body).toBe(item.body);
    expect(after.item.sourceHash).toBe(item.sourceHash);
    expect(after.item.status).toBe('план готовий');
    expect(f).toMatchObject({ status: 'ready', result: BRIEF, published: true });
    expect(f.prompt).toContain(item.body);
    expect(f.prompt).toContain('Критерії готовності');
    expect((await findIdea(env, item.id))?.plan_md).toContain(BRIEF.acceptance[0]);
    await finishBookmarkFormulation(env, request, BRIEF);
    expect((await readBookmark(env, item.id)).formulations).toHaveLength(1);
    expect(await runBookmarkFormulation(env, request, step(), generate)).toEqual({
      status: 'inactive',
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('keeps a result as an older version when the owner edits during processing', async () => {
    const { item } = await create(),
      request = await running(item.id);
    await write(item.id, 'edit', {
      body: 'Уточнення під час обробки',
      area: 'plan',
      kind: 'improvement',
    });
    await finishBookmarkFormulation(env, request, BRIEF);
    const after = await readBookmark(env, item.id);
    expect(after.item).toMatchObject({
      body: 'Уточнення під час обробки',
      status: 'нова',
      plan: null,
    });
    expect(after.formulations[0]).toMatchObject({
      status: 'ready',
      published: false,
      source: { body: item.body },
    });
    expect(after.formulations[0]!.sourceHash).not.toBe(after.item.sourceHash);
  });
  it.each(['погоджено', 'у роботі', 'зроблено', 'відхилено'])(
    'does not replace an existing %s plan',
    async (status) => {
      const { item } = await create();
      await runIdeasUpdate(env, { id: item.id, status, plan_md: 'Погоджений план' }, NOW);
      const request = await running(item.id);
      await finishBookmarkFormulation(env, request, BRIEF);
      expect((await readBookmark(env, item.id)).item).toMatchObject({
        status,
        plan: 'Погоджений план',
      });
      expect((await readBookmark(env, item.id)).formulations[0]!.published).toBe(false);
    },
  );
  it('preserves deferred status and treats stale/nonrunning work honestly', async () => {
    const { item } = await create();
    await write(item.id, 'status', { status: 'відкладено' });
    const request = await running(item.id);
    await finishBookmarkFormulation(env, request, BRIEF);
    expect((await readBookmark(env, item.id)).item.status).toBe('відкладено');
    const queuedId = await queued(item.id);
    await expect(finishBookmarkFormulation(env, queuedId, BRIEF)).rejects.toMatchObject({
      status: 409,
    });
    expect(await finishBookmarkFormulation(env, 'missing', BRIEF)).toBeUndefined();
    expect(await runBookmarkFormulation(workerEnv(), 'none', step())).toEqual({
      status: 'unavailable',
    });
  });
  it('blocks overlapping requests and enforces a transactional daily quota without blocking manual notes', async () => {
    const { item } = await create();
    await queued(item.id);
    await expect(queued(item.id)).rejects.toMatchObject({ status: 409 });
    d1.db.exec("UPDATE idea_formulations SET status='failed'");
    for (let i = 1; i < 15; i++) {
      await queued(item.id);
      d1.db.exec("UPDATE idea_formulations SET status='failed'");
    }
    await expect(queued(item.id)).rejects.toMatchObject({ status: 429 });
    expect(d1.db.prepare('SELECT COUNT(*) n FROM idea_formulations').get()).toEqual({ n: 15 });
    await write(item.id, 'edit', { body: 'Ручні уточнення доступні після ліміту' });
    expect((await readBookmark(env, item.id)).item.body).toContain('Ручні уточнення');
    expect(
      (await write(item.id, 'formulate', {}, NOW + 86400000)).receipt.formulationId,
    ).toBeTruthy();
  });
  it('rejects a competing legacy analysis and unavailable paid configuration while allowing capture', async () => {
    const { item } = await create();
    await write(item.id, 'status', { status: 'в аналізі' });
    await expect(queued(item.id)).rejects.toMatchObject({ status: 409 });
    await write(item.id, 'status', { status: 'нова' });
    env.OPENAI_API_KEY = undefined;
    await expect(queued(item.id)).rejects.toMatchObject({ status: 503 });
    await create('Збереження працює без AI');
    expect((await readBookmarks(env)).items).toHaveLength(2);
  });
  it('recovers an uncertain workflow dispatch by its stable ID and never replays failed paid work', async () => {
    const { item } = await create(),
      request = await queued(item.id);
    const status = vi.fn().mockResolvedValue({ status: 'running' });
    env.IDEA_FORMULATION = {
      create: vi.fn().mockRejectedValue(new Error('lost ack')),
      get: vi.fn().mockResolvedValue({ status }),
    };
    await startBookmarkFormulation(env, request);
    expect(status).toHaveBeenCalledTimes(1);
    const generate = vi.fn().mockRejectedValue(new Error('provider timeout'));
    expect(await runBookmarkFormulation(env, request, step(), generate)).toEqual({
      status: 'failed',
    });
    await startBookmarkFormulation(env, request);
    expect(env.IDEA_FORMULATION.create).toHaveBeenCalledTimes(1);
    expect((await readBookmark(env, item.id)).formulations[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('Початковий запис збережено'),
    });
    expect((await readBookmark(env, item.id)).item.body).toBe(item.body);
    await expect(finishBookmarkFormulation(env, request, BRIEF)).rejects.toMatchObject({
      status: 409,
    });
  });
  it('marks failed dispatch without overwriting a concurrent running claim', async () => {
    const { item } = await create(),
      request = await queued(item.id);
    env.IDEA_FORMULATION = {
      create: vi.fn().mockRejectedValue(new Error('absent')),
      get: vi.fn().mockRejectedValue(new Error('absent')),
    };
    await startBookmarkFormulation(env, request);
    expect((await readBookmark(env, item.id)).formulations[0]!.status).toBe('failed');
    const next = await queued(item.id);
    env.IDEA_FORMULATION.create = vi.fn(async () => {
      d1.db.prepare("UPDATE idea_formulations SET status='running' WHERE id=?").run(next);
      throw new Error('lost ack');
    });
    await startBookmarkFormulation(env, next);
    expect((await readBookmark(env, item.id)).formulations.find((r) => r.id === next)!.status).toBe(
      'running',
    );
    await startBookmarkFormulation(env, 'missing');
  });
  it('pages all versions and prevents stale custom-prompt saves', async () => {
    const { item } = await create();
    for (let i = 0; i < 12; i++) {
      const request = await running(item.id);
      await finishBookmarkFormulation(env, request, { ...BRIEF, title: `Варіант ${i}` }, NOW);
    }
    const first = await readBookmark(env, item.id),
      second = await readBookmark(env, item.id, first.historyCursor!);
    expect(first.formulations).toHaveLength(10);
    expect(second.formulations).toHaveLength(2);
    expect(new Set([...first.formulations, ...second.formulations].map((f) => f.id)).size).toBe(12);
    const f = first.formulations[0]!;
    const payload = { formulationId: f.id, revision: f.revision, prompt: 'Моє точне формулювання' };
    await write(item.id, 'save-prompt', payload);
    await expect(write(item.id, 'save-prompt', payload)).rejects.toMatchObject({ status: 409 });
    expect((await readBookmark(env, item.id)).formulations[0]).toMatchObject({
      prompt: payload.prompt,
      customPrompt: true,
      revision: f.revision + 1,
    });
    for (const before of ['{', '{}'])
      await expect(readBookmark(env, item.id, before)).rejects.toMatchObject({ status: 400 });
  });
});

describe('formulation output and ecosystem context', () => {
  it('restores source, versions, edited prompts and receipts, without replaying pending paid work', async () => {
    const { item } = await create(),
      first = await running(item.id);
    await finishBookmarkFormulation(env, first, BRIEF);
    const f = (await readBookmark(env, item.id)).formulations[0]!;
    await write(item.id, 'save-prompt', {
      formulationId: first,
      revision: f.revision,
      prompt: 'Власний запит',
    });
    const active = await running(item.id);
    const tables = Object.fromEntries(
      ['ideas', 'idea_formulations', 'idea_bookmark_commands'].map((table) => [
        table,
        d1.db.prepare(`SELECT * FROM ${table}`).all(),
      ]),
    );
    const doc = buildBackupDocument({ createdMs: NOW, envName: 'test', tables, kv: {} });
    const target = d1FromSqlite(ALL_MIGRATIONS);
    try {
      target.db.exec(restoreSql(doc));
      expect(target.db.prepare('SELECT body_md FROM ideas').get()).toEqual({ body_md: item.body });
      expect(
        target.db
          .prepare('SELECT status,custom_prompt FROM idea_formulations WHERE id=?')
          .get(first),
      ).toEqual({ status: 'ready', custom_prompt: 'Власний запит' });
      expect(
        target.db.prepare('SELECT status,error FROM idea_formulations WHERE id=?').get(active),
      ).toMatchObject({ status: 'failed', error: expect.stringContaining('відновленням') });
      expect(target.db.prepare('SELECT COUNT(*) n FROM idea_bookmark_commands').get()).toEqual(
        d1.db.prepare('SELECT COUNT(*) n FROM idea_bookmark_commands').get(),
      );
    } finally {
      target.db.close();
    }
  });
  it('uses real module paths and labels the limits of product context', () => {
    for (const area of IDEA_AREAS)
      for (const path of area.sources) expect(existsSync(resolve(path)), path).toBe(true);
    expect(ideaEcosystemContext().scope).toContain('не live-доступ');
    expect(ideaGptPrompt({ title: 'Думка', body: 'Мій початковий текст' }, BRIEF, 'v1')).toContain(
      'Мій початковий текст',
    );
    expect(bookmarkMeta({ tags_json: '{' })).toEqual({ area: 'ecosystem', kind: 'idea' });
    expect(changedBookmarkTags({ tags_json: '{}' }, { area: 'plan', kind: 'bug' })).toContain(
      'surface:plan',
    );
  });
  it('sends only the source and curated context with strict structured output and no tools/storage', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'completed',
          output: [{ content: [{ type: 'output_text', text: JSON.stringify(BRIEF) }] }],
          usage: { input_tokens: 300, output_tokens: 400 },
        }),
      ),
    );
    expect(
      await generateIdeaBrief(
        env,
        { title: 'Назва', body_md: 'Текст', secret: 'SHOULD-NOT-SEND' },
        fetcher,
      ),
    ).toEqual(BRIEF);
    const body = JSON.parse(fetcher.mock.calls[0]![1].body);
    expect(body).toMatchObject({
      store: false,
      text: { format: { type: 'json_schema', strict: true } },
    });
    expect(body.tools).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('SHOULD-NOT-SEND');
    expect(JSON.parse(body.input).idea).toMatchObject({ title: 'Назва', body: 'Текст' });
  });
  it.each([
    { status: 'incomplete', output: [] },
    { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: 'no' }] }] },
    { status: 'completed', output: [{ content: [{ type: 'output_text', text: '{}' }] }] },
  ])('rejects incomplete, refused or malformed output %j', async (output) => {
    await expect(
      generateIdeaBrief(env, {}, vi.fn().mockResolvedValue(new Response(JSON.stringify(output)))),
    ).rejects.toThrow();
  });
  it('rejects HTTP errors and missing API key', async () => {
    await expect(
      generateIdeaBrief(env, {}, vi.fn().mockResolvedValue(new Response('{}', { status: 429 }))),
    ).rejects.toThrow();
    env.OPENAI_API_KEY = undefined;
    const fetcher = vi.fn();
    await expect(generateIdeaBrief(env, {}, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    null,
    [],
    { ...BRIEF, extra: true },
    { ...BRIEF, title: ' ' },
    { ...BRIEF, acceptance: [] },
    { ...BRIEF, risks: [3] },
    { ...BRIEF, userFlow: Array(9).fill('a') },
  ])('validates a reviewable brief %j', (value) => {
    expect(() => validateIdeaBrief(value)).toThrow();
  });
  it.each([
    null,
    [],
    {},
    { op: 'create', commandId: crypto.randomUUID(), payload: [] },
    command('create', { body: '' }),
    command('create', { body: 'x', area: 'wrong' }),
    command('status', { status: 'x' }, { id: 'x', version: 'a'.repeat(64) }),
    command(
      'save-prompt',
      { formulationId: 'x', revision: -1 },
      { id: 'x', version: 'a'.repeat(64) },
    ),
    command('edit', { body: 'x' }),
  ])('rejects invalid commands %j', (raw) => {
    expect(() => bookmarkCommand(raw)).toThrow();
  });
  it('hashes equivalent key orders equally and forwards the workflow entrypoint payload', async () => {
    expect(await bookmarkHash({ b: [1], a: 2 })).toBe(await bookmarkHash({ a: 2, b: [1] }));
    const workflow = new IdeaFormulation({}, workerEnv());
    expect(await workflow.run({ payload: { requestId: 'missing' } }, step())).toEqual({
      status: 'unavailable',
    });
  });
});

describe('owner-only bookmarks HTTP surface', () => {
  async function request(method = 'GET', body?: string, owner = 42, path = '') {
    return handleBookmarks(
      new Request('https://local.test/api/bookmarks' + path, {
        method,
        headers: { 'X-Telegram-Init-Data': await buildInitData(owner, 'test-token') },
        ...(body === undefined ? {} : { body }),
      }),
      env,
    );
  }
  it('rejects unsigned and secondary users before reading or saving a body', async () => {
    const unsigned = new Request('https://local.test/api/bookmarks', { method: 'POST', body: '{' });
    const read = vi.spyOn(unsigned, 'json');
    expect((await handleBookmarks(unsigned, env)).status).toBe(401);
    expect(read).not.toHaveBeenCalled();
    expect((await request('GET', undefined, 43)).status).toBe(403);
    expect((await request('DELETE')).status).toBe(405);
    expect(d1.db.prepare('SELECT COUNT(*) n FROM ideas').get()).toEqual({ n: 0 });
  });
  it('accepts UTF-8 notes, loads detail/search and dispatches only explicit formulation', async () => {
    const response = await request(
      'POST',
      JSON.stringify(command('create', { body: 'ї'.repeat(20000) })),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const created = (await response.json()) as Awaited<ReturnType<typeof readBookmark>>;
    expect(created.item.body).toHaveLength(20000);
    expect((await request('GET', undefined, 42, '?id=' + created.item.id)).status).toBe(200);
    expect((await request('GET', undefined, 42, '?q=ї')).status).toBe(200);
    expect(env.IDEA_FORMULATION!.create).not.toHaveBeenCalled();
    const formed = await request(
      'POST',
      JSON.stringify(
        command('formulate', {}, { id: created.item.id, version: created.item.version }),
      ),
    );
    const payload = (await formed.json()) as Awaited<ReturnType<typeof readBookmark>> & {
      receipt: { formulationId: string };
    };
    expect(payload.formulations[0]!.status).toBe('queued');
    expect(env.IDEA_FORMULATION!.create).toHaveBeenCalledWith({
      id: payload.receipt.formulationId,
      params: { requestId: payload.receipt.formulationId },
    });
  });
  it('rejects malformed, oversized and unknown inputs without a successful receipt', async () => {
    expect((await request('POST', '{')).status).toBe(400);
    expect((await request('POST', JSON.stringify({ body: 'x'.repeat(270000) }))).status).toBe(413);
    expect((await request('GET', undefined, 42, '?id=' + 'x'.repeat(101))).status).toBe(400);
    expect((await request('GET', undefined, 42, '?id=missing')).status).toBe(404);
    const unavailable = await handleBookmarks(
      new Request('https://local.test/api/bookmarks', {
        headers: { 'X-Telegram-Init-Data': await buildInitData(42, 'test-token') },
      }),
      { ...env, DB: undefined },
    );
    expect(unavailable.status).toBe(503);
  });
  it('returns an acknowledged receipt even if the following detail refresh fails', async () => {
    const original = d1.stub.batch;
    d1.stub.batch = async (statements) => {
      const result = await original(statements);
      d1.db.exec('DROP TABLE idea_formulations');
      return result;
    };
    const response = await request(
      'POST',
      JSON.stringify(command('create', { body: 'Запис є, повтор не потрібний' })),
    );
    expect(await response.json()).toMatchObject({
      ok: true,
      refreshRequired: true,
      receipt: { id: expect.any(String) },
    });
    expect(d1.db.prepare('SELECT COUNT(*) n FROM ideas').get()).toEqual({ n: 1 });
  });
});
