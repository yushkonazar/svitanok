// Atomic accounting for the daily inbound Business-message cap. Inbox rows stay
// in D1; only the cross-invocation admission counter needs a control plane.

export const INBOX_QUOTA_DO_NAME = 'inbox-quota';
export const INBOX_COUNT_KEY = 'inboxDayCount';
