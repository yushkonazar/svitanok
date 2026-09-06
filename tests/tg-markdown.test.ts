// Markdown моделі → HTML Telegram (tg/markdown.mjs): екранування ДО тегів,
// код без розмітки всередині, межі слів кирилицею, частини для outbox.

import { describe, it, expect } from 'vitest';
import { mdToTelegramHtml, renderMdParts, MD_PART_LIMIT } from '../web/core/tg/markdown.mjs';
import { TG_TEXT_LIMIT } from '../web/core/tg/outbox-core.mjs';

describe('mdToTelegramHtml', () => {
  it('жирний, курсив, закреслення, код', () => {
    expect(mdToTelegramHtml('**жирно** і __так__, _курсив_ та *ще*, ~~ні~~, `x < y`')).toBe(
      '<b>жирно</b> і <b>так</b>, <i>курсив</i> та <i>ще</i>, <s>ні</s>, <code>x &lt; y</code>',
    );
  });

  it('символи моделі не стають тегами: <, >, & екрановано', () => {
    expect(mdToTelegramHtml('a <b>b</b> & c')).toBe('a &lt;b&gt;b&lt;/b&gt; &amp; c');
  });

  it('код-блок: вміст як є, без розмітки й із екрануванням', () => {
    expect(mdToTelegramHtml('до\n```js\nconst a = **b** < 1;\n```\nпісля')).toBe(
      'до\n<pre>const a = **b** &lt; 1;</pre>\nпісля',
    );
  });

  it('заголовки → жирний рядок, списки → «•», лінійка зникає, цитата → blockquote', () => {
    expect(mdToTelegramHtml('## Коротко\n- один\n* два\n---\n> цитата\n> далі\n1. три')).toBe(
      '<b>Коротко</b>\n• один\n• два\n\n<blockquote>цитата\nдалі</blockquote>\n1. три',
    );
  });

  it('посилання лише http(s); підкреслення всередині слова - не курсив', () => {
    expect(mdToTelegramHtml('[док](https://a.b/c?x=1&y=2) snake_case_name і _так_')).toBe(
      '<a href="https://a.b/c?x=1&amp;y=2">док</a> snake_case_name і <i>так</i>',
    );
    expect(mdToTelegramHtml('[x](javascript:alert(1))')).toBe('[x](javascript:alert(1))');
  });

  it('кирилична межа: «_слово_далі» - не курсив, «2 * 3 * 4» - не курсив', () => {
    expect(mdToTelegramHtml('_слово_далі')).toBe('_слово_далі');
    expect(mdToTelegramHtml('2 * 3 * 4')).toBe('2 * 3 * 4');
  });

  it('«_» і «*» всередині URL - не розмітка: посилання й голі адреси в сховку', () => {
    expect(mdToTelegramHtml('[док](https://a.b/_foo_/x) і https://ex.com/_bar_ тут')).toBe(
      '<a href="https://a.b/_foo_/x">док</a> і https://ex.com/_bar_ тут',
    );
    expect(mdToTelegramHtml('[вікі](https://uk.wikipedia.org/wiki/Київ_(місто))')).toBe(
      '<a href="https://uk.wikipedia.org/wiki/Київ_(місто)">вікі</a>',
    );
  });

  it('однорядковий ```code``` не втрачає вміст; мова - лише з переносом', () => {
    expect(mdToTelegramHtml('```ls -la```')).toBe('<pre>ls -la</pre>');
    expect(mdToTelegramHtml('```bash\nls -la\n```')).toBe('<pre>ls -la</pre>');
  });

  it('дандери посеред слова - не жирний', () => {
    expect(mdToTelegramHtml('файл __init__.py і __main__')).toBe('файл __init__.py і __main__');
    expect(mdToTelegramHtml('__жирно__ тут')).toBe('<b>жирно</b> тут');
  });

  it('порожнє → порожнє; 3+ переноси стискаються', () => {
    expect(mdToTelegramHtml('')).toBe('');
    expect(mdToTelegramHtml(null)).toBe('');
    expect(mdToTelegramHtml('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('renderMdParts', () => {
  it('одна частина: HTML + parse_mode + plain_text оригінал', () => {
    expect(renderMdParts('**a**')).toEqual([
      { text: '<b>a</b>', parse_mode: 'HTML', plain_text: '**a**' },
    ]);
  });

  it('літеральні маркери вийнятого коду (U+E000/U+E001) у тексті моделі не підставляють код', () => {
    expect(mdToTelegramHtml('`x` і 0')).toBe('<code>x</code> і 0');
  });

  it('ріже Markdown ДО конвертації - тег не ділиться між частинами', () => {
    const para = '**' + 'ж'.repeat(200) + '**\n\n';
    const md = para.repeat(40);
    const parts = renderMdParts(md);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.text.length).toBeLessThanOrEqual(TG_TEXT_LIMIT);
      expect((p.text.match(/<b>/g) ?? []).length).toBe((p.text.match(/<\/b>/g) ?? []).length);
      expect(p.plain_text!.length).toBeLessThanOrEqual(MD_PART_LIMIT);
    }
  });

  it('розріз усередині код-блоку: огорожа закривається в цій частині й відкривається в наступній', () => {
    const code = '```\n' + '**не жирне** `не код`\n'.repeat(400) + '```';
    const parts = renderMdParts('до\n\n' + code + '\n\nпісля');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) {
      expect(p.text).not.toContain('<b>');
      expect(p.text).not.toContain('<code>');
      expect((p.text.match(/<pre>/g) ?? []).length).toBe((p.text.match(/<\/pre>/g) ?? []).length);
    }
    expect(parts[0]!.text).toContain('<pre>');
    expect(parts[parts.length - 1]!.text).toMatch(/<\/pre>\n\nпісля$/);
  });

  it('частина, що після конвертації переросла 4096, їде звичайним текстом', () => {
    // «&» подвоюється в &amp; - 3 500 символів Markdown → понад 4 096 HTML.
    const md = '&'.repeat(MD_PART_LIMIT);
    expect(renderMdParts(md)).toEqual([{ text: md }]);
  });
});
