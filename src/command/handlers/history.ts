import {
  renderTranscriptMessage,
  type TranscriptEntry,
} from "../../channel/rendering/conversation.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface ChatHistoryOutcome {
  conversationId: string;
  entries: TranscriptEntry[];
  omitted: number;
  subject?: { type: string; id: string };
}

export interface ChatHistoryPort {
  /** Most recent `limit` messages, oldest → newest. */
  show(input: {
    conversationId: string;
    limit?: number;
  }): Promise<ChatHistoryOutcome>;
}

/**
 * `conversation.show` — read the bot's own transcript from chat.
 *
 * Admin-only: the history is everything everyone typed in this conversation,
 * including whatever the harness answered.
 */
export function createHistoryCommandHandlers(deps: {
  history: ChatHistoryPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "conversation.show": async (payload, command) => {
      const conversationId = command.conversation?.id;
      if (!conversationId) {
        throw new CommandRejectionError(
          "no_conversation",
          "该命令只能在会话里使用（CLI 请用 ai conversation show）",
        );
      }
      const limit = typeof payload.limit === "number" ? payload.limit : undefined;
      const outcome = await deps.history.show({ conversationId, limit });
      return {
        ...outcome,
        message: renderTranscriptMessage(outcome.entries, {
          conversationId,
          subject: outcome.subject,
          omitted: outcome.omitted,
        }),
      };
    },
  };
}
