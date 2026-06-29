import { describe, it, expect } from 'vitest';
import {
  requireCriticalSecrets,
  optionalSecret,
  MissingSecretsError,
} from '../src/core/secrets.js';

describe('secrets — requireCriticalSecrets (§4.1 п.0)', () => {
  it('повертає секрети, обрізає пробіли', () => {
    const s = requireCriticalSecrets({
      TELEGRAM_BOT_TOKEN: '  tok  ',
      TELEGRAM_CHAT_ID: ' 42 ',
    });
    expect(s).toEqual({ botToken: 'tok', chatId: '42' });
  });

  it('кидає MissingSecretsError з переліком відсутніх', () => {
    try {
      requireCriticalSecrets({ TELEGRAM_BOT_TOKEN: 'x' });
      expect.unreachable('мало кинути');
    } catch (e) {
      expect(e).toBeInstanceOf(MissingSecretsError);
      expect((e as MissingSecretsError).missing).toEqual(['TELEGRAM_CHAT_ID']);
    }
  });

  it('порожній рядок вважається відсутнім', () => {
    expect(() =>
      requireCriticalSecrets({ TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '1' }),
    ).toThrow(MissingSecretsError);
  });
});

describe('secrets — optionalSecret', () => {
  it('повертає значення або undefined', () => {
    expect(optionalSecret('WEATHER_API_KEY', { WEATHER_API_KEY: 'k' })).toBe('k');
    expect(optionalSecret('WEATHER_API_KEY', {})).toBeUndefined();
    expect(optionalSecret('WEATHER_API_KEY', { WEATHER_API_KEY: '  ' })).toBeUndefined();
  });
});
