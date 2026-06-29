import { describe, it, expect } from 'vitest';
import { renderBriefing, formatKyivDateHeader } from '../src/core/render.js';
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

  it('summaryHtml > ліміту — обрізає по межі рядків, не рве тег', () => {
    const line = '• <a href="https://x/aaaaaaaaaa">Заголовок новини</a>';
    const html = Array.from({ length: 6 }, () => line).join('\n');
    const [msg] = renderBriefing(
      [block({ id: 'n', priority: 0, title: 'Tt', summary: 's', summaryHtml: html })],
      { maxChars: 120 },
    );
    expect(msg!.length).toBeLessThanOrEqual(120);
    // немає обірваного тега: кількість <a> == кількість </a>
    const opens = (msg!.match(/<a /g) ?? []).length;
    const closes = (msg!.match(/<\/a>/g) ?? []).length;
    expect(opens).toBe(closes);
    expect(msg!.endsWith('…')).toBe(true);
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
    for (const m of msgs) expect(m.length).toBeLessThanOrEqual(120);
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
