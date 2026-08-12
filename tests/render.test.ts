import { describe, it, expect } from 'vitest';
import { formatKyivDateHeader } from '../src/core/render.js';
import { buildProposalCallbackData } from '../src/core/telegram.js';

/* Рендерер Block[] -> HTML-повідомлення видалено разом із тестами (аудит
   B20/F5): він не викликався з проду — orchestrator шле лише заголовок дати й
   рядок дня, вміст блоків живе в briefing.json. Лишились тести того, що
   справді працює: заголовок дати й callback_data пропозицій. */

describe('formatKyivDateHeader', () => {
  it('українська локаль, bold', () => {
    const h = formatKyivDateHeader(new Date('2026-06-29T09:00:00Z')); // понеділок
    expect(h.startsWith('<b>')).toBe(true);
    expect(h.toLowerCase()).toContain('червня');
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
