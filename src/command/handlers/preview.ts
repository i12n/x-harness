import { renderPreviewMessage } from "../../channel/rendering/preview.js";
import type { PreviewEvidence } from "../../preview/application/previewService.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface PreviewBuildPort {
  build(deliveryId: string): Promise<PreviewEvidence>;
}

/** TASK-1226: `preview.build` — collect build evidence for a delivery. */
export function createPreviewCommandHandlers(deps: {
  preview: PreviewBuildPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "preview.build": async (payload) => {
      const deliveryId = String(payload.deliveryId).trim();
      const preview = await deps.preview.build(deliveryId);
      return { preview, message: renderPreviewMessage(preview, { conversationId: deliveryId }) };
    },
  };
}
