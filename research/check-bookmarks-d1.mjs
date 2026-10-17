// Local Miniflare acceptance; no production binding, owner session or model call.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { changeBookmark, readBookmark } from '../web/core/ideas/bookmark-store.mjs';
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("local-only")}}',
    compatibilityDate: '2026-08-20',
    d1Databases: ['DB'],
  }),
);
try {
  const DB = await mf.getD1Database('DB');
  for (const name of [
    '0001_base.sql',
    '0002_assistant.sql',
    '0003_telemetry.sql',
    '0004_ideas_travel.sql',
    '0008_fts.sql',
    '0011_ideas_number.sql',
    '0044_idea_bookmarks.sql',
  ]) {
    const sql = await readFile(new URL('../web/core/migrations/' + name, import.meta.url), 'utf8');
    await DB.batch(
      sql
        .replace(/^--.*$/gm, '')
        .split(';')
        .filter((s) => s.trim())
        .map((s) => DB.prepare(s)),
    );
  }
  const env = {
    DB,
    OPENAI_API_KEY: 'local-unused',
    IDEA_FORMULATION: {
      create: () => {
        throw new Error('must not be called');
      },
    },
  };
  const command = {
    op: 'create',
    commandId: crypto.randomUUID(),
    payload: { body: 'Локальна перевірка повторів закладки' },
  };
  const captured = await Promise.all([changeBookmark(env, command), changeBookmark(env, command)]);
  assert.deepEqual(captured[0], captured[1]);
  assert.equal((await DB.prepare('SELECT count(*) n FROM ideas').first()).n, 1);
  assert.equal(
    (await DB.prepare("SELECT value FROM counters WHERE name='ideas'").first()).value,
    1,
  );
  const { item } = await readBookmark(env, captured[0].id);
  const commands = ['Перший текст', 'Другий текст'].map((body) => ({
    op: 'edit',
    commandId: crypto.randomUUID(),
    id: item.id,
    version: item.version,
    payload: { body },
  }));
  const edited = await Promise.allSettled(commands.map((c) => changeBookmark(env, c)));
  assert.equal(edited.filter((r) => r.status === 'fulfilled').length, 1);
  const winner = edited.findIndex((r) => r.status === 'fulfilled');
  const current = (await readBookmark(env, item.id)).item;
  assert.equal(current.body, commands[winner].payload.body);
  assert.equal(
    (await DB.prepare('SELECT body_md FROM ideas_fts WHERE id=?').bind(item.id).first()).body_md,
    current.body,
  );
  const requests = [0, 1].map(() => ({
    op: 'formulate',
    commandId: crypto.randomUUID(),
    id: item.id,
    version: current.version,
    payload: {},
  }));
  const formed = await Promise.allSettled(requests.map((c) => changeBookmark(env, c)));
  assert.equal(formed.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await DB.prepare('SELECT count(*) n FROM idea_formulations').first()).n, 1);
  assert.equal(
    (
      await DB.prepare(
        "SELECT sum(value) n FROM quota_counters WHERE key LIKE 'idea_formulations:%'",
      ).first()
    ).n,
    1,
  );
  console.log(
    JSON.stringify({
      runtime: 'local Miniflare D1',
      duplicateCapture: 'one record and number',
      concurrentEdits: edited.map((r) => r.status),
      concurrentFormulations: formed.map((r) => r.status),
      modelCalls: 0,
    }),
  );
} finally {
  await mf.dispose();
}
