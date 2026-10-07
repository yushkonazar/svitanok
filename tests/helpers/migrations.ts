import { readdirSync } from 'node:fs';
import { join } from 'node:path';

/** Lifecycle contract tests must cover new migrations without a manual list. */
export const ALL_MIGRATIONS = readdirSync(join(__dirname, '..', '..', 'web', 'core', 'migrations'))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
