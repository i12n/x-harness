-- Problem-domain events carry the problem id alongside task/run ids.

ALTER TABLE events ADD COLUMN IF NOT EXISTS problem_id TEXT;
