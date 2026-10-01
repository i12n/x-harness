import { renderSpecificationMessage } from "../../channel/rendering/specification.js";
import {
  ProblemNotFoundError,
  SpecificationNotFoundError,
  ValidationError,
} from "../../errors.js";
import { SpecificationError } from "../../specification/application/service.js";
import type { SpecificationService } from "../../specification/application/service.js";
import type { PlanningService } from "../../specification/application/planning.js";
import { CommandRejectionError } from "../errors.js";
import type { CommandHandler, CommandType } from "../types.js";

export interface SpecificationHandlerDeps {
  planning: PlanningService;
  specification: SpecificationService;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((item) => String(item)) : undefined;
}

/** Command payload repositories → specification targets (first is primary). */
function asTargets(value: unknown): { repositoryId: string }[] | undefined {
  const repositories = asStringList(value);
  return repositories?.map((repositoryId) => ({ repositoryId }));
}

function rejectDomainError(error: unknown): never {
  if (error instanceof SpecificationError) {
    throw new CommandRejectionError(error.code, error.message);
  }
  if (error instanceof SpecificationNotFoundError) {
    throw new CommandRejectionError("specification_not_found", error.message);
  }
  if (error instanceof ProblemNotFoundError) {
    throw new CommandRejectionError("problem_not_found", error.message);
  }
  if (error instanceof ValidationError) {
    throw new CommandRejectionError("invalid_specification_input", error.message);
  }
  throw error;
}

/**
 * TASK-1210: the main chain has a production entry point again. The command
 * layer owns create / update / ready / show / plan, so Chat and CLI share one
 * path into SpecificationService and PlanningService.
 *
 * TASK-1202: spec.show / spec.plan are commands like any other — the channel
 * layer never calls PlanningService directly, and planning stays behind
 * validation → authorization → idempotency.
 */
export function createSpecificationCommandHandlers(
  deps: SpecificationHandlerDeps,
): Partial<Record<CommandType, CommandHandler>> {
  return {
    "spec.create": async (payload) => {
      try {
        const specification = await deps.specification.createFromProblem({
          problemId: String(payload.problemId),
          title: asString(payload.title),
          summary: asString(payload.summary),
          acceptance: asStringList(payload.acceptance),
          targets: asTargets(payload.repositories),
        });
        return {
          specification,
          message: renderSpecificationMessage(specification),
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },

    "spec.update": async (payload) => {
      try {
        const specification = await deps.specification.update(
          String(payload.specificationId),
          {
            title: asString(payload.title),
            summary: asString(payload.summary),
            requirements: asStringList(payload.requirements),
            acceptance: asStringList(payload.acceptance),
            targets: asTargets(payload.repositories),
          },
        );
        return {
          specification,
          message: renderSpecificationMessage(specification),
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },

    "spec.ready": async (payload) => {
      try {
        const specification = await deps.specification.markReady(
          String(payload.specificationId),
        );
        return {
          specification,
          message: renderSpecificationMessage(specification),
        };
      } catch (error) {
        rejectDomainError(error);
      }
    },

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
