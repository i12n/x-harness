import type { OutgoingMessage } from "../message.js";
import { renderFeishuCard, renderFeishuText } from "./cards.js";

export type FeishuReceiveIdType = "chat_id" | "open_id" | "user_id" | "email";
export type FeishuMessageType = "text" | "interactive";

export interface FeishuMessagePayload {
  receiveId: string;
  receiveIdType: FeishuReceiveIdType;
  msgType: FeishuMessageType;
  /** JSON string, exactly as the Feishu open API expects. */
  content: string;
  conversationId: string;
}

export interface BuildPayloadOptions {
  receiveId: string;
  receiveIdType?: FeishuReceiveIdType;
}

/**
 * Plain text stays plain text; anything with structured blocks becomes a card.
 * Business card types (Task/Run/Review) are a later rendering concern.
 */
export function buildFeishuPayload(
  message: OutgoingMessage,
  options: BuildPayloadOptions,
): FeishuMessagePayload {
  const receiveIdType = options.receiveIdType ?? "chat_id";
  const hasBlocks = (message.blocks?.length ?? 0) > 0;
  if (hasBlocks) {
    return {
      receiveId: options.receiveId,
      receiveIdType,
      msgType: "interactive",
      content: JSON.stringify(renderFeishuCard(message)),
      conversationId: message.conversationId,
    };
  }
  return {
    receiveId: options.receiveId,
    receiveIdType,
    msgType: "text",
    content: JSON.stringify({ text: renderFeishuText(message) }),
    conversationId: message.conversationId,
  };
}
