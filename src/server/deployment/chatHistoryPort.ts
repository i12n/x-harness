import type { ChatHistoryOutcome, ChatHistoryPort } from "../../command/handlers/history.js";
import type { ConversationStore } from "../../store/conversationStore.js";

export interface ChatHistoryPortOptions {
  conversations: ConversationStore;
  /** Default number of messages to render when the user does not ask. */
  defaultLimit?: number;
  /** Safety cap — chat clients reject very large messages. */
  maxLimit?: number;
}

export function createChatHistoryPort(options: ChatHistoryPortOptions): ChatHistoryPort {
  const defaultLimit = options.defaultLimit ?? 20;
  const maxLimit = options.maxLimit ?? 100;

  return {
    async show({ conversationId, limit }): Promise<ChatHistoryOutcome> {
      const conversation = await options.conversations.findConversation(conversationId);
      const total = (await options.conversations.listMessages(conversationId)).length;
      const wanted = Math.min(Math.max(limit ?? defaultLimit, 1), maxLimit);
      const messages = await options.conversations.listMessages(conversationId, {
        limit: wanted,
      });

      return {
        conversationId,
        omitted: Math.max(total - messages.length, 0),
        subject:
          conversation.subjectType && conversation.subjectId
            ? { type: conversation.subjectType, id: conversation.subjectId }
            : undefined,
        entries: messages.map((message) => ({
          at: message.createdAt,
          speaker: message.direction === "INBOUND" ? "user" : "harness",
          senderId: message.direction === "INBOUND" ? message.senderId : undefined,
          text: message.content,
        })),
      };
    },
  };
}
