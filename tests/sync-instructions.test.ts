// Синк інструкцій (етап 2 PR-5): те, що можна перевірити без мережі -
// зчитування id бази з wrangler.jsonc і той факт, що workflow справді кличе
// скрипт із потрібними секретами. Мережеву частину (D1 REST) перевіряє сам
// прогін: він читає записане назад і звіряє хеші.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readDatabaseId } from '../scripts/sync-instructions.mjs';

const ROOT = join(__dirname, '..');

describe('readDatabaseId', () => {
  it('дістає id з JSONC із коментарями й URL-ами (наївне вирізання // зламалося б)', () => {
    const jsonc = `{
      // база нового асистента
      "vars": { "BRAIN_URL": "https://brain.example/x" },
      "d1_databases": [
        { "binding": "DB", "database_id": "ac371a2e-47eb-44a2-ae9e-6c205a16f919" },
      ],
    }`;
    expect(readDatabaseId(jsonc)).toBe('ac371a2e-47eb-44a2-ae9e-6c205a16f919');
  });

  it('на справжньому wrangler.jsonc віддає id прив’язки DB', () => {
    const raw = readFileSync(join(ROOT, 'web', 'wrangler.jsonc'), 'utf8');
    const id = readDatabaseId(raw);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    // Саме той рядок, що поруч із binding DB, - не якийсь інший uuid у файлі.
    expect(raw).toMatch(new RegExp(`"binding":\\s*"DB"[\\s\\S]{0,200}${id}`));
  });

  it('без database_id - гучна помилка, не порожній рядок', () => {
    expect(() => readDatabaseId('{ "d1_databases": [] }')).toThrow('не знайшов database_id');
  });
});

describe('workflow sync-instructions.yml', () => {
  const wf = readFileSync(join(ROOT, '.github', 'workflows', 'sync-instructions.yml'), 'utf8');

  it('слухає саме ті шляхи, зміна яких міняє вміст D1', () => {
    expect(wf).toContain('branches: [main]');
    expect(wf).toContain('docs/assistant/**');
    expect(wf).toContain('scripts/sync-instructions.mjs');
    expect(wf).toContain('web/core/instructions.mjs');
  });

  it('кличе скрипт із секретами акаунта і без cancel-in-progress', () => {
    expect(wf).toContain('node scripts/sync-instructions.mjs');
    expect(wf).toContain('secrets.CF_API_TOKEN');
    expect(wf).toContain('secrets.CF_ACCOUNT_ID');
    expect(wf).toContain('cancel-in-progress: false');
    // id бази - з конфігу, не продубльований у workflow.
    expect(wf).not.toMatch(/D1_DATABASE_ID:\s*[0-9a-f-]{36}/);
  });
});
