import type { Channel, IncomingHandler } from "../channel.js";
import type { IncomingMessage, OutgoingMessage } from "../message.js";
import type { FeishuClient } from "./client.js";
import { buildFeishuPayload, type FeishuReceiveIdType } from "./messages.js";

export interface FeishuAdapterOptions {
  client: FeishuClient;
  /** Fallback destination when the message has no metadata.receiveId. */
  defaultReceiveId?: string;
  receiveIdType?: FeishuReceiveIdType;
  /** Optional inbound wiring; webhook ingestion itself is TASK-1104. */
  onMessage?: IncomingHandler;
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

  constructor(options: FeishuAdapterOptions) {
    this.client = options.client;
    this.defaultReceiveId = options.defaultReceiveId;
    this.receiveIdType = options.receiveIdType ?? "chat_id";
    this.handler = options.onMessage;
  }

  async send(message: OutgoingMessage): Promise<void> {
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
    if (payload.msgType === "interactive") {
      await this.client.sendCard({
        receiveId: payload.receiveId,
        receiveIdType: payload.receiveIdType,
        card: JSON.parse(payload.content) as Record<string, unknown>,
      });
      return;
    }
    await this.client.sendMessage({
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
