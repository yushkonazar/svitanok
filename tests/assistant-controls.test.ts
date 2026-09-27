import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  DEFAULT_FOCUS_MINUTES,
  disableFocus,
  enableFocus,
  focusUntil,
  parseFocusRequest,
  shouldDeliverProactive,
} from '../web/core/assistant-controls.mjs';
import { workerEnv } from './helpers/env.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-27T10:00:00.000Z');

afterEach(() => vi.restoreAllMocks());

describe('assistant-controls — /focus і гейт автоматичних повідомлень', () => {
  it('розбирає явну тривалість, дефолт 2 год і зрозуміло відхиляє неоднозначне', () => {
    expect(parseFocusRequest('', NOW)).toMatchObject({
      kind: 'on',
      minutes: DEFAULT_FOCUS_MINUTES,
      untilMs: NOW + DEFAULT_FOCUS_MINUTES * 60_000,
    });
    expect(parseFocusRequest('30 хв', NOW)).toMatchObject({ kind: 'on', minutes: 30 });
    expect(parseFocusRequest('2 год', NOW)).toMatchObject({ kind: 'on', minutes: 120 });
    expect(parseFocusRequest('off', NOW)).toEqual({ kind: 'off' });
    expect(parseFocusRequest('2', NOW)).toMatchObject({ kind: 'error' });
    expect(parseFocusRequest('13 год', NOW)).toMatchObject({ kind: 'error' });
  });

  it('focus зберігається у власному fact, глушить лише неаварійну автоматику і вимикається', async () => {
    const d1 = d1FromSqlite(['0001_base.sql']);
    const env = workerEnv({ DB: d1.stub });
    const untilMs = NOW + 60 * 60_000;

    await enableFocus(env, untilMs, NOW);
    expect(await focusUntil(env, NOW)).toBe(untilMs);
    expect(await shouldDeliverProactive(env, 'digest', NOW)).toMatchObject({
      deliver: false,
      reason: 'focus',
    });
    expect(await shouldDeliverProactive(env, 'critical', NOW)).toEqual({
      deliver: true,
      reason: null,
    });

    expect(await disableFocus(env, NOW + 1)).toBe(true);
    expect(await focusUntil(env, NOW + 1)).toBeNull();
    expect(await shouldDeliverProactive(env, 'nudge', NOW + 1)).toEqual({
      deliver: true,
      reason: null,
    });
  });
});
