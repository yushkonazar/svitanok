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

  it('порожнє → порожнє; 3+ переноси стискаються', () => {
    expect(mdToTelegramHtml('')).toBe('');
    expect(mdToTelegramHtml(null)).toBe('');
    expect(mdToTelegramHtml('a\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('renderMdParts', () => {
  it('одна частина: HTML + plain_text оригінал', () => {
    expect(renderMdParts('**a**')).toEqual([{ text: '<b>a</b>', plain_text: '**a**' }]);
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

  it('частина, що після конвертації переросла 4096, їде звичайним текстом', () => {
    // «&» подвоюється в &amp; - 3 500 символів Markdown → понад 4 096 HTML.
    const md = '&'.repeat(MD_PART_LIMIT);
    expect(renderMdParts(md)).toEqual([{ text: md, parse_mode: undefined }]);
  });
});
