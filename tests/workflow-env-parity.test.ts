import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { walkFiles } from './helpers/repo-files.js';

/* Звірка: чи доїжджають до рану ті змінні, які оркестратор читає.
 *
 * ⚠️ ПРИВІД — ДВА ОДНАКОВІ ІНЦИДЕНТИ, обидва тихі.
 *
 * У GitHub Actions у `process.env` потрапляє ЛИШЕ те, що явно перелічено в
 * блоці `env:` кроку. Секрет, заведений у Settings -> Secrets, сам собою не
 * видно нізвідки. Тобто «я поклав секрет» і «код його бачить» — два різні
 * факти, і між ними немає нічого, що б їх звіряло.
 *
 *   1. `GOOGLE_TRANSLATE_API_KEY` (28f35d3, 04.08): переклад world-новин не
 *      спрацював ЖОДНОГО разу за місяць. Код був на місці, теми `translate:
 *      true` теж, секрет заведений — бракувало рядка в workflow.
 *   2. `OWNER_LOCATIONS` (22.08): те саме. Борг власника казав «постав у двох
 *      місцях», але одне з них не працювало б: `loadConfig` мовчки лишає
 *      config.yml, і брифінг щодня слав би погоду по Львову з Рівним.
 *
 * Обидва помітні лише за відсутністю очікуваного, а не за помилкою. Тест
 * закриває сам КЛАС: перелік не пишеться руками, а виводиться з викликів
 * `optionalSecret('X')` у `src/` — тобто нова змінна ловиться автоматично.
 */

const ROOT = join(__dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'brief.yml');

/** Імена з `optionalSecret('X')` — канонічний спосіб читати опційний секрет. */
function declaredSecrets(): string[] {
  const found = new Set<string>();
  for (const file of walkFiles(join(ROOT, 'src'), { exts: ['.ts'] })) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/optionalSecret\(\s*'([A-Z][A-Z0-9_]*)'/g)) {
      found.add(m[1]!);
    }
  }
  return [...found].sort();
}

/**
 * Змінні, доступні кроку оркестратора.
 *
 * Береться ВЕСЬ файл, а не один блок: змінна може приїхати і з `env:` кроку, і
 * з рівня job/workflow. Хибний «пропуск» тут гірший за хибну «наявність»:
 * перший ловить справжній дефект, друга лише не спрацює.
 */
function workflowEnvNames(): Set<string> {
  const yml = readFileSync(WORKFLOW, 'utf8');
  const names = new Set<string>();
  for (const m of yml.matchAll(/^\s{8,}([A-Z][A-Z0-9_]*):\s/gm)) names.add(m[1]!);
  return names;
}

describe('brief.yml — секрети доїжджають до оркестратора', () => {
  const env = workflowEnvNames();

  it('перелік виводиться з коду, а не з памʼяті (інакше тест теж протухне)', () => {
    const declared = declaredSecrets();
    // Захист від «регекс перестав щось знаходити й тест став порожнім».
    expect(declared.length).toBeGreaterThan(8);
    expect(declared).toContain('WEATHER_API_KEY');
  });

  it.each(declaredSecrets())('%s перелічений у workflow', (name) => {
    expect(env.has(name)).toBe(true);
  });

  /* Читається не через optionalSecret, а через loadConfig -> locationsFromEnv,
     тож регексом вище не ловиться. Пінимо поіменно — це і є та змінна, через
     яку тест зʼявився. */
  it('OWNER_LOCATIONS перелічений (інакше брифінг мовчки шле фолбек)', () => {
    expect(env.has('OWNER_LOCATIONS')).toBe(true);
  });

  it('критичні секрети теж на місці', () => {
    expect(env.has('TELEGRAM_BOT_TOKEN')).toBe(true);
    expect(env.has('TELEGRAM_CHAT_ID')).toBe(true);
  });
});
