-- Фінальні звіти мозку можуть ретраїтися після network timeout. Один номер
-- кроку має існувати лише раз для run; старі дублікати telemetry безпечно
-- зводимо до найпершого запису перед створенням унікального індексу.

DELETE FROM run_steps
WHERE rowid NOT IN (
  SELECT MIN(rowid)
  FROM run_steps
  GROUP BY run_id, n
);

CREATE UNIQUE INDEX idx_run_steps_run_n_unique ON run_steps (run_id, n);
