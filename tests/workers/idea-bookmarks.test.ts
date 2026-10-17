/// <reference types="@cloudflare/vitest-plugin/types" />
import { env as runtimeEnv } from 'cloudflare:workers';
import { applyD1Migrations, reset } from 'cloudflare:test';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { changeBookmark, readBookmark } from '../../web/core/ideas/bookmark-store.mjs';

const env = runtimeEnv as Env & {
  DB: NonNullable<Env['DB']>;
  TEST_MIGRATIONS: import('cloudflare:test').D1Migration[];
};
beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});
afterEach(async () => {
  await reset();
});
const capture = () => ({
  op: 'create',
  commandId: crypto.randomUUID(),
  payload: { body: 'Локальна інтеграційна проба' },
});

it('commits a duplicate capture exactly once in real D1', async () => {
  const command = capture();
  const results = await Promise.all([changeBookmark(env, command), changeBookmark(env, command)]);
  expect(results[0]).toEqual(results[1]);
  expect(await env.DB.prepare('SELECT count(*) n FROM ideas').first()).toEqual({ n: 1 });
  expect(await env.DB.prepare('SELECT count(*) n FROM ideas_fts').first()).toEqual({ n: 1 });
  expect(await env.DB.prepare("SELECT value FROM counters WHERE name='ideas'").first()).toEqual({
    value: 1,
  });
}, 15000);

it('allows exactly one concurrent edit and keeps its FTS and receipt consistent', async () => {
  const receipt = await changeBookmark(env, capture());
  const { item } = await readBookmark(env, receipt.id);
  const commands = ['Перший варіант', 'Другий варіант'].map((body) => ({
    op: 'edit',
    id: item.id,
    version: item.version,
    commandId: crypto.randomUUID(),
    payload: { body },
  }));
  const results = await Promise.allSettled(commands.map((command) => changeBookmark(env, command)));
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const index = results.findIndex((result) => result.status === 'fulfilled');
  expect((await readBookmark(env, item.id)).item.body).toBe(commands[index]!.payload.body);
  expect(
    await env.DB.prepare('SELECT count(*) n FROM ideas_fts WHERE id=?').bind(item.id).first(),
  ).toEqual({ n: 1 });
  expect(await env.DB.prepare('SELECT count(*) n FROM idea_bookmark_commands').first()).toEqual({
    n: 2,
  });
}, 15000);

it('queues one concurrent formulation, charging quota once without invoking a model', async () => {
  const receipt = await changeBookmark(env, capture()),
    { item } = await readBookmark(env, receipt.id);
  const localEnv = { ...env, OPENAI_API_KEY: 'workers-test-key-never-sent' };
  const commands = [0, 1].map(() => ({
    op: 'formulate',
    id: item.id,
    version: item.version,
    commandId: crypto.randomUUID(),
    payload: {},
  }));
  const results = await Promise.allSettled(
    commands.map((command) => changeBookmark(localEnv, command)),
  );
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  expect(await env.DB.prepare('SELECT count(*) n FROM idea_formulations').first()).toEqual({
    n: 1,
  });
  expect(
    await env.DB.prepare(
      "SELECT sum(value) n FROM quota_counters WHERE key LIKE 'idea_formulations:%'",
    ).first(),
  ).toEqual({ n: 1 });
}, 15000);
