-- Phase 11 / TASK-1102: conversation state between Channel and Harness.

CREATE TABLE IF NOT EXISTS conversations (
    id                  TEXT PRIMARY KEY,

    channel             TEXT NOT NULL,
    external_chat_id    TEXT NOT NULL,
    external_thread_id  TEXT,

    title               TEXT,

    -- Optional link to a Harness subject; never a lifecycle controller.
    subject_type        TEXT,              -- problem | task | run
    subject_id          TEXT,

    status              TEXT NOT NULL,     -- ACTIVE | CLOSED

    created_at          TIMESTAMPTZ NOT NULL,
    updated_at          TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS conversations_external_idx
    ON conversations (channel, external_chat_id, COALESCE(external_thread_id, ''));

CREATE TABLE IF NOT EXISTS conversation_messages (
    id                   TEXT PRIMARY KEY,

    conversation_id      TEXT NOT NULL REFERENCES conversations(id),

    channel              TEXT NOT NULL,

    direction            TEXT NOT NULL,    -- INBOUND | OUTBOUND
    sender_id            TEXT NOT NULL,
    message_type         TEXT NOT NULL,    -- text | command | result | system
    content              TEXT NOT NULL,

    metadata             JSONB,

    external_message_id  TEXT,

    created_at           TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS conversation_messages_conversation_idx
    ON conversation_messages (conversation_id, created_at);

-- Webhook idempotency lives here, not in the Feishu adapter: a re-delivered
-- (channel, external_message_id) is recognised as a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS conversation_messages_external_idx
    ON conversation_messages (channel, external_message_id)
    WHERE external_message_id IS NOT NULL;
