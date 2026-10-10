import type {
  Conversation,
  ConversationMessage,
  MessageType,
  SubjectType,
} from "../domain/conversation.js";
import type {
  ConversationStore,
  MessageListOptions,
} from "../store/conversationStore.js";

export interface IncomingConversationInput {
  channel: string;
  externalChatId: string;
  externalThreadId?: string;
  /** Channel-scoped message id (Feishu/CLI id); the idempotency key. */
  messageId: string;
  senderId: string;
  text: string;
  timestamp: Date | string;
  metadata?: Record<string, unknown>;
  title?: string;
}

export interface IncomingOutcome {
  conversation: Conversation;
  message: ConversationMessage;
  /** True when this (channel, messageId) was already processed. */
  duplicate: boolean;
}

export interface OutgoingConversationInput {
  text: string;
  senderId?: string;
  messageType?: MessageType;
  metadata?: Record<string, unknown>;
}

/**
 * TASK-1102: the stateful layer between Channel and Harness Application.
 *
 * It records messages reliably (webhook retries become duplicates), keeps the
 * conversation ↔ subject link, and exposes a bounded context window. It does
 * NOT interpret messages (TASK-1106) and does not own subject lifecycles.
 */
export class ConversationService {
  constructor(private readonly store: ConversationStore) {}

  async getOrCreate(input: {
    channel: string;
    externalChatId: string;
    externalThreadId?: string;
    title?: string;
  }): Promise<Conversation> {
    return this.store.ensureConversation(input);
  }

  async findConversation(id: string): Promise<Conversation> {
    return this.store.findConversation(id);
  }

  /** Lookup by platform ids (used to inherit context across a thread). */
  async findByExternal(input: {
    channel: string;
    externalChatId: string;
    externalThreadId?: string;
  }): Promise<Conversation | undefined> {
    return this.store.findConversationByExternal(input);
  }

  /**
   * TASK-1259: conversations bound to a subject — used to report a stage
   * result back into the requirement's own topic (a `prob-…` id is enough;
   * the chat the button was clicked in is irrelevant).
   */
  async findBySubject(input: {
    channel: string;
    type: SubjectType;
    id: string;
  }): Promise<Conversation[]> {
    return this.store.listConversations({
      channel: input.channel,
      subjectType: input.type,
      subjectId: input.id,
    });
  }

  /**
   * Idempotent inbound handling. The duplicate check happens BEFORE any other
   * side effect, so a retried webhook neither creates a second conversation
   * nor re-triggers downstream commands.
   */
  async handleIncoming(input: IncomingConversationInput): Promise<IncomingOutcome> {
    const existing = await this.store.findMessageByExternal(
      input.channel,
      input.messageId,
    );
    if (existing) {
      return {
        conversation: await this.store.findConversation(existing.conversationId),
        message: existing,
        duplicate: true,
      };
    }

    const conversation = await this.store.ensureConversation({
      channel: input.channel,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
      title: input.title,
    });
    // TASK-1243: the first inbound message of a conversation anchors its topic.
    // Everything about this requirement is replied into that topic from here on.
    const anchored = conversation.anchorMessageId
      ? conversation
      : await this.store.setAnchor(conversation.id, input.messageId);
    const message = await this.store.appendMessage({
      conversationId: anchored.id,
      channel: input.channel,
      direction: "INBOUND",
      senderId: input.senderId,
      messageType: "text",
      content: input.text,
      metadata: input.metadata,
      externalMessageId: input.messageId,
      createdAt: toIso(input.timestamp),
    });
    return { conversation: anchored, message, duplicate: false };
  }

  /** TASK-1243: move the conversation's topic anchor (a new requirement). */
  async setAnchor(conversationId: string, anchorMessageId: string): Promise<Conversation> {
    return this.store.setAnchor(conversationId, anchorMessageId);
  }

  async recordOutgoing(
    conversationId: string,
    input: OutgoingConversationInput,
  ): Promise<ConversationMessage> {
    const conversation = await this.store.findConversation(conversationId);
    return this.store.appendMessage({
      conversationId,
      channel: conversation.channel,
      direction: "OUTBOUND",
      senderId: input.senderId ?? "harness",
      messageType: input.messageType ?? "text",
      content: input.text,
      metadata: input.metadata,
    });
  }

  /** Bounded context window (v1: most recent N messages, oldest → newest). */
  async context(
    conversationId: string,
    options: MessageListOptions = {},
  ): Promise<ConversationMessage[]> {
    return this.store.listMessages(conversationId, options);
  }

  /**
   * TASK-1257: the messages of the requirement this conversation currently
   * carries — everything after its topic anchor.
   *
   * A chat-level conversation rotates between requirements (its anchor moves
   * with each new one, because a chat has exactly one such conversation), so a
   * plain "last N messages" window would hand the model the previous
   * requirement's chatter and make a brand-new requirement read as a follow-up.
   */
  async contextSinceAnchor(
    conversationId: string,
    options: MessageListOptions = {},
  ): Promise<ConversationMessage[]> {
    const conversation = await this.store.findConversation(conversationId);
    const anchorMessageId = conversation.anchorMessageId;
    if (!anchorMessageId) {
      return this.store.listMessages(conversationId, options);
    }
    const anchor = await this.store
      .findMessageByExternal(conversation.channel, anchorMessageId)
      .catch(() => undefined);
    // `after` is exclusive, and the anchor message *is* the requirement's own
    // description ("这个间距改成 12px" needs it) — so start one millisecond
    // earlier to keep it in the window without changing the store contract.
    const after = anchor
      ? new Date(Date.parse(anchor.createdAt) - 1).toISOString()
      : undefined;
    return this.store.listMessages(conversationId, {
      ...options,
      ...(after ? { after } : {}),
    });
  }

  async attachSubject(
    conversationId: string,
    subject: { type: SubjectType; id: string },
  ): Promise<Conversation> {
    return this.store.attachSubject(conversationId, {
      subjectType: subject.type,
      subjectId: subject.id,
    });
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
