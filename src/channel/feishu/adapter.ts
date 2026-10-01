import type { Channel, IncomingHandler } from "../channel.js";
import type { IncomingMessage, OutgoingMessage } from "../message.js";
import type { FeishuClient } from "./client.js";
import type { SendMessageResult } from "./client.js";
import { buildFeishuPayload, type FeishuReceiveIdType } from "./messages.js";

export interface FeishuAdapterOptions {
  client: FeishuClient;
  /** Fallback destination when the message has no metadata.receiveId. */
  defaultReceiveId?: string;
  receiveIdType?: FeishuReceiveIdType;
  /** Optional inbound wiring; webhook ingestion itself is TASK-1104. */
  onMessage?: IncomingHandler;
  /** Called when a reply-in-thread had to degrade to a normal send. */
  onThreadFallback?: (error: unknown) => void;
}

/**
 * Feishu as a Channel (TASK-1103): converts OutgoingMessage → Feishu payloads
 * and delegates to the provider client. No Problem/Task/Run semantics here,
 * and no webhook/event ingestion (that is TASK-1104).
 */
export class FeishuAdapter implements Channel {
  readonly id = "feishu";
  private readonly client: FeishuClient;
  private readonly defaultReceiveId: string | undefined;
  private readonly receiveIdType: FeishuReceiveIdType;
  private readonly handler: IncomingHandler | undefined;
  private readonly onThreadFallback: ((error: unknown) => void) | undefined;

  constructor(options: FeishuAdapterOptions) {
    this.client = options.client;
    this.defaultReceiveId = options.defaultReceiveId;
    this.receiveIdType = options.receiveIdType ?? "chat_id";
    this.handler = options.onMessage;
    this.onThreadFallback = options.onThreadFallback;
  }

  async send(message: OutgoingMessage): Promise<void> {
    await this.sendWithResult(message);
  }

  /**
   * Same as {@link send}, but reports the Feishu message id. Interactive cards
   * are registered under that id so a later button click can find them.
   */
  async sendWithResult(message: OutgoingMessage): Promise<SendMessageResult | undefined> {
    const receiveId =
      (typeof message.metadata?.receiveId === "string"
        ? message.metadata.receiveId
        : undefined) ??
      this.defaultReceiveId ??
      message.conversationId;
    const payload = buildFeishuPayload(message, {
      receiveId,
      receiveIdType: this.receiveIdType,
    });
    const replyToMessageId =
      typeof message.metadata?.replyToMessageId === "string"
        ? message.metadata.replyToMessageId
        : undefined;
    const replyInThread = message.metadata?.replyInThread === true;
    if (replyToMessageId) {
      // Answering the triggering message keeps a busy group readable, and
      // `reply_in_thread` puts the whole exchange into a topic.
      try {
        return await this.client.replyMessage({
          messageId: replyToMessageId,
          msgType: payload.msgType === "interactive" ? "interactive" : "text",
          content: payload.content,
          replyInThread,
        });
      } catch (error) {
        // Threading is a presentation nicety: never lose the answer because a
        // chat type rejects it. Degrade to a normal send and report.
        this.onThreadFallback?.(error);
      }
    }
    if (payload.msgType === "interactive") {
      return await this.client.sendCard({
        receiveId: payload.receiveId,
        receiveIdType: payload.receiveIdType,
        card: JSON.parse(payload.content) as Record<string, unknown>,
      });
    }
    return await this.client.sendMessage({
      receiveId: payload.receiveId,
      receiveIdType: payload.receiveIdType,
      msgType: "text",
      content: payload.content,
    });
  }

  async receive(message: IncomingMessage): Promise<void> {
    if (!this.handler) {
      // TASK-1104 feeds webhook events into the Conversation service.
      return;
    }
    const reply = await this.handler(message);
    if (reply) {
      await this.send(reply);
    }
  }
}
