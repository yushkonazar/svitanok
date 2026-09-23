// loadConfig мозку: fail-fast з ІМЕНАМИ змінних, заборона *.workers.dev
// (інцидент 24.08) і бази зі шляхом (підпис бився б у проді), пів-пари Access,
// trim \r\n-пастки, дефолти хоста/порту.

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../brain/src/config.js';

const FULL = {
  CLAUDE_CODE_OAUTH_TOKEN: 'token',
  INTERNAL_HMAC_KEY: 'key-1',
  INTERNAL_API_URL: 'https://svitanok.example',
};

describe('loadConfig: обовʼязкові змінні', () => {
  it('відсутні змінні названі поіменно, значення не світяться', () => {
    expect(() => loadConfig({})).toThrow(
      /CLAUDE_CODE_OAUTH_TOKEN, INTERNAL_HMAC_KEY, INTERNAL_API_URL/,
    );
    expect(() => loadConfig({ ...FULL, INTERNAL_HMAC_KEY: '  ' })).toThrow(/INTERNAL_HMAC_KEY/);
  });

  it('мінімальний валідний конфіг: дефолти 127.0.0.1:8788, один ключ, без Access', () => {
    const cfg = loadConfig(FULL);
    expect(cfg).toEqual({
      host: '127.0.0.1',
      port: 8788,
      internalApiUrl: 'https://svitanok.example',
      hmacKeys: ['key-1'],
      accessClientId: null,
      accessClientSecret: null,
      aiProvider: 'claude',
      openAiApiKey: null,
      openAiModel: null,
      openAiReasoningEffort: null,
    });
  });
});

describe('loadConfig: OpenAI Responses provider', () => {
  it('вимагає окремий API key лише в режимі openai та не вимагає Claude token', () => {
    expect(() =>
      loadConfig({
        INTERNAL_HMAC_KEY: 'key',
        INTERNAL_API_URL: 'https://svitanok.example',
        AI_PROVIDER: 'openai',
      }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(
      loadConfig({
        INTERNAL_HMAC_KEY: 'key',
        INTERNAL_API_URL: 'https://svitanok.example',
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: ' openai-key ',
      }),
    ).toMatchObject({
      aiProvider: 'openai',
      openAiApiKey: 'openai-key',
      openAiModel: 'gpt-6-astra',
      openAiReasoningEffort: 'high',
    });
  });

  it('відхиляє невідомого provider-а, effort або порожню model', () => {
    expect(() => loadConfig({ ...FULL, AI_PROVIDER: 'other' })).toThrow(/AI_PROVIDER/);
    expect(() =>
      loadConfig({
        ...FULL,
        AI_PROVIDER: 'openai',
        OPENAI_API_KEY: 'k',
        OPENAI_REASONING_EFFORT: 'none',
      }),
    ).toThrow(/OPENAI_REASONING_EFFORT/);
    expect(() =>
      loadConfig({ ...FULL, AI_PROVIDER: 'openai', OPENAI_API_KEY: 'k', OPENAI_MODEL: ' ' }),
    ).toThrow(/OPENAI_MODEL/);
  });
});

describe('loadConfig: INTERNAL_API_URL', () => {
  it('*.workers.dev - відмова (інцидент 24.08)', () => {
    expect(() =>
      loadConfig({ ...FULL, INTERNAL_API_URL: 'https://svitanok.someone.workers.dev' }),
    ).toThrow(/workers\.dev/);
  });

  it('база зі шляхом або query - відмова; хвостові слеші зрізаються', () => {
    expect(() => loadConfig({ ...FULL, INTERNAL_API_URL: 'https://host.example/api' })).toThrow(
      /лише origin/,
    );
    expect(() => loadConfig({ ...FULL, INTERNAL_API_URL: 'https://host.example/?x=1' })).toThrow(
      /лише origin/,
    );
    expect(loadConfig({ ...FULL, INTERNAL_API_URL: 'https://host.example//' }).internalApiUrl).toBe(
      'https://host.example',
    );
    expect(() => loadConfig({ ...FULL, INTERNAL_API_URL: 'не url' })).toThrow(/не є URL/);
  });
});

describe('loadConfig: ключі, Access, порт', () => {
  it('ключ NEXT додається; \\r\\n-хвости зрізаються (пастка проєкту)', () => {
    const cfg = loadConfig({
      ...FULL,
      INTERNAL_HMAC_KEY: 'key-1\r\n',
      INTERNAL_HMAC_KEY_NEXT: ' key-2 ',
    });
    expect(cfg.hmacKeys).toEqual(['key-1', 'key-2']);
  });

  it('пів-пари Access - відмова; повна пара - у конфізі', () => {
    expect(() => loadConfig({ ...FULL, BRAIN_ACCESS_CLIENT_ID: 'id' })).toThrow(/один із пари/);
    expect(() => loadConfig({ ...FULL, BRAIN_ACCESS_CLIENT_SECRET: 's' })).toThrow(/один із пари/);
    const cfg = loadConfig({
      ...FULL,
      BRAIN_ACCESS_CLIENT_ID: 'id',
      BRAIN_ACCESS_CLIENT_SECRET: 's',
    });
    expect(cfg.accessClientId).toBe('id');
    expect(cfg.accessClientSecret).toBe('s');
  });

  it('PORT: число в межах приймається, сміття - відмова', () => {
    expect(loadConfig({ ...FULL, PORT: '18788' }).port).toBe(18788);
    for (const bad of ['0', '65536', 'вісім', '80.5']) {
      expect(() => loadConfig({ ...FULL, PORT: bad })).toThrow(/PORT/);
    }
  });
});
