import { describe, expect, it, vi } from 'vitest';
import {
  FILE_SEARCH_EXPERIMENT_OPT_IN,
  SYNTHETIC_MARKER,
  loadSyntheticExperimentConfig,
  runSyntheticFileSearchExperiment,
} from '../scripts/openai-file-search-experiment.mjs';

const CONFIG = { apiKey: 'test-key', model: 'gpt-test' };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('ізольований OpenAI File Search experiment', () => {
  it('fail-closed без точного synthetic-only opt-in та без ключа', () => {
    expect(() => loadSyntheticExperimentConfig({ OPENAI_API_KEY: 'key' })).toThrow(
      /OPENAI_FILE_SEARCH_EXPERIMENT/,
    );
    expect(() =>
      loadSyntheticExperimentConfig({
        OPENAI_FILE_SEARCH_EXPERIMENT: FILE_SEARCH_EXPERIMENT_OPT_IN,
      }),
    ).toThrow(/OPENAI_API_KEY/);
    expect(
      loadSyntheticExperimentConfig({
        OPENAI_FILE_SEARCH_EXPERIMENT: FILE_SEARCH_EXPERIMENT_OPT_IN,
        OPENAI_API_KEY: ' key ',
        OPENAI_MODEL_STANDARD: 'gpt-6-sol',
      }),
    ).toEqual({ apiKey: 'key', model: 'gpt-6-sol' });
  });

  it('надсилає лише synthetic файл, вимагає store:false і прибирає store та backing file', async () => {
    const urls: string[] = [];
    const bodies: unknown[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const textUrl = String(url);
      urls.push(textUrl);
      bodies.push(init?.body ?? null);
      if (textUrl.endsWith('/vector_stores/vs-synthetic/files') && init?.method === 'POST')
        return json({ id: 'file-synthetic', status: 'in_progress' });
      if (textUrl.endsWith('/files') && init?.method === 'POST')
        return json({ id: 'file-synthetic' });
      if (textUrl.endsWith('/vector_stores') && init?.method === 'POST')
        return json({ id: 'vs-synthetic' });
      if (textUrl.endsWith('/vector_stores/vs-synthetic/files/file-synthetic'))
        return json({ id: 'file-synthetic', status: 'completed' });
      if (textUrl.endsWith('/responses'))
        return json({
          status: 'completed',
          output: [
            {
              type: 'file_search_call',
              status: 'completed',
              search_results: [{ content: [{ text: SYNTHETIC_MARKER }] }],
            },
          ],
        });
      if (textUrl.endsWith('/vector_stores/vs-synthetic') && init?.method === 'DELETE')
        return json({ deleted: true });
      if (textUrl.endsWith('/files/file-synthetic') && init?.method === 'DELETE')
        return json({ deleted: true });
      throw new Error(`unexpected URL ${textUrl}`);
    }) as unknown as typeof fetch;

    const result = await runSyntheticFileSearchExperiment(CONFIG, {
      fetchFn,
      sleep: async () => undefined,
      now: () => 100,
    });

    expect(result).toMatchObject({
      ok: true,
      syntheticOnly: true,
      indexed: true,
      fileSearchVerified: true,
      cleanup: { vectorStoreDeleted: true, fileDeleted: true },
    });
    const upload = bodies[0];
    expect(upload).toBeInstanceOf(FormData);
    expect((upload as FormData).get('purpose')).toBe('user_data');
    expect(await ((upload as FormData).get('file') as Blob).text()).toContain(SYNTHETIC_MARKER);
    const request = JSON.parse(String(bodies[4]));
    expect(request).toMatchObject({
      store: false,
      include: ['file_search_call.results'],
      tools: [{ type: 'file_search', vector_store_ids: ['vs-synthetic'] }],
    });
    expect(urls.slice(-2)).toEqual([
      'https://api.openai.com/v1/vector_stores/vs-synthetic',
      'https://api.openai.com/v1/files/file-synthetic',
    ]);
  });

  it('не залишає external objects, якщо Responses повернув помилку', async () => {
    const urls: string[] = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const textUrl = String(url);
      urls.push(textUrl);
      if (textUrl.endsWith('/vector_stores/vs-synthetic/files') && init?.method === 'POST')
        return json({ id: 'file-synthetic', status: 'in_progress' });
      if (textUrl.endsWith('/files') && init?.method === 'POST')
        return json({ id: 'file-synthetic' });
      if (textUrl.endsWith('/vector_stores') && init?.method === 'POST')
        return json({ id: 'vs-synthetic' });
      if (textUrl.endsWith('/vector_stores/vs-synthetic/files/file-synthetic'))
        return json({ id: 'file-synthetic', status: 'completed' });
      if (textUrl.endsWith('/responses')) return json({ error: { message: 'nope' } }, 429);
      if (init?.method === 'DELETE') return json({ deleted: true });
      throw new Error(`unexpected URL ${textUrl}`);
    }) as unknown as typeof fetch;

    await expect(
      runSyntheticFileSearchExperiment(CONFIG, { fetchFn, sleep: async () => undefined }),
    ).rejects.toThrow('OpenAI File Search HTTP 429');
    expect(urls.slice(-2)).toEqual([
      'https://api.openai.com/v1/vector_stores/vs-synthetic',
      'https://api.openai.com/v1/files/file-synthetic',
    ]);
  });

  it('вважає cleanup failure за failure, а не повертає хибний success', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const textUrl = String(url);
      if (textUrl.endsWith('/vector_stores/vs-synthetic/files') && init?.method === 'POST')
        return json({ id: 'file-synthetic', status: 'in_progress' });
      if (textUrl.endsWith('/files') && init?.method === 'POST')
        return json({ id: 'file-synthetic' });
      if (textUrl.endsWith('/vector_stores') && init?.method === 'POST')
        return json({ id: 'vs-synthetic' });
      if (textUrl.endsWith('/vector_stores/vs-synthetic/files/file-synthetic'))
        return json({ id: 'file-synthetic', status: 'completed' });
      if (textUrl.endsWith('/responses'))
        return json({
          status: 'completed',
          output: [
            {
              type: 'file_search_call',
              status: 'completed',
              search_results: [{ content: [{ text: SYNTHETIC_MARKER }] }],
            },
          ],
        });
      if (init?.method === 'DELETE') return json({ error: {} }, 500);
      throw new Error(`unexpected URL ${textUrl}`);
    }) as unknown as typeof fetch;

    await expect(
      runSyntheticFileSearchExperiment(CONFIG, { fetchFn, sleep: async () => undefined }),
    ).rejects.toThrow('cleanup: vector store, file');
  });
});
