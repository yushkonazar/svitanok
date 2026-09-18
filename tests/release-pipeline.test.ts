import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), 'utf8');

describe('immutable brain release pipeline', () => {
  const workflow = read('.github', 'workflows', 'deploy-host.yml');
  const migrations = read('.github', 'workflows', 'migrate.yml');
  const script = read('.github', 'scripts', 'deploy-brain-release.sh');
  const unit = read('brain', 'svitanok-brain.service');
  const stamp = read('brain', 'scripts', 'stamp-build.mjs');
  const drill = read('scripts', 'restore-drill.mjs');

  it('deploy workflow executes the helper from the exact requested commit', () => {
    expect(workflow).toContain('git show "$SHA:.github/scripts/deploy-brain-release.sh" | bash');
    expect(workflow).not.toContain('git checkout --detach "$SHA"');
  });

  it('builds off-line, atomically switches only after a manifest, and rolls back on failed readiness', () => {
    expect(script).toContain('git worktree add --detach');
    expect(script).toContain('release-manifest.json');
    expect(script).toContain('mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"');
    expect(script).toContain('curl -sf http://127.0.0.1:8788/ready');
    expect(script).toContain('rollback');
    expect(script).not.toMatch(/\brm\s+-rf\b/);
  });

  it('service runs only through the immutable current symlink and keeps writable state outside releases', () => {
    expect(unit).toContain('WorkingDirectory=/opt/svitanok-brain-current/brain');
    expect(unit).toContain('EnvironmentFile=/opt/svitanok-brain-shared/brain.env');
    expect(unit).toContain('ReadWritePaths=/opt/svitanok-brain-shared/data');
    expect(unit).toContain('TimeoutStopSec=120');
  });

  it('build stamp emits a release manifest that binds schema, Worker, tools and instructions', () => {
    expect(stamp).toContain("'release-manifest.json'");
    expect(stamp).toContain('release-phase header');
    expect(stamp).toContain('migrations');
    expect(stamp).toContain('sourceDigest');
    expect(stamp).toContain('wranglerDigest');
    expect(stamp).toContain('toolSchemaDigest');
    expect(stamp).toContain('instructions: { digest');
  });

  it('blocks a changed contract migration unless a manual restore drill is recorded', () => {
    expect(migrations).toContain('allow_contract');
    expect(migrations).toContain('restore_evidence');
    expect(migrations).toContain('-- release-phase: contract');
    expect(migrations).toContain('contract migration requires restore drill evidence');
  });

  it('has a non-destructive clean restore drill for the recorded evidence', () => {
    expect(drill).toContain("new DatabaseSync(':memory:')");
    expect(drill).toContain('restoreSql(doc)');
    expect(drill).toContain('BACKUP_TABLES');
    expect(drill).not.toContain('--remote');
  });
});
