// Screenshot regression in a real browser. All API calls stay in this local fixture.
/* global window, document */
import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import {
  applyPlanCommand,
  emptyPlan,
  planView,
  planRecords,
} from '../web/core/motivation/model.mjs';
import { SAMPLE_STATS } from '../web/app/src/api/sample.ts';
import { SAMPLE_BRIEF } from '../web/app/src/api/briefing-sample.ts';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SVITANOK_PLAYWRIGHT_MODULE ?? 'playwright');
const out = resolve('node_modules/.cache/plan-task-editor-qa'),
  root = resolve('web/public');
await mkdir(out, { recursive: true });
const now = Date.parse('2026-10-17T08:19:00Z');
let state = applyPlanCommand(
  emptyPlan(),
  { op: 'settings', commandId: 'local-settings', payload: { enabled: true, penaltyPercent: 50 } },
  now,
).state;
let events = [],
  saved = null;
const draft = {
  title: 'Прокинутися та виїхати на роботу',
  criterion: 'Прокинутися о 7:00 і виїхати між 7:20 та 7:30',
  target: 1,
  unit: 'ранок',
  area: 'work',
  effort: 0,
  contribution: 1,
  challenge: 1,
  routine: true,
  estimateMinutes: 30,
  firstStep: 'Поставити будильник на 7:00',
  dueTime: '07:30',
  startTime: '07:00',
  timeSensitive: true,
  source: null,
  questions: [],
  xp: 35,
};
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  locale: 'en-US',
  timezoneId: 'America/Los_Angeles',
  isMobile: true,
  hasTouch: true,
});
const errors = [],
  checks = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(() => {
  window.Telegram = {
    WebApp: { initData: 'local-fixture-only', ready() {}, expand() {}, colorScheme: 'dark' },
  };
});
await page.route('**/*', async (route) => {
  const url = new URL(route.request().url());
  if (url.hostname !== 'svitanok.local') return route.fulfill({ status: 200, body: '' });
  if (url.pathname === '/briefing.json')
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(SAMPLE_BRIEF),
    });
  if (url.pathname.startsWith('/api/')) {
    let body = { ok: true };
    if (url.pathname === '/api/plan') {
      if (route.request().method() === 'POST') {
        const command = route.request().postDataJSON();
        if (command.op === 'suggest')
          return route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ ok: true, draft }),
          });
        try {
          const result = applyPlanCommand(state, command, now);
          state = result.state;
          events = [...result.events.reverse(), ...events];
          if (command.op === 'task-save') saved = command.payload;
          body = { ok: true, receipt: result.receipt, workspace: planView(state, now, events) };
        } catch (error) {
          return route.fulfill({
            status: 400,
            contentType: 'application/json',
            body: JSON.stringify({ ok: false, error: error.message, field: error.field }),
          });
        }
      } else body = { ok: true, workspace: planView(state, now, events) };
    } else if (url.pathname === '/api/stats') body = SAMPLE_STATS;
    else if (url.pathname === '/api/saved') body = { items: [], total: 0, cursor: null };
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }
  const file = resolve(
    root,
    '.' + (url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname),
  );
  if (!file.startsWith(root)) return route.abort();
  try {
    await route.fulfill({
      status: 200,
      contentType:
        {
          '.html': 'text/html',
          '.js': 'text/javascript',
          '.css': 'text/css',
          '.woff2': 'font/woff2',
          '.svg': 'image/svg+xml',
        }[extname(file)] ?? 'application/octet-stream',
      body: await readFile(file),
    });
  } catch {
    await route.fulfill({ status: 404, body: '' });
  }
});
async function fillClock(label, value) {
  const control = page.getByLabel(label + ': час', { exact: true });
  await control.fill(value);
  await control.press('Tab');
}
async function fits(label) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    label + ': document overflow',
  );
  assert.equal(
    await page
      .getByRole('dialog')
      .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
    false,
    label + ': dialog overflow',
  );
  checks.push(label);
}
try {
  await page.goto('https://svitanok.local/app/#/plan');
  await page.getByRole('button', { name: 'Додати першу задачу', exact: true }).click();
  await page.getByText('Допомогти заповнити з мого опису ✧', { exact: true }).click();
  await page
    .getByLabel('Опиши одну задачу', { exact: true })
    .fill('Прокинутись о 7:00, виїхати на роботу о 7:20–7:30');
  await page.getByRole('button', { name: 'Заповнити форму', exact: true }).click();
  await page.getByLabel('Що хочу зробити', { exact: true }).waitFor();
  await page.getByText(/Крайній час цього дня вже минув/).waitFor();
  assert.equal(
    await page.getByLabel('Крайній час · Київ: час', { exact: true }).inputValue(),
    '07:30',
  );
  await page
    .getByLabel('Додати цей блок у Google Calendar після прийняття', { exact: true })
    .check();
  await fillClock('Кінець блоку · Київ', '0800');
  await page.getByRole('button', { name: 'Зберегти в чернетку', exact: true }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: 'Блок закінчується після крайнього строку' })
    .waitFor();
  assert.equal(saved, null);
  await page.screenshot({
    path: resolve(out, 'specific-time-error.png'),
    fullPage: true,
    animations: 'disabled',
  });
  checks.push('invalid end explained before any API write');
  await page
    .getByLabel('Додати цей блок у Google Calendar після прийняття', { exact: true })
    .uncheck();
  assert.equal(await page.getByLabel('Кінець блоку · Київ: час', { exact: true }).count(), 0);
  await page.getByRole('button', { name: /На завтра/ }).click();
  await page.getByText('Уточнити оцінку', { exact: true }).click();
  await page.getByLabel('Обрана категорія XP', { exact: true }).selectOption('20');
  await page.getByText(/Твій вибір: 20 XP/).waitFor();
  for (const width of [320, 390, 768])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      for (const [name, anchor] of [
        ['time', 'Крайній час · Київ'],
        ['xp', 'Зусилля'],
        ['start', 'Запланований початок · Київ'],
      ]) {
        const element =
          name === 'xp'
            ? page.getByLabel(anchor, { exact: true })
            : page.locator(`[data-time-field="${anchor}"]`);
        await element.scrollIntoViewIfNeeded();
        await fits(`${width}/${theme}/${name}`);
        await page.screenshot({
          path: resolve(out, `${width}-${theme}-${name}.png`),
          animations: 'disabled',
        });
      }
    }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Закрити панель', exact: true }).click();
  await page.getByRole('button', { name: 'Додати першу задачу', exact: true }).click();
  assert.equal(await page.getByLabel('Що хочу зробити', { exact: true }).inputValue(), draft.title);
  assert.equal(await page.getByLabel('День задачі', { exact: true }).inputValue(), '2026-10-18');
  checks.push('closed editor restores text, chosen XP and next-day timing');
  await page.getByLabel('Зберегти як шаблон', { exact: true }).check();
  await page.getByRole('button', { name: 'Зберегти в чернетку', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(saved.calendar, false);
  assert.equal(saved.endAt, null);
  assert.equal(saved.xp, 20);
  assert.equal(saved.date, '2026-10-18');
  assert.equal(saved.startAt, '2026-10-18T04:00:00.000Z');
  assert.equal(saved.dueAt, '2026-10-18T04:30:00.000Z');
  assert.match(page.url(), /date=2026-10-18/);
  await page.getByRole('button', { name: 'Прийняти план', exact: true }).click();
  await page.getByRole('button', { name: 'Приймаю цей план', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(planRecords(state, 'task')[0].status, 'accepted');
  assert.equal(planRecords(state, 'template').length, 1);
  assert.equal(state.balance, 0);
  assert.deepEqual(errors, []);
  checks.push(
    'real core saves and accepts one task/template without XP charges or calendar writes',
  );
  await writeFile(
    resolve(out, 'result.json'),
    JSON.stringify(
      {
        checks,
        errors,
        saved,
        api: 'local model only',
        nativeLocale: 'en-US',
        deviceTimezone: 'America/Los_Angeles',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ checks: checks.length, errors, out }));
} catch (error) {
  await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true });
  console.log(
    JSON.stringify({
      url: page.url(),
      errors,
      text: (await page.locator('body').innerText()).slice(-5000),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
