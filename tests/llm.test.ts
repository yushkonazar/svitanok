import { describe, it, expect } from 'vitest';
import { formatLlmDegradedMessage, isUsageLimitError } from '../src/core/llm.js';

describe('isUsageLimitError (A3)', () => {
  it('упізнає людський текст CLI про вичерпаний ліміт підписки', () => {
    expect(isUsageLimitError('claude -p exit 1: Claude AI usage limit reached|1752620400')).toBe(
      true,
    );
    expect(isUsageLimitError("You've hit your session limit · resets 11pm")).toBe(true);
    expect(isUsageLimitError('Weekly limit reached')).toBe(true);
  });

  it('решта помилок — не ліміт (таймаут, впав процес, стеля викликів)', () => {
    expect(isUsageLimitError('claude -p таймаут 150000ms')).toBe(false);
    expect(isUsageLimitError('LLM maxCallsPerRun (4) перевищено')).toBe(false);
    expect(isUsageLimitError('spawn claude ENOENT')).toBe(false);
  });
});

describe('formatLlmDegradedMessage (A3)', () => {
  it('нічого не впало -> null (тиша в «⚠️ Система»)', () => {
    expect(formatLlmDegradedMessage([])).toBeNull();
  });

  it('ліміт підписки -> явно про ліміти + перелічує до 3 причин', () => {
    const msg = formatLlmDegradedMessage([
      'claude -p exit 1: Claude AI usage limit reached|1752620400',
      'claude -p exit 1: Claude AI usage limit reached|1752620400',
    ]);
    expect(msg).toContain('ліміти Claude вичерпані');
    expect(msg).toContain('2 LLM-виклик(ів) впало');
    expect(msg).toContain('Брифінг надіслано'); // ран не впав — деградував
  });

  it('інші збої -> нейтральний текст «LLM недоступний»', () => {
    const msg = formatLlmDegradedMessage(['claude -p таймаут 150000ms']);
    expect(msg).toContain('LLM недоступний');
    expect(msg).not.toContain('ліміти Claude');
  });

  it('довгий список -> лише 3 рядки причин (не спамимо в чат)', () => {
    const msg = formatLlmDegradedMessage(Array.from({ length: 9 }, (_, i) => `помилка ${i}`))!;
    expect(msg.split('\n').filter((l) => l.startsWith('•'))).toHaveLength(3);
    expect(msg).toContain('9 виклик(ів) впало');
  });
});
