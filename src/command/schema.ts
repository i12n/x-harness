import type { CommandType, Role } from "./types.js";

export type FieldType = "string" | "number" | "boolean";

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
}

export interface CommandSchema {
  fields: Record<string, FieldSpec>;
  /** Roles allowed to dispatch this command (authorization lives here). */
  roles: Role[];
}

const ALL_ROLES: Role[] = ["guest", "developer", "reviewer", "admin"];
const OPERATORS: Role[] = ["developer", "reviewer", "admin"];
const REVIEWERS: Role[] = ["reviewer", "admin"];

/** Explicit, finite, auditable command catalog (no dynamic dispatch). */
export const COMMAND_SCHEMAS: Record<CommandType, CommandSchema> = {
  "problem.create": {
    fields: {
      title: { type: "string", required: true },
      statement: { type: "string", required: true },
      repositoryId: { type: "string" },
    },
    roles: ALL_ROLES,
  },
  "problem.confirm": {
    fields: { problemId: { type: "string", required: true } },
    roles: OPERATORS,
  },
  "problem.clarification.answer": {
    fields: {
      problemId: { type: "string", required: true },
      clarificationId: { type: "string", required: true },
      optionId: { type: "string" },
      text: { type: "string" },
      /** Free-form answer shortcut, e.g. "all_users" or "不确定". */
      answer: { type: "string" },
    },
    roles: ALL_ROLES,
  },
  "task.show": {
    fields: { taskId: { type: "string", required: true } },
    roles: ALL_ROLES,
  },
  "task.run": {
    fields: { taskId: { type: "string", required: true } },
    roles: OPERATORS,
  },
  "run.show": {
    fields: { runId: { type: "string", required: true } },
    roles: ALL_ROLES,
  },
  "run.cancel": {
    fields: { runId: { type: "string", required: true } },
    roles: OPERATORS,
  },
  "review.show": {
    fields: { taskId: { type: "string", required: true } },
    roles: ALL_ROLES,
  },
  "review.approve": {
    fields: { taskId: { type: "string", required: true } },
    roles: REVIEWERS,
  },
  "review.request_changes": {
    fields: {
      taskId: { type: "string", required: true },
      feedback: { type: "string" },
    },
    roles: REVIEWERS,
  },
};
