import { renderSpecificationMessage } from "../../channel/rendering/specification.js";
import { SpecificationNotFoundError } from "../../errors.js";
import { SpecificationError } from "../../specification/application/service.js";
import type { PlanningService } from "../../specification/application/planning.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface SpecificationHandlerDeps {
  planning: PlanningService;
}

function rejectDomainError(error: unknown): never {
  if (error instanceof SpecificationError) {
    throw new CommandRejectionError(error.code, error.message);
  }
  if (error instanceof SpecificationNotFoundError) {
    throw new CommandRejectionError("specification_not_found", error.message);
  }
  throw error;
}

/**
 * TASK-1202: spec.show / spec.plan are commands like any other — the channel
 * layer never calls PlanningService directly, and planning stays behind
 * validation → authorization → idempotency.
 */
export function createSpecificationCommandHandlers(
  deps: SpecificationHandlerDeps,
): Partial<Record<CommandType, CommandHandler>> {
  return {
    "spec.show": async (payload) => {
      try {
        const outcome = await deps.planning.show(String(payload.specificationId));
        return {
          ...outcome,
          message: renderSpecificationMessage(outcome.specification, outcome),
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },

    "spec.plan": async (payload) => {
      try {
        const outcome = await deps.planning.plan(String(payload.specificationId));
        return {
          specification: outcome.specification,
          planItems: outcome.planItems,
          tasks: outcome.tasks,
          replayed: outcome.replayed,
          message: renderSpecificationMessage(outcome.specification, outcome),
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },
  };
}
