import { DatabaseSync } from 'node:sqlite';

const AT = '2026-10-05T10:00:00.000Z';

/** Synthetic rows only: no production database, credentials or user documents. */
export function lifecycleRows(): Record<string, Record<string, string | number | null>[]> {
  return {
    work_contexts: [
      {
        id: 'synthetic-context',
        scope_key: 'synthetic-scope',
        chat_id: 'test-chat',
        thread_id: '',
        work_date: '2026-10-05',
        opened_at: AT,
        activated_at: AT,
        started_at: null,
        finished_at: AT,
        confirmation_at: null,
      },
    ],
    context_reminders: [
      {
        id: 'synthetic-context-task',
        context_id: 'synthetic-context',
        text: 'Тест — лимон',
        source_key: 'synthetic-message',
        status: 'notified',
        created_at: AT,
        updated_at: AT,
        delivery_id: 'synthetic-context-delivery',
        edit_until: null,
      },
    ],
    context_deliveries: [
      {
        id: 'synthetic-context-delivery',
        context_id: 'synthetic-context',
        snapshot_json: JSON.stringify([{ id: 'synthetic-context-task', text: 'Тест — лимон' }]),
        created_at: AT,
      },
    ],
    knowledge_documents: [
      {
        id: 'kd',
        source_type: 'upload',
        source_ref: 'synthetic',
        title: 'Тестові знання',
        kind: 'learning',
        access_scope: 'owner',
        status: 'active',
        created_at: AT,
        revoked_at: null,
      },
    ],
    knowledge_document_versions: [
      {
        id: 'kv',
        document_id: 'kd',
        source_version: 'v1',
        content_sha256: 'fixture-hash',
        status: 'ready',
        extracted_at: AT,
        error: null,
      },
    ],
    knowledge_chunks: [
      {
        id: 'kc',
        document_version_id: 'kv',
        ordinal: 0,
        section: 'Тест',
        page: 1,
        text: 'Навчальний текст: лимон',
        vector_id: 'kc',
        projection_status: 'ready',
        created_at: AT,
      },
    ],
    reports: [
      {
        id: 'report-fixture',
        kind: 'researcher',
        period_from: null,
        period_to: null,
        text_md: 'Тестовий звіт',
        instruction_hash: 'fixture',
        created_at: AT,
      },
    ],
    worker_card_actions: [
      { report_id: 'report-fixture', action_key: 'quality:good', created_at: AT },
    ],
    learning_sessions: [
      {
        id: 'lesson',
        thread_id: 'dm',
        chat_id: 'test-chat',
        topic: 'Тестова тема',
        question_text: 'Тестове питання',
        answer_text: null,
        review_text: null,
        status: 'question',
        rating: null,
        due_at: null,
        created_at: AT,
        updated_at: AT,
      },
    ],
  };
}

export function seedLifecycleRows(db: DatabaseSync) {
  const tables = lifecycleRows();
  for (const [table, rows] of Object.entries(tables)) {
    for (const row of rows) {
      const columns = Object.keys(row);
      db.prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`,
      ).run(...Object.values(row));
    }
  }
  return tables;
}
