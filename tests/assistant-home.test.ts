import { describe, expect, it } from 'vitest';
import { assistantHomeTarget } from '../web/core/tg/home.mjs';
import { chainTarget } from '../web/core/chains/state.mjs';
import { workerEnv } from './helpers/env.js';

describe('assistant home address', () => {
  it('routes new proactive work to the owner DM without forum thread', () => {
    const env = workerEnv({
      ASSISTANT_HOME: 'dm',
      TELEGRAM_OWNER_USER_ID: '12345',
      TELEGRAM_CHAT_ID: '-100999',
      TOPIC_ASSISTANT: '6',
      TOPIC_SYSTEM: '9',
    });
    expect(assistantHomeTarget(env)).toEqual({ chatId: 12345, threadId: null, threadKey: 'dm' });
    expect(assistantHomeTarget(env, 'system')).toEqual(assistantHomeTarget(env));
    expect(chainTarget(env, { chat_id: null, thread_id: null })).toEqual({
      chatId: '12345',
      threadId: null,
    });
    expect(chainTarget(env, { chat_id: -100999, thread_id: '6' })).toEqual({
      chatId: '-100999',
      threadId: '6',
    });
    expect(chainTarget(env, { chat_id: null, thread_id: '6' })).toEqual({
      chatId: '-100999',
      threadId: '6',
    });
  });

  it('keeps group compatibility and fails closed on missing private address', () => {
    const group = workerEnv({
      TELEGRAM_CHAT_ID: '-100999',
      TOPIC_ASSISTANT: '6',
      TOPIC_SYSTEM: '9',
    });
    expect(assistantHomeTarget(group)).toEqual({ chatId: -100999, threadId: 6, threadKey: '6' });
    expect(assistantHomeTarget(group, 'system')?.threadId).toBe(9);
    expect(
      assistantHomeTarget(workerEnv({ TELEGRAM_CHAT_ID: '-100999', TOPIC_BRIEFING: '7' }), 'system')
        ?.threadId,
    ).toBe(7);
    expect(
      assistantHomeTarget(workerEnv({ ASSISTANT_HOME: 'dm', TELEGRAM_CHAT_ID: '-100999' })),
    ).toBeNull();
  });
});
