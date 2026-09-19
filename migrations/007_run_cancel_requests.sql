-- Phase 11 / TASK-1108: cancellation is a persisted control intent.
-- Run.status keeps describing facts; cancel_requested_* describes the request.

ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS cancel_requested_at TIMESTAMPTZ;

ALTER TABLE runs
    ADD COLUMN IF NOT EXISTS cancel_requested_by TEXT;

CREATE INDEX IF NOT EXISTS runs_cancel_requested_idx
    ON runs (cancel_requested_at)
    WHERE cancel_requested_at IS NOT NULL;
