import { describe, it, expect } from 'vitest';
import {
  renderBriefing,
  renderBriefingMessages,
  formatKyivDateHeader,
} from '../src/core/render.js';
import {
  visibleLength,
  buildCallbackData,
  buildProposalCallbackData,
  CB_VERSION,
} from '../src/core/telegram.js';
import type { Block } from '../src/core/types.js';

const block = (over: Partial<Block> & { id: string; priority: number }): Block => ({
  title: 'T',
  summary: 'S',
  ...over,
});

describe('renderBriefing — escape + структура', () => {
  it('екранує динамічні поля', () => {
    const [msg] = renderBriefing(
      [block({ id: 'a', priority: 0, title: '<b>x', summary: 'a & b', detail: '<i>d' })],
      { maxChars: 3900 },
    );
    expect(msg).toContain('&lt;b&gt;x');
    expect(msg).toContain('a &amp; b');
    expect(msg).toContain('<blockquote expandable>&lt;i&gt;d</blockquote>');
  });

  it('сортує за priority', () => {
    const msgs = renderBriefing(
      [block({ id: 'b', priority: 5, title: 'B' }), block({ id: 'a', priority: 1, title: 'A' })],
      { maxChars: 3900 },
    );
    expect(msgs[0]!.indexOf('A')).toBeLessThan(msgs[0]!.indexOf('B'));
  });

  it('quiet — без detail', () => {
    const [msg] = renderBriefing([block({ id: 'a', priority: 0, detail: 'СЕКРЕТНИЙ ДЕТЕЙЛ' })], {
      maxChars: 3900,
      quiet: true,
    });
    expect(msg).not.toContain('СЕКРЕТНИЙ ДЕТЕЙЛ');
    expect(msg).not.toContain('blockquote');
  });

  it('summaryHtml/detailHtml — беруться як готовий HTML (не екрануються)', () => {
    const [msg] = renderBriefing(
      [
        block({
          id: 'news',
          priority: 0,
          title: 'Новини',
          summary: 'плейн',
          summaryHtml: '• <a href="https://x/a">Заголовок</a>',
          detailHtml: '<i>деталь</i>',
        }),
      ],
      { maxChars: 3900 },
    );
    expect(msg).toContain('<a href="https://x/a">Заголовок</a>');
    expect(msg).not.toContain('плейн'); // summaryHtml перекриває summary
    expect(msg).toContain('<blockquote expandable><i>деталь</i></blockquote>');
  });

  it('summaryHtml понад ліміт (за видимим) — обрізає по межі рядків, не рве тег', () => {
    const line = '• <a href="https://x/a">Заголовок новини дня доволі довгий</a>';
    const html = Array.from({ length: 6 }, () => line).join('\n');
    const [msg] = renderBriefing(
      [block({ id: 'n', priority: 0, title: 'Tt', summary: 's', summaryHtml: html })],
      { maxChars: 60 },
    );
    const opens = (msg!.match(/<a /g) ?? []).length;
    const closes = (msg!.match(/<\/a>/g) ?? []).length;
    expect(opens).toBe(closes); // немає обірваного тега
    expect(msg!.endsWith('…')).toBe(true);
  });

  it('довгі href НЕ спричиняють розбиття (рахуємо видимий текст, не href)', () => {
    // 8 лінків із величезними href, але коротким видимим текстом -> одне повідомлення.
    const bigHref = 'https://news.google.com/rss/articles/' + 'A'.repeat(400);
    const summaryHtml = Array.from(
      { length: 8 },
      (_, i) => `• <a href="${bigHref}${i}">Коротка новина ${i}</a>`,
    ).join('\n');
    const msgs = renderBriefing(
      [block({ id: 'news', priority: 0, title: 'Новини', summary: 's', summaryHtml })],
      { maxChars: 3900 },
    );
    expect(msgs).toHaveLength(1); // не розбило, попри ~3200 «сирих» символів href
  });

  it('inMessage:false — блок НЕ йде в повідомлення', () => {
    const msgs = renderBriefing(
      [
        block({ id: 'a', priority: 0, title: 'Видимий', summary: 'у повідомленні' }),
        block({
          id: 'fact',
          priority: 1,
          title: 'Факт',
          summary: 'ЛИШЕ В ДАШБОРДІ',
          inMessage: false,
        }),
      ],
      { maxChars: 3900 },
    );
    const all = msgs.join('\n');
    expect(all).toContain('Видимий');
    expect(all).not.toContain('ЛИШЕ В ДАШБОРДІ');
  });

  it('header лише в першому повідомленні', () => {
    const msgs = renderBriefing([block({ id: 'a', priority: 0 })], {
      maxChars: 3900,
      header: '<b>Заголовок</b>',
    });
    expect(msgs[0]!.startsWith('<b>Заголовок</b>')).toBe(true);
  });
});

describe('renderBriefing — ліміт 4096', () => {
  it('розбиває на межі блоків; кожне повідомлення <= maxChars; блоки не губляться', () => {
    const blocks: Block[] = Array.from({ length: 6 }, (_, i) =>
      block({ id: `b${i}`, priority: i, title: `Блок${i}`, summary: 'x'.repeat(50) }),
    );
    const msgs = renderBriefing(blocks, { maxChars: 120 });
    expect(msgs.length).toBeGreaterThan(1);
    for (const m of msgs) expect(visibleLength(m)).toBeLessThanOrEqual(120);
    const all = msgs.join('\n');
    for (let i = 0; i < 6; i++) expect(all).toContain(`Блок${i}`);
  });

  it('один блок > ліміту — обрізає summary, повідомлення <= maxChars (не 400)', () => {
    const msgs = renderBriefing(
      [block({ id: 'big', priority: 0, title: 'Tt', summary: 'д'.repeat(500) })],
      { maxChars: 80 },
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.length).toBeLessThanOrEqual(80);
    expect(msgs[0]!.endsWith('…')).toBe(true);
  });
});

describe('formatKyivDateHeader', () => {
  it('українська локаль, bold', () => {
    const h = formatKyivDateHeader(new Date('2026-06-29T09:00:00Z')); // понеділок
    expect(h.startsWith('<b>')).toBe(true);
    expect(h.toLowerCase()).toContain('червня');
  });
});

describe('renderBriefingMessages — кнопки (Блок P1)', () => {
  it('блок із buttons -> окреме повідомлення з callback_data-кодованою клавіатурою', () => {
    const msgs = renderBriefingMessages(
      [
        block({
          id: 'fact',
          priority: 0,
          title: 'Факт',
          buttons: [[{ label: '🔖 Зберегти', action: 'sf' }]],
        }),
      ],
      { maxChars: 3900, dateKey: '2026-07-09' },
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.buttons).toEqual([
      [{ text: '🔖 Зберегти', callback_data: `${CB_VERSION}:2026-07-09:sf` }],
    ]);
  });

  it('без dateKey -> кнопки не серіалізуються (безпечний дефолт)', () => {
    const msgs = renderBriefingMessages(
      [block({ id: 'fact', priority: 0, buttons: [[{ label: 'X', action: 'sf' }]] })],
      { maxChars: 3900 },
    );
    expect(msgs[0]!.buttons).toBeUndefined();
  });

  it('блок із кнопками НЕ зливається із сусідніми блоками (форсує межу повідомлення)', () => {
    const msgs = renderBriefingMessages(
      [
        block({ id: 'a', priority: 0, title: 'A', summary: 'перед' }),
        block({
          id: 'jobs',
          priority: 1,
          title: 'Вакансії',
          summary: 'з кнопками',
          buttons: [[{ label: '💾', action: 'js:0' }]],
        }),
        block({ id: 'c', priority: 2, title: 'C', summary: 'після' }),
      ],
      { maxChars: 3900, dateKey: '2026-07-09' },
    );
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.text).toContain('перед');
    expect(msgs[0]!.buttons).toBeUndefined();
    expect(msgs[1]!.buttons).toHaveLength(1);
    expect(msgs[2]!.text).toContain('після');
    expect(msgs[2]!.buttons).toBeUndefined();
  });

  it('renderBriefing (сумісний рядковий wrapper) повертає лише текст', () => {
    const msgs = renderBriefing(
      [
        block({
          id: 'fact',
          priority: 0,
          summary: 'X',
          buttons: [[{ label: 'B', action: 'sf' }]],
        }),
      ],
      { maxChars: 3900, dateKey: '2026-07-09' },
    );
    expect(typeof msgs[0]).toBe('string');
  });
});

describe('buildCallbackData', () => {
  it('кодує v1:<dateKey>:<action>', () => {
    expect(buildCallbackData('2026-07-09', 'ja:0')).toBe('v1:2026-07-09:ja:0');
  });

  it('> 64 байти (UTF-8) -> null', () => {
    expect(buildCallbackData('2026-07-09', 'я'.repeat(40))).toBeNull();
  });
});

describe('buildProposalCallbackData (дзеркало web/agent-core.mjs, Блок P2b/P2c)', () => {
  it('кодує pd:a:<id> / pd:c:<id>', () => {
    expect(buildProposalCallbackData('a', 'ab12cd34')).toBe('pd:a:ab12cd34');
    expect(buildProposalCallbackData('c', 'ab12cd34')).toBe('pd:c:ab12cd34');
  });

  it('> 64 байти (UTF-8) -> null', () => {
    expect(buildProposalCallbackData('a', 'я'.repeat(40))).toBeNull();
  });
});
