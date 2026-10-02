import type { CommandType, Role } from "./types.js";

/**
 * `string[]` is a list of non-empty strings. It exists because specification
 * commands carry repeated values (acceptance criteria, target repositories)
 * that have no sensible scalar encoding.
 */
export type FieldType = "string" | "string[]" | "number" | "boolean";

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
const ADMIN_ONLY: Role[] = ["admin"];

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
      /** Several options ticked on one card and submitted together. */
      optionIds: { type: "string[]" },
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
  "review.list": {
    fields: {},
    roles: ALL_ROLES,
  },
  "review.approve": {
    fields: { taskId: { type: "string", required: true } },
    roles: REVIEWERS,
  },
  "review.approve_batch": {
    fields: { taskIds: { type: "string[]", required: true } },
    roles: REVIEWERS,
  },
  "review.request_changes": {
    fields: {
      taskId: { type: "string", required: true },
      feedback: { type: "string" },
    },
    roles: REVIEWERS,
  },
  "spec.create": {
    fields: {
      /** CONFIRMED problem the specification is derived from. */
      problemId: { type: "string", required: true },
      title: { type: "string" },
      summary: { type: "string" },
      /** Acceptance criteria; without them the DRAFT cannot become READY. */
      acceptance: { type: "string[]" },
      /** Overrides the targets derived from the problem (first is primary). */
      repositories: { type: "string[]" },
    },
    roles: OPERATORS,
  },
  "spec.update": {
    fields: {
      specificationId: { type: "string", required: true },
      title: { type: "string" },
      summary: { type: "string" },
      requirements: { type: "string[]" },
      acceptance: { type: "string[]" },
      repositories: { type: "string[]" },
    },
    roles: OPERATORS,
  },
  "spec.ready": {
    fields: { specificationId: { type: "string", required: true } },
    roles: OPERATORS,
  },
  "spec.show": {
    fields: { specificationId: { type: "string", required: true } },
    roles: ALL_ROLES,
  },
  "spec.plan": {
    fields: { specificationId: { type: "string", required: true } },
    roles: OPERATORS,
  },
  "delivery.show": {
    fields: { deliveryId: { type: "string", required: true } },
    roles: ALL_ROLES,
  },
  "delivery.release": {
    fields: { deliveryId: { type: "string", required: true } },
    roles: REVIEWERS,
  },
  "preview.build": {
    fields: { deliveryId: { type: "string", required: true } },
    roles: OPERATORS,
  },
  // Deployment configuration is admin-only: the same fields the config page
  // writes (see docs/deployment-feishu.md §3.1).
  "config.show": {
    fields: { key: { type: "string" } },
    roles: ADMIN_ONLY,
  },
  "config.set": {
    fields: {
      key: { type: "string", required: true },
      value: { type: "string", required: true },
    },
    roles: ADMIN_ONLY,
  },
  // Reachable only through the session's deterministic `设置 <KEY> <值>` router:
  // the value is never sent to the language model and never stored in the
  // conversation table. It is deliberately absent from the intent prompt.
  "config.setDirect": {
    fields: {
      key: { type: "string", required: true },
      value: { type: "string", required: true },
    },
    roles: ADMIN_ONLY,
  },
  "config.apply": {
    fields: {},
    roles: ADMIN_ONLY,
  },
  // Granting/revoking chat access is a merge on the allow-list and role map —
  // never a whole-list overwrite, which could lock the operator out.
  "access.grant": {
    fields: {
      openId: { type: "string", required: true },
      role: { type: "string" },
    },
    roles: ADMIN_ONLY,
  },
  "access.revoke": {
    fields: { openId: { type: "string", required: true } },
    roles: ADMIN_ONLY,
  },
  // Publishing writes to the remote, so it sits on the same human boundary as
  // approval (reviewer/admin), not with the ordinary operator commands.
  "git.publish": {
    fields: { taskId: { type: "string", required: true } },
    roles: REVIEWERS,
  },
  // The transcript is everything anyone typed in this conversation.
  "conversation.show": {
    fields: { limit: { type: "number" } },
    roles: ADMIN_ONLY,
  },
  // Read-only repository metadata; the same "ask what exists" class as
  // task.show / spec.show, so guests may look too.
  "repository.list": {
    fields: {},
    roles: ALL_ROLES,
  },
  "repository.show": {
    fields: { repositoryId: { type: "string", required: true } },
    roles: ALL_ROLES,
  },
  "task.list": {
    fields: {
      status: { type: "string" },
      repositoryId: { type: "string" },
    },
    roles: ALL_ROLES,
  },
  "run.list": {
    fields: { limit: { type: "number" }, taskId: { type: "string" } },
    roles: ALL_ROLES,
  },
  "problem.list": {
    fields: { status: { type: "string" } },
    roles: ALL_ROLES,
  },
  "delivery.list": {
    fields: {},
    roles: ALL_ROLES,
  },
};
