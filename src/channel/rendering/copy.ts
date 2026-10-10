import type { DeliveryStatus, ReleaseStatus } from "../../domain/delivery.js";
import type { ProblemStatus } from "../../domain/problem.js";
import type { RunStatus } from "../../domain/run.js";
import type { SpecificationStatus } from "../../domain/specification.js";
import type { TaskStatus } from "../../domain/task.js";

/**
 * TASK-1263: the single source of truth for chat (Feishu) wording.
 *
 * Every message the user reads is Chinese: statuses, section titles, buttons
 * and empty-state hints all come from here, so a renderer never hard-codes an
 * English literal. Machine values stay as they are — `run-…` / `task-…` /
 * `dlv-…` ids and shell commands are what the user types back at us, so they
 * must not be translated.
 *
 * Two rules that keep status lines honest:
 *   1. A Run status describes *the run* ("执行完成"), never the requirement —
 *      the run can finish while the review still sends the task back.
 *   2. Unknown statuses fall back to the raw value instead of disappearing, so
 *      a new state is visible (if ugly) rather than silently blank.
 */

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  QUEUED: "排队中",
  STARTING: "启动中",
  RUNNING: "开发中",
  VERIFYING: "验证中",
  SUCCEEDED: "执行完成",
  FAILED: "执行失败",
  TIMED_OUT: "执行超时",
  CANCELLED: "已取消",
  LOST: "已失联",
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  INBOX: "待开始",
  READY: "待执行",
  RUNNING: "开发中",
  VERIFYING: "验证中",
  REVIEW: "待评审",
  BLOCKED: "已阻塞",
  FAILED: "失败",
  DONE: "已完成",
};

export const SPECIFICATION_STATUS_LABELS: Record<SpecificationStatus, string> = {
  DRAFT: "草稿",
  READY: "待拆解",
  PLANNED: "已拆解",
  SUPERSEDED: "已作废",
};

export const DELIVERY_STATUS_LABELS: Record<DeliveryStatus, string> = {
  PLANNED: "已计划",
  IN_PROGRESS: "开发中",
  READY_FOR_RELEASE: "待发布",
  BLOCKED: "已阻塞",
  RELEASED: "已上线",
};

export const RELEASE_STATUS_LABELS: Record<ReleaseStatus, string> = {
  PENDING: "进行中",
  RELEASED: "已发布",
  CANCELLED: "已取消",
};

export const PROBLEM_STATUS_LABELS: Record<ProblemStatus, string> = {
  INBOX: "已提交",
  ANALYZING: "分析中",
  NEEDS_INPUT: "待你确认",
  ANSWERED: "已回答",
  CONFIRMED: "已确认",
  INVESTIGATING: "调研中",
  SPECIFIED: "已出规格",
  READY: "待开发",
};

/** Verification check outcomes, as the user reads them. */
export const CHECK_STATUS_LABELS: Record<string, string> = {
  passed: "通过",
  failed: "未通过",
  skipped: "跳过",
  pending: "待运行",
};

/** Reviewer verdicts, short form (the long form lives in describeReviewerReport). */
export const REVIEW_VERDICT_LABELS: Record<string, string> = {
  approve: "通过",
  request_changes: "要求返工",
  needs_human: "需人工判断",
};

/** Section titles, so two cards name the same thing the same way. */
export const SECTION = {
  status: "状态",
  nextStep: "接下来",
  review: "评审结论",
  acceptance: "验收标准",
  workspaces: "工作区",
  targets: "目标仓库",
  verification: "验证",
  dependencies: "依赖",
  blockedBy: "被谁阻塞",
  blockingChain: "阻塞链",
  latestFailure: "最近一次失败",
  tasks: "任务",
  plan: "计划",
  requirements: "需求",
  summary: "摘要",
  description: "描述",
  release: "发布",
  failure: "失败原因",
  problem: "问题",
  allowedList: "允许列表",
  profile: "执行档案",
} as const;

export function runStatusLabel(status: string): string {
  return label(RUN_STATUS_LABELS, status);
}

export function taskStatusLabel(status: string): string {
  return label(TASK_STATUS_LABELS, status);
}

export function specificationStatusLabel(status: string): string {
  return label(SPECIFICATION_STATUS_LABELS, status);
}

export function deliveryStatusLabel(status: string): string {
  return label(DELIVERY_STATUS_LABELS, status);
}

export function releaseStatusLabel(status: string): string {
  return label(RELEASE_STATUS_LABELS, status);
}

export function problemStatusLabel(status: string): string {
  return label(PROBLEM_STATUS_LABELS, status);
}

export function checkStatusLabel(status: string): string {
  return label(CHECK_STATUS_LABELS, status);
}

export function reviewVerdictLabel(verdict: string): string {
  return label(REVIEW_VERDICT_LABELS, verdict);
}

/** `primary` / `supporting` targets, as the user reads them. */
export function targetRoleLabel(role: string | undefined): string {
  if (role === "primary") {
    return "主仓库";
  }
  if (role === "supporting") {
    return "辅助仓库";
  }
  return role ?? "仓库";
}

/** Conversation subject types, as the transcript prints them. */
export const SUBJECT_TYPE_LABELS: Record<string, string> = {
  problem: "需求",
  specification: "规格",
  task: "任务",
  run: "运行",
  delivery: "交付",
};

export function subjectTypeLabel(type: string): string {
  return label(SUBJECT_TYPE_LABELS, type);
}

/**
 * Blocking notes arrive as free text (`blocked by task-x` today). Chat reads
 * Chinese, so translate the one shape the domain produces and pass anything
 * else through untouched.
 */
export function noteLabel(note: string): string {
  const blocked = /^blocked by (.+)$/.exec(note.trim());
  return blocked ? `等待 ${blocked[1]}` : note;
}

function label(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}
