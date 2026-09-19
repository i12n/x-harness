import { renderDeliveryMessage } from "../../channel/rendering/delivery.js";
import { DeliveryError, type DeliveryService } from "../../delivery/application/service.js";
import { DeliveryNotFoundError } from "../../errors.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface DeliveryHandlerDeps {
  deliveries: DeliveryService;
}

function rejectDomainError(error: unknown): never {
  if (error instanceof DeliveryError) {
    throw new CommandRejectionError(error.code, error.message);
  }
  if (error instanceof DeliveryNotFoundError) {
    throw new CommandRejectionError("delivery_not_found", error.message);
  }
  throw error;
}

/**
 * TASK-1205: delivery.show / delivery.release. Aggregation lives in the
 * application service; the handler only maps facts and rejection codes.
 */
export function createDeliveryCommandHandlers(
  deps: DeliveryHandlerDeps,
): Partial<Record<CommandType, CommandHandler>> {
  return {
    "delivery.show": async (payload) => {
      try {
        const view = await deps.deliveries.show(String(payload.deliveryId));
        return {
          ...view,
          message: renderDeliveryMessage({
            delivery: view.delivery,
            tasks: view.tasks,
            blocking: view.blocking,
            release: view.release,
          }),
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },

    "delivery.release": async (payload, command) => {
      try {
        const outcome = await deps.deliveries.release(String(payload.deliveryId), {
          channel: command.actor.channel,
          userId: command.actor.userId,
        });
        const view = await deps.deliveries.load(outcome.delivery.id);
        return {
          delivery: outcome.delivery,
          release: outcome.release,
          created: outcome.created,
          tasks: view.tasks,
          blocking: view.blocking,
          message: renderDeliveryMessage({
            delivery: outcome.delivery,
            tasks: view.tasks,
            blocking: view.blocking,
            release: outcome.release,
          }),
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },
  };
}
