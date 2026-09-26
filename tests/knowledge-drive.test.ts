import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  inspectKnowledgeDriveFile,
  KNOWLEDGE_DRIVE_MAX_BYTES,
  readKnowledgeDriveFile,
} from '../web/core/adapters/knowledge-drive.mjs';
import { CORE_SCOPES } from '../web/core/google-scopes.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';

const FILE_ID = 'drive_file_2026';

/** OAuth тут уже свіжий: тести адаптера мають перевіряти запити до Drive, а
 * не окремий refresh-token flow. */
function envWithToken(scopes = [...CORE_SCOPES]) {
  const store = new Map([
    [
      'googleToken',
      JSON.stringify({
        token: 'access-token',
        expMs: Date.now() + 3_600_000,
        scope: scopes.join(' '),
      }),
    ],
  ]);
  return workerEnv({
    GOOGLE_CLIENT_ID: 'client',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    BRIEFING: memoryKv(store),
  });
}

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    id: FILE_ID,
    name: 'Конспект співбесіди',
    mimeType: 'application/vnd.google-apps.document',
    version: '42',
    modifiedTime: '2026-09-26T12:00:00.000Z',
    size: '123',
    trashed: false,
    capabilities: { canDownload: true },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('knowledge Drive adapter', () => {
  it('reads metadata for exactly the named id; it has no Drive search/list route', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(metadata()), { status: 200 }));

    await expect(inspectKnowledgeDriveFile(envWithToken(), { fileId: FILE_ID })).resolves.toEqual({
      file_id: FILE_ID,
      title: 'Конспект співбесіди',
      mime_type: 'application/vnd.google-apps.document',
      source_version: '42',
      size: 123,
      importable: true,
      format: 'google-document',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(fetchSpy.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/drive/v3/files/${FILE_ID}`);
    expect(url.searchParams.get('fields')).toContain('version');
    expect(url.pathname).not.toContain('/files?q=');
  });

  it('requires the dedicated readonly scope before any Drive HTTP request', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const scopes = CORE_SCOPES.filter((scope) => !scope.endsWith('drive.readonly'));
    await expect(
      inspectKnowledgeDriveFile(envWithToken(scopes), { fileId: FILE_ID }),
    ).rejects.toThrow(/читання Drive зараз недоступне[\s\S]*google-auth/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('downloads only the safe Google Doc text export after a repeat metadata check', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (rawUrl) => {
      const url = new URL(String(rawUrl));
      if (url.pathname.endsWith('/export')) {
        expect(url.searchParams.get('mimeType')).toBe('text/plain');
        return new Response('Доказ із документа.\n\nДругий абзац.', { status: 200 });
      }
      return new Response(JSON.stringify(metadata()), { status: 200 });
    });

    await expect(
      readKnowledgeDriveFile(envWithToken(), {
        fileId: FILE_ID,
        title: 'Конспект співбесіди',
        sourceVersion: '42',
        mimeType: 'application/vnd.google-apps.document',
      }),
    ).resolves.toEqual({
      sourceType: 'drive',
      sourceRef: FILE_ID,
      title: 'Конспект співбесіди',
      sourceVersion: '42',
      content: 'Доказ із документа.\n\nДругий абзац.',
    });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('rejects a changed version before downloading any bytes', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(metadata({ version: '43' })), { status: 200 }),
      );
    await expect(
      readKnowledgeDriveFile(envWithToken(), {
        fileId: FILE_ID,
        title: 'Конспект співбесіди',
        sourceVersion: '42',
        mimeType: 'application/vnd.google-apps.document',
      }),
    ).rejects.toThrow(/змінився після перевірки/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('marks an unsupported file as non-importable without downloading it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify(metadata({ mimeType: 'application/pdf' })), { status: 200 }),
      );
    await expect(
      inspectKnowledgeDriveFile(envWithToken(), { fileId: FILE_ID }),
    ).resolves.toMatchObject({
      importable: false,
      reason: expect.stringContaining('Google Docs'),
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects a declared oversized file at metadata time', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(metadata({ size: String(KNOWLEDGE_DRIVE_MAX_BYTES + 1) })), {
        status: 200,
      }),
    );
    await expect(inspectKnowledgeDriveFile(envWithToken(), { fileId: FILE_ID })).rejects.toThrow(
      /більший за/,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
