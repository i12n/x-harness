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

export interface MessageAction {
  id: string;
  label: string;
  style?: "primary" | "danger" | "default";
  value?: string;
}

/** Transport-agnostic presentation blocks shared by all renderers. */
export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "code"; text: string; language?: string }
  | { type: "divider" }
  | { type: "section"; title?: string; text: string }
  | { type: "actions"; actions: MessageAction[] };

export interface OutgoingMessage {
  conversationId: string;
  text?: string;
  blocks?: MessageBlock[];
  metadata?: Record<string, unknown>;
}
