// Local browser acceptance only. All requests are intercepted; no owner/API writes.
/* global document, window */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import assert from 'node:assert/strict';
import { SAMPLE_STATS } from '../web/app/src/api/sample.ts';
import { SAMPLE_BRIEF } from '../web/app/src/api/briefing-sample.ts';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.SVITANOK_PLAYWRIGHT_MODULE ?? 'playwright');
const root = resolve('web/public'),
  out = resolve('node_modules/.cache/bookmarks-qa');
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
const errors = [],
  checks = [],
  calls = [];
page.on('pageerror', (error) => errors.push(error.message));
let fixtureMode = false;
const now = new Date().toISOString();
const item = {
  id: 'idea-browser-fixture',
  number: 8,
  title: 'Винагорода поруч із реальними умовами покупки',
  body: 'Хочу бачити майбутні платежі та запас коштів поруч із винагородою. Очікуваний дохід потрібно відокремити від наявного залишку.',
  status: 'план готовий',
  priority: 2,
  area: 'plan',
  kind: 'improvement',
  version: 'a'.repeat(64),
  sourceHash: 'b'.repeat(64),
  createdAt: now,
  updatedAt: now,
};
const detail = {
  item,
  historyCursor: null,
  formulations: [
    {
      id: 'browser-formulation',
      ideaId: item.id,
      sourceHash: item.sourceHash,
      status: 'ready',
      contextVersion: '0.15.0',
      createdAt: now,
      finishedAt: now,
      error: null,
      revision: 1,
      published: true,
      source: { title: item.title, body: item.body },
      customPrompt: false,
      prompt:
        'Реалізуй умови покупки поруч із винагородою. Перевір спільні фінансові дані та не вважай прогноз наявними грошима.',
      result: {
        title: 'Умови покупки, які допомагають прийняти рішення',
        problem: 'У винагороді бракує зрозумілого зв’язку з майбутніми платежами.',
        outcome:
          'Умови винагороди показують перевірений запас і відомі платежі, пояснюючи невідомі дані.',
        userFlow: [
          'Відкрити обрану винагороду.',
          'Переглянути умови й перейти до фінансів для уточнення.',
        ],
        minimumScope: [
          'Використати спільне джерело фінансових даних.',
          'Показати запас після відомих платежів і позначити невизначеність.',
        ],
        futureScope: ['Додати порівняння кількох сценаріїв.'],
        integrations: ['План / винагороди ↔ фінанси / платежі.'],
        implementation: ['Перевірити актуальні функції розрахунку й оновлення залишку.'],
        acceptance: [
          'Без відомого залишку покупка не позначена як доступна.',
          'Прогноз не додається до фактичних коштів.',
        ],
        risks: ['Майбутні витрати можуть бути внесені неповністю.'],
        questions: ['Який запас власник хоче залишати?'],
      },
    },
  ],
};
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
    calls.push({ path: url.pathname, method: route.request().method() });
    let body = {};
    if (url.pathname === '/api/stats') body = SAMPLE_STATS;
    else if (url.pathname === '/api/latest') body = SAMPLE_BRIEF;
    else if (url.pathname === '/api/saved') body = { items: [], cursor: null, total: 0 };
    else if (url.pathname === '/api/bookmarks' && fixtureMode) {
      if (route.request().method() === 'POST') {
        const c = route.request().postDataJSON();
        if (c.op === 'save-prompt') {
          detail.formulations[0].prompt = c.payload.prompt;
          detail.formulations[0].revision++;
          detail.formulations[0].customPrompt = true;
        }
        body = {
          ok: true,
          receipt: { id: item.id, message: 'Текст для GPT збережено.', formulationId: null },
          ...detail,
        };
      } else
        body = url.searchParams.has('id')
          ? { ok: true, ...detail }
          : { ok: true, items: [item], cursor: null, context: '0.15.0' };
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });
  }
  const file = resolve(
    root,
    `.${url.pathname.endsWith('/') ? url.pathname + 'index.html' : url.pathname}`,
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
async function fits(label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, label + ': document overflow');
  const panel = page.getByRole('dialog');
  if (await panel.count()) {
    const tooWide = await panel.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    assert.equal(tooWide, false, label + ': dialog overflow');
  }
  checks.push(label);
}
try {
  await page.goto('https://svitanok.local/app/#/');
  await page.getByRole('button', { name: 'Закладки', exact: true }).click();
  assert.match(page.url(), /#\/bookmarks$/);
  await page.getByRole('button', { name: '＋ Додати закладку', exact: true }).click();
  await page.getByLabel('Суть ідеї або проблеми').fill('Хочу зручніше бачити заплановані платежі');
  await page.getByRole('button', { name: 'Закрити закладку ×', exact: true }).click();
  await page.getByRole('button', { name: '＋ Додати закладку', exact: true }).click();
  assert.equal(
    await page.getByLabel('Суть ідеї або проблеми').inputValue(),
    'Хочу зручніше бачити заплановані платежі',
  );
  await page.getByRole('button', { name: 'Зберегти закладку', exact: true }).click();
  await page.getByRole('button', { name: 'Уточнити запис', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Уточнити запис', exact: true }).click();
  await page
    .getByLabel('Суть ідеї або проблеми')
    .fill('Хочу зручніше бачити заплановані платежі й реальний запас.');
  await page.getByRole('button', { name: 'Зберегти закладку', exact: true }).click();
  await page.getByRole('button', { name: 'Копіювати запис', exact: true }).waitFor();
  await fits('capture/edit/draft recovery');
  await page.getByRole('button', { name: 'Закрити закладку ×', exact: true }).click();
  await page.getByRole('link', { name: 'Збережені матеріали ↗', exact: true }).click();
  assert.match(page.url(), /#\/saved$/);
  assert.equal(
    calls.some((c) => c.path === '/api/bookmarks'),
    false,
    'demo must not touch personal API',
  );
  checks.push('saved archive preserved; demo isolated');

  fixtureMode = true;
  await page.addInitScript(() => {
    window.Telegram = {
      WebApp: {
        initData: 'local-browser-fixture-not-a-real-session',
        ready() {},
        expand() {},
        colorScheme: 'dark',
      },
    };
  });
  await page.goto('https://svitanok.local/app/#/bookmarks?idea=' + item.id);
  await page.reload();
  await page.getByRole('button', { name: 'Копіювати для GPT', exact: true }).waitFor();
  for (const width of [320, 390, 768])
    for (const theme of ['dark', 'light']) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate((theme) => {
        document.documentElement.dataset.theme = theme;
      }, theme);
      await fits(`${width}/${theme}/proposal`);
      await page.screenshot({
        path: resolve(out, `${width}-${theme}-proposal.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole('button', { name: 'Переглянути й відредагувати запит', exact: true })
    .click();
  await page
    .getByLabel('Текст для GPT')
    .fill('Моя точна редакція запиту: перевірити фінансові правила й зберегти поточні дані.');
  await page.getByRole('button', { name: 'Зберегти мою редакцію запиту', exact: true }).click();
  await page.getByText('Твою редакцію запиту збережено.', { exact: true }).waitFor();
  assert.equal(
    detail.formulations[0].prompt,
    'Моя точна редакція запиту: перевірити фінансові правила й зберегти поточні дані.',
  );
  await fits('custom GPT prompt saved');
  await page.screenshot({
    path: resolve(out, 'prompt-editor.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Уточнити запис', exact: true }).click();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await fits(`${width}/source editor`);
    await page.screenshot({
      path: resolve(out, `${width}-editor.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  assert.deepEqual(errors, []);
  await writeFile(
    resolve(out, 'result.json'),
    JSON.stringify({ checks, errors, screenshots: 10 }, null, 2),
  );
  console.log(JSON.stringify({ checks: checks.length, errors, out }));
} catch (error) {
  await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true });
  await writeFile(resolve(out, 'failure.html'), await page.content());
  console.log(
    JSON.stringify({
      url: page.url(),
      errors,
      text: (await page.locator('body').innerText()).slice(-6000),
    }),
  );
  throw error;
} finally {
  await browser.close();
}
