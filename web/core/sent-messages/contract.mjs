// Контракт singleton Durable Object для ring-buffer `sentMessages`. Ім'я
// binding винесене з класу, щоб Worker-клієнти не тягнули cloudflare:workers.

/** Один owner-state store: record/forget мають лінеаризуватися між webhook,
 * cron і outbox-викликами, навіть якщо вони приходять з різних ізолятів. */
export const SENT_MESSAGES_DO_NAME = 'sent-messages';

/** Legacy KV mirror для rollout, rollback і зовнішнього backup-формату. */
export const SENT_MESSAGES_KEY = 'sentMessages';
