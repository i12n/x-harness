import {
  buildConversation,
  buildConversationMessage,
} from "../domain/conversation.js";
import type {
  AppendMessageInput,
  Conversation,
  ConversationMessage,
  CreateConversationInput,
  SubjectType,
} from "../domain/conversation.js";
import { ConversationNotFoundError } from "../errors.js";
import type {
  ConversationListFilter,
  ConversationStore,
  FindConversationInput,
  MessageListOptions,
} from "./conversationStore.js";

export class InMemoryConversationStore implements ConversationStore {
  private readonly conversations = new Map<string, Conversation>();
  private readonly messages = new Map<string, ConversationMessage[]>();

  async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const conversation = buildConversation(input);
    this.conversations.set(conversation.id, conversation);
    return conversation;
  }

  async ensureConversation(input: CreateConversationInput): Promise<Conversation> {
    const existing = await this.findConversationByExternal({
      channel: input.channel,
      externalChatId: input.externalChatId,
      externalThreadId: input.externalThreadId,
    });
    return existing ?? this.createConversation(input);
  }

  async findConversation(id: string): Promise<Conversation> {
    const conversation = this.conversations.get(id);
    if (!conversation) {
      throw new ConversationNotFoundError(id);
    }
    return conversation;
  }

  async findConversationByExternal(
    input: FindConversationInput,
  ): Promise<Conversation | undefined> {
    const thread = input.externalThreadId?.trim() || "";
    return [...this.conversations.values()].find(
      (conversation) =>
        conversation.channel === input.channel &&
        conversation.externalChatId === input.externalChatId &&
        (conversation.externalThreadId ?? "") === thread,
    );
  }

  async listConversations(
    filter: ConversationListFilter = {},
  ): Promise<Conversation[]> {
    return [...this.conversations.values()]
      .filter(
        (conversation) =>
          (filter.channel === undefined || conversation.channel === filter.channel) &&
          (filter.status === undefined || conversation.status === filter.status) &&
          (filter.subjectType === undefined ||
            conversation.subjectType === filter.subjectType) &&
          (filter.subjectId === undefined || conversation.subjectId === filter.subjectId),
      )
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
      );
  }

  async attachSubject(
    id: string,
    subject: { subjectType: SubjectType; subjectId: string },
  ): Promise<Conversation> {
    const conversation = await this.findConversation(id);
    const updated: Conversation = {
      ...conversation,
      subjectType: subject.subjectType,
      subjectId: subject.subjectId,
      updatedAt: new Date().toISOString(),
    };
    this.conversations.set(id, updated);
    return updated;
  }

  async appendMessage(input: AppendMessageInput): Promise<ConversationMessage> {
    await this.findConversation(input.conversationId);
    const message = buildConversationMessage(input);
    const existing = this.messages.get(input.conversationId) ?? [];
    if (message.externalMessageId) {
      const duplicate = existing.find(
        (entry) =>
          entry.channel === message.channel &&
          entry.externalMessageId === message.externalMessageId,
      );
      if (duplicate) {
        return duplicate;
      }
    }
    existing.push(message);
    this.messages.set(input.conversationId, existing);
    return message;
  }

  async findMessageByExternal(
    channel: string,
    externalMessageId: string,
  ): Promise<ConversationMessage | undefined> {
    for (const messages of this.messages.values()) {
      const found = messages.find(
        (message) =>
          message.channel === channel &&
          message.externalMessageId === externalMessageId,
      );
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  async listMessages(
    conversationId: string,
    options: MessageListOptions = {},
  ): Promise<ConversationMessage[]> {
    const messages = [...(this.messages.get(conversationId) ?? [])]
      .filter(
        (message) =>
          (options.before === undefined || message.createdAt < options.before) &&
          (options.after === undefined || message.createdAt > options.after),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    if (options.limit !== undefined && options.limit > 0) {
      return messages.slice(-options.limit);
    }
    return messages;
  }
}
