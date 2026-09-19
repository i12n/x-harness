-- Phase 12 / TASK-1204: at most one active Run per Task.
--
-- The Scheduler already skips tasks with an active run, but that check is a
-- read-then-insert: two Schedulers (or two processes) could both see an idle
-- task and create two Runs. This partial unique index is the DB-level backstop
-- so `Run(Task X) = 1` holds under concurrency; terminal runs (SUCCEEDED /
-- FAILED / TIMED_OUT / CANCELLED / LOST) are unaffected, so retry and the
-- attempt counter keep working.
--
-- Idempotent so it can be re-applied by the dev-grade migration runner.

CREATE UNIQUE INDEX IF NOT EXISTS runs_active_task_idx
    ON runs (task_id)
    WHERE status IN ('QUEUED', 'STARTING', 'RUNNING', 'VERIFYING');
