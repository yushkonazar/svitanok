// Weekly backup state crosses cron invocations and external Drive writes. KV
// remains a rollback seed/mirror; a lease owns the active backup attempt.
export const BACKUP_STATE_DO_NAME = 'backup-state';
export const BACKUP_STATE_KEY = 'backupState';
export const BACKUP_LEASE_MS = 30 * 60_000;
