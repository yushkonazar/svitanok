import { describe, expect, it } from 'vitest';
import { mailAttentionSummary, mailAttentionView } from '../web/api-mail-attention.mjs';

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
    expect(items[0]?.citation).toEqual({
      source: 'gmail_message',
      messageId: 'b',
      url: 'https://mail.google.com/mail/u/0/#all/b',
    });
  });

  it('returns a deterministic bounded summary without mail metadata', () => {
    const items = mailAttentionView({
      candidates: [
        {
          id: 'first',
          subject: 'Надсекретна тема',
          from: 'private@example.com',
          snippet: 'body must never become a summary',
          atMs: 2,
          attention: { level: 'critical', reasons: ['interview_or_deadline', 'unknown'] },
        },
        {
          id: 'second',
          subject: 'Ще одна тема',
          from: 'other@example.com',
          atMs: 1,
          attention: { level: 'attention', reasons: ['job_signal'] },
        },
      ],
    });
    const summary = mailAttentionSummary(items);
    expect(summary).toEqual({
      total: 2,
      critical: 1,
      attention: 1,
      reasons: [
        { code: 'interview_or_deadline', label: 'співбесіда або дедлайн', count: 1 },
        { code: 'job_signal', label: 'сигнал щодо вакансії', count: 1 },
      ],
      text: 'Пошта: 1 критичних, 1 потребують уваги.',
    });
    expect(JSON.stringify(summary)).not.toContain('secret');
    expect(JSON.stringify(summary)).not.toContain('private@example.com');
  });

  it('drops malformed message ids and unrecognised attention levels', () => {
    const items = mailAttentionView({
      candidates: [
        { id: 'bad/id', attention: { level: 'critical', reasons: ['job_signal'] } },
        { id: 'fine', attention: { level: 'invented', reasons: ['job_signal'] } },
      ],
    });
    expect(items).toEqual([]);
  });

  it('does not expose candidates older than the three-day cache window', () => {
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    const items = mailAttentionView(
      {
        candidates: [
          {
            id: 'old',
            atMs: now - 3 * 86_400_000 - 1,
            attention: { level: 'critical', reasons: [] },
          },
          {
            id: 'fresh',
            atMs: now - 3 * 86_400_000,
            attention: { level: 'attention', reasons: [] },
          },
        ],
      },
      now,
    );
    expect((items as Array<{ id: string }>).map((item) => item.id)).toEqual(['fresh']);
  });
});
