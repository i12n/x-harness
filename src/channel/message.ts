/** Channel-agnostic message models (Phase 11 / TASK-1101). */

export interface IncomingMessage {
  /** Channel id, e.g. "cli" or "feishu". */
  channel: string;
  conversationId: string;
  messageId: string;
  senderId: string;
  text: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "code"; text: string; language?: string }
  | { type: "divider" };

export interface OutgoingMessage {
  conversationId: string;
  text?: string;
  blocks?: MessageBlock[];
  metadata?: Record<string, unknown>;
}
