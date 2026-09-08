// Скоупи Google, Tasks і Sheets-експорт (етап 7 PR-1, 05-ops §2, S-8-3/S-8-4,
// S-8-7, S-N4-4).
//
// ГОЛОВНЕ ТУТ - ДРУГА СТОРОНА ЗВІРКИ. Тест на брак скоупа очевидний і його
// легко написати так, що він зеленітиме і на токені з `gmail.send`. Тому
// нижче явно перевіряється, що ЗАЙВИЙ скоуп теж робить звірку червоною: саме
// він - тихий ризик, бо нічого не ламає і ніколи не буде помічений сам.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  CORE_SCOPES,
  SCOPE_BY_FEATURE,
  auditScopes,
  parseGrantedScopes,
  hasFeatureScope,
  featureNotConnectedText,
  extraScopesAlertText,
} from '../web/core/google-scopes.mjs';
import { createTask, taskDueRfc3339 } from '../web/core/adapters/tasks.mjs';
import { uploadCsvAsSheet, SHEET_MIME } from '../web/core/adapters/drive.mjs';
import { applyPolicy, resolveProposal } from '../web/core/policy/proposals.mjs';
import { workerEnv } from './helpers/env.js';
import { memoryKv } from './helpers/kv.js';
import { d1FromSqlite } from './helpers/d1.js';

const NOW = Date.parse('2026-09-08T09:00:00.000Z');
const ALL = CORE_SCOPES.join(' ');

/** Env із кешем токена в KV: саме звідти рантайм бере перелік скоупів. */
function makeEnv(scopes: string | null, over: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  if (scopes !== null) {
    store.set(
      'googleToken',
      JSON.stringify({ token: 'tok', expMs: NOW + 600_000, ...(scopes ? { scope: scopes } : {}) }),
    );
  }
  const d1 = d1FromSqlite([
    '0001_base.sql',
    '0002_assistant.sql',
    '0003_telemetry.sql',
    '0004_ideas_travel.sql',
    '0006_inbox_collections.sql',
  ]);
  const env = workerEnv({
    ASSISTANT_V2: 'on',
    GOOGLE_CLIENT_ID: 'id',
    GOOGLE_CLIENT_SECRET: 'secret',
    GOOGLE_REFRESH_TOKEN: 'refresh',
    BRIEFING: memoryKv(store),
    DB: d1.stub,
    ...over,
  });
  return { env, d1, store };
}

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('перелік скоупів ядра', () => {
  it('рівно пʼять і жодного скоупа на надсилання пошти', () => {
    expect([...CORE_SCOPES]).toEqual([
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/contacts',
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/tasks',
    ]);
    // ADR-019: «надіслати лист неможливо» має лишатись правдою про ПРАВА, а
    // не лише про поточний код.
    expect(CORE_SCOPES).not.toContain('https://www.googleapis.com/auth/gmail.send');
    // Sheets робиться конверсією Drive, окремий скоуп не потрібен (S-N4-4).
    expect(CORE_SCOPES).not.toContain('https://www.googleapis.com/auth/spreadsheets');
  });

  it('кожна можливість посилається на скоуп зі списку', () => {
    for (const scope of Object.values(SCOPE_BY_FEATURE)) expect(CORE_SCOPES).toContain(scope);
  });
});

describe('auditScopes', () => {
  it('точний збіг - ok', () => {
    expect(auditScopes([...CORE_SCOPES])).toEqual({
      known: true,
      ok: true,
      missing: [],
      extra: [],
    });
  });

  it('брак скоупа - not ok, названо саме той, якого нема', () => {
    const partial = CORE_SCOPES.filter((s) => !s.endsWith('/tasks'));
    const audit = auditScopes(partial);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual(['https://www.googleapis.com/auth/tasks']);
    expect(audit.extra).toEqual([]);
  });

  it('ЗАЙВИЙ скоуп - not ok, навіть коли всі потрібні на місці', () => {
    const audit = auditScopes([...CORE_SCOPES, 'https://www.googleapis.com/auth/gmail.send']);
    expect(audit.ok).toBe(false);
    expect(audit.missing).toEqual([]);
    expect(audit.extra).toEqual(['https://www.googleapis.com/auth/gmail.send']);
    expect(extraScopesAlertText(audit.extra)).toContain('gmail.send');
  });

  it('ширший скоуп замість вужчого теж зайвий (drive проти drive.file)', () => {
    const audit = auditScopes([
      ...CORE_SCOPES.filter((s) => !s.endsWith('drive.file')),
      'https://www.googleapis.com/auth/drive',
    ]);
    expect(audit.missing).toEqual(['https://www.googleapis.com/auth/drive.file']);
    expect(audit.extra).toEqual(['https://www.googleapis.com/auth/drive']);
  });

  it('невідомі скоупи (кеш без поля) нічого не блокують', () => {
    expect(auditScopes(null)).toEqual({ known: false, ok: true, missing: [], extra: [] });
    expect(parseGrantedScopes('')).toBeNull();
    expect(parseGrantedScopes(undefined)).toBeNull();
    expect(hasFeatureScope(null, 'tasks')).toBe(true);
  });

  it('parseGrantedScopes прибирає дублі й порожні розділювачі', () => {
    expect(parseGrantedScopes('  a   b  a ')).toEqual(['a', 'b']);
  });

  it('невідома можливість - помилка коду, не «дозволено»', () => {
    expect(() => hasFeatureScope([...CORE_SCOPES], 'sheets')).toThrow(/невідома можливість/);
  });
});

describe('барʼєр можливості (S-8-7)', () => {
  it('Tasks без скоупа - чесний текст власнику, жодного HTTP', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { env } = makeEnv(CORE_SCOPES.filter((s) => !s.endsWith('/tasks')).join(' '));
    await expect(createTask(env, { title: 'купити молоко' })).rejects.toThrow(
      /Tasks ще не підключено/,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(featureNotConnectedText('tasks')).toContain('auth/tasks');
  });

  it('Drive без скоупа - завантаження таблиці не починається', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { env } = makeEnv(CORE_SCOPES.filter((s) => !s.endsWith('drive.file')).join(' '));
    await expect(
      uploadCsvAsSheet(env, { name: 'Сервіси', parentId: 'folder-1', csv: 'a,b\n1,2\n' }),
    ).rejects.toThrow(/Drive ще не підключено/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('adapters/tasks', () => {
  it('due нормалізується до дати; сміття - без строку', () => {
    expect(taskDueRfc3339('2026-09-10')).toBe('2026-09-10T00:00:00.000Z');
    expect(taskDueRfc3339('2026-09-10T18:30:00.000Z')).toBe('2026-09-10T00:00:00.000Z');
    expect(taskDueRfc3339('завтра')).toBeNull();
    expect(taskDueRfc3339(null)).toBeNull();
  });

  it('створює задачу і віддає СТРОК ІЗ ВІДПОВІДІ, не з запиту', async () => {
    const { env } = makeEnv(ALL);
    const seen: { url: string; body: unknown } = { url: '', body: null };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      seen.url = String(url);
      seen.body = JSON.parse(String((init as RequestInit).body));
      // Google строк відкинув - у відповіді його немає.
      return new Response(JSON.stringify({ id: 't1', title: 'купити молоко' }), { status: 200 });
    });
    const task = await createTask(env, { title: 'купити молоко', due: '2026-09-10T18:30:00Z' });
    expect(seen.url).toContain('/lists/@default/tasks');
    expect(seen.body).toMatchObject({ title: 'купити молоко', due: '2026-09-10T00:00:00.000Z' });
    expect(task).toMatchObject({ id: 't1', due: null });
  });

  it('HTTP-помилка Google - виняток, а не тихе «ок»', async () => {
    const { env } = makeEnv(ALL);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 403 }));
    await expect(createTask(env, { title: 'x' })).rejects.toThrow(/Tasks HTTP 403/);
  });

  it('порожній title - відмова до мережі', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { env } = makeEnv(ALL);
    await expect(createTask(env, { title: '   ' })).rejects.toThrow(/потрібен title/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('Sheets через конверсію Drive (S-N4-4)', () => {
  it('метадані несуть mimeType таблиці, вміст - CSV у utf-8', async () => {
    const { env } = makeEnv(ALL);
    let metadata = '';
    let contentType = '';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const form = (init as RequestInit).body as FormData;
      metadata = await (form.get('metadata') as Blob).text();
      contentType = (form.get('file') as Blob).type;
      expect(String(url)).toContain('webViewLink');
      return new Response(
        JSON.stringify({ id: 's1', name: 'Сервіси', webViewLink: 'https://docs/1' }),
        { status: 200 },
      );
    });
    const sheet = await uploadCsvAsSheet(env, {
      name: 'Сервіси',
      parentId: 'f1',
      csv: 'назва\nSpotify\n',
    });
    expect(JSON.parse(metadata)).toMatchObject({ mimeType: SHEET_MIME, parents: ['f1'] });
    expect(contentType).toBe('text/csv;charset=utf-8');
    expect(sheet).toMatchObject({ id: 's1', link: 'https://docs/1' });
  });
});

describe('виконавці етапу 7 у policy', () => {
  /** Пропозиція → ✅ → результат виконавця. */
  async function approve(env: Env, kind: string, payload: Record<string, unknown>) {
    const decided = await applyPolicy(env, { kind, payload, tainted: false }, NOW);
    if (decided.mode !== 'proposed')
      throw new Error(`очікувалась пропозиція, а не ${decided.mode}`);
    return resolveProposal(
      env,
      { id: decided.proposal.id, choice: 'ok', word: decided.proposal.word ?? undefined },
      NOW,
    );
  }

  it('tasks.create - T1, після ✅ задача справді створена', async () => {
    const { env } = makeEnv(ALL);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ id: 't9', title: 'молоко', due: '2026-09-10T00:00:00.000Z' }), {
        status: 200,
      }),
    );
    const res = await approve(env, 'tasks.create', { title: 'молоко', due: '2026-09-10' });
    expect(res).toMatchObject({ ok: true, result: { task_id: 't9', due: '2026-09-10' } });
  });

  it('collection.export to=sheets віддає лінк на таблицю, не документ у чат', async () => {
    const { env, d1 } = makeEnv(ALL);
    d1.db.exec(
      `INSERT INTO collections (id, name, description, fields_json, sort_by, created_at)
       VALUES ('c1', 'Сервіси', '', '[{"name":"назва","type":"text"}]', 'назва', '2026-09-01T00:00:00.000Z')`,
    );
    d1.db.exec(
      `INSERT INTO records (id, collection_id, data_json, created_at, updated_at)
       VALUES ('r1', 'c1', '{"назва":"Spotify"}', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`,
    );
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
      String(url).includes('/upload/')
        ? new Response(
            JSON.stringify({ id: 's7', name: 'Сервіси', webViewLink: 'https://docs/7' }),
            {
              status: 200,
            },
          )
        : new Response(JSON.stringify({ files: [{ id: 'folder', name: 'export' }] }), {
            status: 200,
          }),
    );
    const res = await approve(env, 'collection.export', { collection: 'Сервіси', to: 'sheets' });
    expect(res).toMatchObject({ ok: true, result: { sheet_id: 's7', link: 'https://docs/7' } });
  });

  it('calendar.update: час лише парою, порожній патч - відмова', async () => {
    const { env } = makeEnv(ALL);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      approve(env, 'calendar.update', { event_id: 'abc', startIso: '2026-09-10T10:00:00Z' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('парою') });
    await expect(approve(env, 'calendar.update', { event_id: 'abc' })).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('немає жодного поля'),
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('calendar.delete без валідного event_id не йде в URL', async () => {
    const { env } = makeEnv(ALL);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      approve(env, 'calendar.delete', { event_id: 'a/../../secret' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('потрібен event_id') });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('drive.write кладе нотатку в «Світанок/нотатки» і чистить назву', async () => {
    const { env } = makeEnv(ALL);
    let uploadedName = '';
    const folders: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes('/upload/')) {
        const form = (init as RequestInit).body as FormData;
        uploadedName = JSON.parse(await (form.get('metadata') as Blob).text()).name;
        return new Response(JSON.stringify({ id: 'n1', name: uploadedName, size: 10 }), {
          status: 200,
        });
      }
      if ((init as RequestInit)?.method === 'POST') {
        folders.push(JSON.parse(String((init as RequestInit).body)).name);
        return new Response(JSON.stringify({ id: `f${folders.length}` }), { status: 200 });
      }
      return new Response(JSON.stringify({ files: [] }), { status: 200 });
    });
    const res = await approve(env, 'drive.write', {
      name: '../../секрети/нотатка',
      content_md: '# Думка',
    });
    expect(res).toMatchObject({ ok: true, result: { file_id: 'n1' } });
    expect(folders).toEqual(['Світанок', 'нотатки']);
    // Роздільники шляху не лишаються в імені файла Drive.
    expect(uploadedName).toBe('..-..-секрети-нотатка.md');
  });

  it('drive.write з порожнім вмістом - відмова, файл не створюється', async () => {
    const { env } = makeEnv(ALL);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(
      approve(env, 'drive.write', { name: 'н', content_md: '  ' }),
    ).resolves.toMatchObject({ ok: false, error: expect.stringContaining('порожній вміст') });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('settings мержить патч і нормалізує; «↩» повертає попередній блоб', async () => {
    const store = new Map<string, string>();
    store.set('googleToken', JSON.stringify({ token: 'tok', expMs: NOW + 600_000, scope: ALL }));
    store.set(
      'settings',
      JSON.stringify({
        quiet: { enabled: false, from: '22:00', to: '08:00' },
        modules: { news: true },
        mutedTopics: [],
      }),
    );
    const { env } = makeEnv(ALL, { BRIEFING: memoryKv(store) });
    const res = await approve(env, 'settings', { modules: { jobs: false } });
    expect(res).toMatchObject({ ok: true });
    const saved = JSON.parse(store.get('settings') ?? '{}');
    // Патч ДОДАЄТЬСЯ до наявних тумблерів, а не заміщає блоб цілком.
    expect(saved.modules).toEqual({ news: true, jobs: false });
    expect(saved.quiet).toEqual({ enabled: false, from: '22:00', to: '08:00' });
  });

  it('contact вимагає email, схожий на email', async () => {
    const { env } = makeEnv(ALL);
    await expect(approve(env, 'contact', { name: 'Марко', email: 'марко' })).resolves.toMatchObject(
      {
        ok: false,
        error: expect.stringContaining('не схоже на email'),
      },
    );
  });
});
