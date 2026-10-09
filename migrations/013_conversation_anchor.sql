-- TASK-1243: one requirement = one Feishu topic.
--
-- Feishu's send API has no "post into thread <id>" form; a message only lands in
-- a topic by replying to a message that is already in it. So the control plane
-- remembers the message a conversation's topic was started from and replies
-- there for everything belonging to that requirement.
--
-- Idempotent so the dev-grade migration runner can re-apply it.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS anchor_message_id TEXT;
