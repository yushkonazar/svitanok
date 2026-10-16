// Local-only browser acceptance. No owner session, API or real commitments.
// SVITANOK_PLAYWRIGHT_MODULE may point to the bundled Playwright installation.
/* global document,window */
import { createRequire } from 'node:module';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { emptyPlan, applyPlanCommand, personalPlanDate } from '../web/core/motivation/model.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SVITANOK_PLAYWRIGHT_MODULE ?? 'playwright');
const out = resolve('node_modules/.cache/plan-qa');
await mkdir(out, { recursive: true });
let state = emptyPlan(),
  events = [],
  counter = 0;
const now = Date.now() - 3600000,
  date = personalPlanDate(state.settings, now);
function command(op, payload = {}, id) {
  const next = applyPlanCommand(
    state,
    { op, payload, id, commandId: `qa-command-${++counter}` },
    now,
  );
  state = next.state;
  events = [...next.events.reverse(), ...events];
  return next.receipt.id;
}
command('settings', { enabled: true });
state.balance = 120;
const rewardId = command('reward-save', {
  title: 'Apple Watch',
  price: 2500,
  scale: 'large',
  primary: true,
  why: 'Стабільний робочий ритм і перевірений бюджет',
  gate: {
    kind: 'purchase',
    confirmed: false,
    note: 'Потрібно визначити модель, повну ціну, графік виплат і вільний залишок.',
  },
});
const goalId = command('goal-save', {
  title: 'Завершити навчальний модуль',
  horizon: 'week',
  dueDate: date,
  why: 'Закріпити знання практикою',
});
const sql = command('task-save', {
  date,
  title: 'Практика SQL',
  criterion: 'Розв’язати 5 задач самостійно',
  target: 5,
  xp: 35,
  unit: 'задач',
  firstStep: 'Після сніданку відкрити першу задачу',
  goalId,
  rewardId,
});
command('task-save', {
  date,
  title: 'Почати роботу в обраний час',
  criterion: 'Вийти на роботу до погодженого часу',
  target: 1,
  xp: 35,
  deadlineKind: 'time',
  dueAt: new Date(Date.now() + 3 * 3600000).toISOString(),
  timeSensitive: true,
  rewardId,
});
command('task-save', {
  date,
  title: 'Завершити домашню справу',
  criterion: 'Розібрати й упорядкувати робоче місце',
  xp: 10,
  estimateMinutes: 20,
});
command('accept', { date });
command('report', { units: 3 }, sql);
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.addInitScript(
  ({ state, events }) =>
    localStorage.setItem('svitanok:plan-demo:v1', JSON.stringify({ state, events })),
  { state, events },
);
if (process.env.SVITANOK_PLAN_LOCAL_BUILD === '1') {
  const root = resolve('web/public');
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname !== 'svitanok.local') return route.fulfill({ status: 200, body: '' });
    const file = resolve(
      root,
      `.${url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname}`,
    );
    if (!file.startsWith(root)) return route.abort();
    const contentType =
      {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8',
        '.json': 'application/json',
        '.woff2': 'font/woff2',
        '.svg': 'image/svg+xml',
      }[extname(file)] ?? 'application/octet-stream';
    try {
      await route.fulfill({ status: 200, contentType, body: await readFile(file) });
    } catch {
      await route.fulfill({ status: 404, body: '' });
    }
  });
}
await page.goto(
  process.env.SVITANOK_PLAN_LOCAL_BUILD === '1'
    ? 'https://svitanok.local/app/#/plan'
    : (process.env.SVITANOK_PLAN_PREVIEW_URL ?? 'http://127.0.0.1:4173/app/#/plan'),
);
await page.getByRole('heading', { name: 'Мій план' }).waitFor();
await page.getByRole('heading', { name: 'Практика SQL', exact: true }).waitFor();
const checked = [];
for (const width of [320, 390, 768])
  for (const theme of ['dark', 'light']) {
    await page.setViewportSize({ width, height: 844 });
    const toggle = page.getByRole('button', {
      name: theme === 'dark' ? 'Увімкнути темну тему' : 'Увімкнути світлу тему',
    });
    if (await toggle.count()) await toggle.click();
    for (const tab of ['День', 'Прогрес', 'Винагороди']) {
      await page
        .getByRole('navigation', { name: 'Розділи плану' })
        .getByRole('button', { name: tab, exact: true })
        .click();
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      assert.equal(overflow, false, `${width}/${theme}/${tab} overflow`);
      await page.screenshot({
        path: resolve(out, `${width}-${theme}-${tab}.png`),
        fullPage: true,
        animations: 'disabled',
      });
      checked.push(`${width}/${theme}/${tab}`);
    }
  }
await page.setViewportSize({ width: 390, height: 844 });
const darkToggle = page.getByRole('button', { name: 'Увімкнути темну тему' });
if (await darkToggle.count()) await darkToggle.click();
await page.getByRole('button', { name: 'День', exact: true }).click();
await page.getByRole('button', { name: 'Виконати Практика SQL' }).click();
const input = page.getByLabel(/Фактично зроблено загалом/);
await input.fill('5');
await page.getByRole('button', { name: 'Зберегти факт', exact: true }).click();
try {
  await page.getByText('+14 XP за результат.').waitFor({ timeout: 5000 });
} catch (error) {
  await page.screenshot({ path: resolve(out, 'report-failure.png'), fullPage: true });
  console.log(
    JSON.stringify({
      alerts: await page.locator('[role=alert]').allTextContents(),
      dialog: (await page.getByRole('dialog').count())
        ? await page.getByRole('dialog').innerText()
        : 'closed',
      errors,
    }),
  );
  await browser.close();
  throw error;
}
await page.getByRole('button', { name: 'Скасувати позначку', exact: true }).click();
await page.getByText('Позначку скасовано.', { exact: true }).waitFor();
await page.getByRole('button', { name: 'Винагороди', exact: true }).click();
await page.getByRole('button', { name: /ОБРАНА ЦІЛЬ.*Apple Watch/ }).click();
assert.equal(
  await page.getByRole('button', { name: 'Ще рухаюся до відкриття' }).isDisabled(),
  true,
);
await page.screenshot({
  path: resolve(out, 'reward-path.png'),
  fullPage: true,
  animations: 'disabled',
});
await page.getByRole('button', { name: 'Закрити панель' }).click();
await page.getByRole('button', { name: 'День', exact: true }).click();
await page.getByRole('button', { name: 'Додати задачу', exact: true }).click();
await page.getByLabel('Що хочу зробити', { exact: true }).fill('Нова перевірочна задача');
await page
  .getByLabel('Коли це означатиме «зроблено»', { exact: true })
  .fill('Є конкретний результат');
await page.getByRole('button', { name: 'Зберегти в чернетку', exact: true }).click();
await page.getByRole('heading', { name: 'Нова перевірочна задача', exact: true }).waitFor();
assert.deepEqual(errors, []);
await browser.close();
console.log(
  JSON.stringify(
    {
      checked,
      journeys: ['partial completion', 'undo', 'reward gate', 'create draft'],
      errors,
      output: out,
    },
    null,
    2,
  ),
);
