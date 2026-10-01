import { describe, expect, it } from 'vitest';
import { buildActionCardRows } from '../web/core/tg/action-card.mjs';

describe('buildActionCardRows', () => {
  it('keeps long choices and checklist actions distinct, and pairs compact controls', () => {
    expect(
      buildActionCardRows({
        choices: [
          { text: 'Restaurant with a long name', callback_data: 'choice:one' },
          { text: 'Another long name', callback_data: 'choice:two' },
        ],
        checklist: [{ text: '✅ Prepare documents', callback_data: 'c:trip:d1' }],
        choicePairs: [
          { text: '30 хв', callback_data: 'c:plan:a0_0' },
          { text: '1 год', callback_data: 'c:plan:a0_1' },
          { text: '2 год', callback_data: 'c:plan:a0_2' },
        ],
        actions: [
          { text: '🗓 Змінити дати', callback_data: 'c:trip:newdate' },
          { text: '✖ Скасувати', callback_data: 'c:trip:cancel' },
        ],
      }),
    ).toEqual([
      [{ text: 'Restaurant with a long name', callback_data: 'choice:one' }],
      [{ text: 'Another long name', callback_data: 'choice:two' }],
      [{ text: '✅ Prepare documents', callback_data: 'c:trip:d1' }],
      [
        { text: '30 хв', callback_data: 'c:plan:a0_0' },
        { text: '1 год', callback_data: 'c:plan:a0_1' },
      ],
      [{ text: '2 год', callback_data: 'c:plan:a0_2' }],
      [
        { text: '🗓 Змінити дати', callback_data: 'c:trip:newdate' },
        { text: '✖ Скасувати', callback_data: 'c:trip:cancel' },
      ],
    ]);
  });

  it('drops malformed or unsafe buttons and appends optional feedback last', () => {
    expect(
      buildActionCardRows({
        choices: [
          { text: 'No callback' },
          { text: 'Bad link', url: 'javascript:alert(1)' },
          { text: 'Too long', callback_data: 'x'.repeat(65) },
          { text: 'Safe link', url: 'https://example.com' },
        ],
        feedbackId: 'abc123',
      }),
    ).toEqual([
      [{ text: 'Safe link', url: 'https://example.com' }],
      [
        { text: '👍 Корисно', callback_data: 'm:w:abc123:good' },
        { text: '👎 Не те', callback_data: 'm:w:abc123:bad' },
      ],
    ]);
  });
});
