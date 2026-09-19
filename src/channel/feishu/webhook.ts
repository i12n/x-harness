import type { ConversationService } from "../../conversation/service.js";
import type { IncomingMessage } from "../message.js";
import { parseFeishuEvent } from "./events.js";
import {
  verifyFeishuRequest,
  type FeishuVerifyOptions,
} from "./verification.js";

export interface FeishuWebhookRequest {
  headers: Record<string, string | undefined>;
  body: string;
}

export interface FeishuWebhookResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface FeishuIngestionOptions {
  conversation: ConversationService;
  verify?: FeishuVerifyOptions;
  /**
   * Side effect for NEW messages only. Duplicate deliveries never invoke it —
   * that guarantee is what webhook retries rely on.
   */
  onMessage?: (
    message: IncomingMessage,
    context: { conversationId: string },
  ) => Promise<void> | void;
}

/**
 * TASK-1104: HTTP-shaped ingestion pipeline living between Feishu and the
 * Conversation layer:
 *
 *   verify → parse → IncomingMessage → ConversationService.handleIncoming()
 *
 * Verification failures return before parsing/recording; unsupported events are
 * acknowledged and ignored.
 */
export class FeishuEventIngestion {
  constructor(private readonly options: FeishuIngestionOptions) {}

  async handleRequest(request: FeishuWebhookRequest): Promise<FeishuWebhookResponse> {
    const verified = verifyFeishuRequest(request, this.options.verify ?? {});
    if (!verified.ok) {
      return { status: verified.status, body: { error: verified.reason } };
    }
    if (verified.challenge !== undefined) {
      return { status: 200, body: { challenge: verified.challenge } };
    }

    const parsed = parseFeishuEvent(verified.payload);
    if (parsed.kind === "ignored") {
      return { status: 200, body: { ignored: true, reason: parsed.reason } };
    }

    const message = parsed.message;
    const chatId =
      typeof message.metadata?.chatId === "string"
        ? message.metadata.chatId
        : message.conversationId;
    const threadId =
      typeof message.metadata?.threadId === "string"
        ? message.metadata.threadId
        : undefined;
    const outcome = await this.options.conversation.handleIncoming({
      channel: message.channel,
      externalChatId: chatId,
      externalThreadId: threadId,
      messageId: message.messageId,
      senderId: message.senderId,
      text: message.text,
      timestamp: message.timestamp,
      metadata: message.metadata,
    });

    if (!outcome.duplicate && this.options.onMessage) {
      await this.options.onMessage(message, { conversationId: outcome.conversation.id });
    }

    return {
      status: 200,
      body: {
        conversationId: outcome.conversation.id,
        messageId: outcome.message.id,
        duplicate: outcome.duplicate,
      },
    };
  }
}
