// Serverless smoke check of the actual Vite build. All external traffic is blocked.
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const dependencies = process.env.SVITANOK_PLAYWRIGHT_PATH
  ? createRequire(path.resolve(process.env.SVITANOK_PLAYWRIGHT_PATH, 'package.json'))
  : require;
const { chromium } = dependencies('playwright');
const publicRoot = path.resolve(__dirname, '../web/public');
const output = path.resolve(__dirname, '../.workspace/leisure-ui');
const types = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.SVITANOK_UI_BROWSER || undefined,
    headless: true,
  });
  const report = [];
  try {
    for (const width of [320, 393, 430]) {
      const context = await browser.newContext({
        viewport: { width, height: 852 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 1,
      });
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.hostname !== 'preview.invalid') return route.abort();
        let name = decodeURIComponent(url.pathname);
        if (name === '/app/' || name === '/app') name = '/app/index.html';
        const file = path.resolve(publicRoot, `.${name}`);
        if (
          !file.startsWith(publicRoot + path.sep) ||
          !fs.existsSync(file) ||
          !fs.statSync(file).isFile()
        )
          return route.fulfill({ status: 404, body: 'unavailable' });
        await route.fulfill({
          status: 200,
          contentType: types[path.extname(file)] ?? 'application/octet-stream',
          body: fs.readFileSync(file),
        });
      });
      await page.goto('https://preview.invalid/app/#/leisure');
      await page.getByRole('heading', { name: 'Дозвілля', exact: true }).waitFor();
      await page.getByText('Для ваших вечорів і вихідних.').waitFor();
      await page.evaluate(() => document.fonts.ready);
      const verify = async (name) => {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        );
        const dialog = page.getByRole('dialog');
        const box = (await dialog.count()) ? await dialog.boundingBox() : null;
        if (overflow || (box && (box.x < 0 || box.x + box.width > width + 1)))
          throw new Error(`overflow ${width} ${name}`);
        if (errors.length) throw new Error(errors.join('\n'));
        report.push({ width, screen: name, overflow: false });
        if (width === 393) await page.screenshot({ path: path.join(output, `${name}.png`) });
      };
      await page.getByRole('button', { name: 'Деталі', exact: false }).first().waitFor();
      await verify('home');
      await page.getByRole('button', { name: 'Деталі', exact: false }).first().click();
      await verify('detail');
      await page.getByRole('button', { name: 'Додати до плану вечора' }).click();
      await page.getByLabel('Назва', { exact: true }).fill('Наше побачення');
      await verify('plan');
      await page.getByRole('button', { name: 'Закрити' }).click();
      await page.getByRole('button', { name: 'Кіно', exact: true }).click();
      await page.getByRole('button', { name: 'Деталі', exact: false }).first().click();
      await verify('cinema');
      await page.getByRole('button', { name: 'Закрити' }).click();
      await page.getByRole('button', { name: 'Налаштування дозвілля' }).click();
      await verify('settings');
      await context.close();
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    console.log(
      JSON.stringify({ screens: report.length, widths: [320, 393, 430], errors: 0, output }),
    );
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
