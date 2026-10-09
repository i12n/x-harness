import type {
  AppendMessageInput,
  Conversation,
  ConversationMessage,
  ConversationStatus,
  CreateConversationInput,
  SubjectType,
} from "../domain/conversation.js";

export interface ConversationListFilter {
  channel?: string;
  status?: ConversationStatus;
  subjectType?: SubjectType;
  subjectId?: string;
}

export interface MessageListOptions {
  /** Keep only the most recent N messages (returned oldest → newest). */
  limit?: number;
  /** ISO timestamp: only messages created strictly before this. */
  before?: string;
  /** ISO timestamp: only messages created strictly after this. */
  after?: string;
}

export interface FindConversationInput {
  channel: string;
  externalChatId: string;
  externalThreadId?: string;
}

/** Persistence contract for conversations (TASK-1102). */
export interface ConversationStore {
  createConversation(input: CreateConversationInput): Promise<Conversation>;
  /** Idempotent lookup-or-create by (channel, chat, thread). */
  ensureConversation(input: CreateConversationInput): Promise<Conversation>;
  findConversation(id: string): Promise<Conversation>;
  findConversationByExternal(
    input: FindConversationInput,
  ): Promise<Conversation | undefined>;
  listConversations(filter?: ConversationListFilter): Promise<Conversation[]>;
  attachSubject(
    id: string,
    subject: { subjectType: SubjectType; subjectId: string },
  ): Promise<Conversation>;
  /**
   * TASK-1243: pin (or move) the topic anchor. Overwrites on purpose: a new
   * requirement started in the same chat gets its own topic.
   */
  setAnchor(id: string, anchorMessageId: string): Promise<Conversation>;

  /** Idempotent append: a repeated (channel, externalMessageId) is returned. */
  appendMessage(input: AppendMessageInput): Promise<ConversationMessage>;
  /** Idempotency probe used before any side effect is triggered. */
  findMessageByExternal(
    channel: string,
    externalMessageId: string,
  ): Promise<ConversationMessage | undefined>;
  listMessages(
    conversationId: string,
    options?: MessageListOptions,
  ): Promise<ConversationMessage[]>;

  /**
   * Retention: delete messages created strictly before `before`.
   *
   * Explicit and never automatic — the transcript is the only record of who
   * asked for what, so deleting it is an operator decision. `dryRun` returns
   * the count that *would* be deleted without touching anything.
   */
  deleteMessagesBefore(before: string, options?: { dryRun?: boolean }): Promise<number>;
}
