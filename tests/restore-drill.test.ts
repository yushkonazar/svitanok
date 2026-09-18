import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { BACKUP_TABLES, buildBackupDocument, encryptBackup } from '../web/core/backup/core.mjs';
import { parseArgs, restoreDrill } from '../scripts/restore-drill.mjs';

const SECRET = 'a sufficiently long backup test secret';

describe('restore-drill', () => {
  it('відновлює шифрований backup у чисту актуальну схему та звіряє рядки', async () => {
    const doc = buildBackupDocument({
      createdMs: Date.parse('2026-09-18T10:00:00.000Z'),
      envName: 'test',
      tables: {
        counters: [{ name: 'ideas', value: 7 }],
        facts: [
          {
            id: 'fact-1',
            kind: 'setting',
            key: 'timezone',
            value_json: '"Europe/Kyiv"',
            source: 'owner_assertion',
            confidence: 1,
            created_at: '2026-09-18T10:00:00.000Z',
            updated_at: '2026-09-18T10:00:00.000Z',
          },
        ],
      },
      kv: { state: '{"safe":true}' },
    });
    const dir = mkdtempSync(join(tmpdir(), 'svitanok-restore-drill-'));
    const file = join(dir, 'backup.enc');
    writeFileSync(file, await encryptBackup(SECRET, doc));

    await expect(
      restoreDrill(parseArgs(['--file', file]), { secret: SECRET, log: () => {} }),
    ).resolves.toMatchObject({
      migrations: expect.any(Number),
      verifiedTables: BACKUP_TABLES.length,
    });
  });

  it('вимагає файл та ключ, але не має шляху до remote restore', async () => {
    expect(parseArgs([])).toEqual({ file: null });
    await expect(restoreDrill({ file: null }, { secret: SECRET })).rejects.toThrow(/--file/);
    await expect(restoreDrill({ file: 'never-read.enc' }, { secret: undefined })).rejects.toThrow(
      /BACKUP_ENC_KEY/,
    );
  });
});
