import { describe, expect, it } from 'vitest';
import { mailAttentionView } from '../web/api-mail-attention.mjs';

describe('mail attention view', () => {
  it('shows only bounded metadata, prioritizes critical, and never exposes snippets', () => {
    const items = mailAttentionView({
      candidates: [
        {
          id: 'a',
          subject: 'Update',
          from: 'a@x',
          snippet: 'secret body',
          atMs: 1,
          attention: { level: 'attention', reasons: ['job_signal'] },
        },
        {
          id: 'b',
          subject: 'Interview',
          from: 'b@x',
          snippet: 'secret body',
          atMs: 2,
          attention: { level: 'critical', reasons: ['interview_or_deadline'] },
        },
      ],
    });
    expect(items.map((x: { id: string }) => x.id)).toEqual(['b', 'a']);
    expect(JSON.stringify(items)).not.toContain('secret body');
    expect(items[0]?.gmailUrl).toContain('/b');
  });
});
