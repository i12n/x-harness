import {
  renderDeployStatusMessage,
  renderPromotedMessage,
  renderTestDeployMessage,
} from "../../channel/rendering/deploy.js";
import type { DeployService } from "../../deploy/application/deployService.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface DeployCommandPort {
  deployTest(deliveryId: string): ReturnType<DeployService["deployTest"]>;
  status(deliveryId: string): ReturnType<DeployService["status"]>;
  promote(deliveryId: string): ReturnType<DeployService["promote"]>;
}

/**
 * TASK-1230: the harness's whole deployment surface — push the test branch,
 * observe the repository's own deployment, and merge once a human accepted.
 * It never runs a deploy and never holds a deployment credential.
 */
export function createDeployCommandHandlers(deps: {
  deploys: DeployCommandPort;
}): Partial<Record<CommandType, CommandHandler>> {
  return {
    "deploy.test": async (payload) => {
      const deliveryId = String(payload.deliveryId).trim();
      const started = await deps.deploys.deployTest(deliveryId);
      return { ...started, message: renderTestDeployMessage(started, { conversationId: deliveryId }) };
    },
    "deploy.status": async (payload) => {
      const deliveryId = String(payload.deliveryId).trim();
      const status = await deps.deploys.status(deliveryId);
      return { ...status, message: renderDeployStatusMessage(status, { conversationId: deliveryId }) };
    },
    "deploy.promote": async (payload) => {
      const deliveryId = String(payload.deliveryId).trim();
      const outcome = await deps.deploys.promote(deliveryId);
      return { ...outcome, message: renderPromotedMessage(outcome, { conversationId: deliveryId }) };
    },
  };
}
