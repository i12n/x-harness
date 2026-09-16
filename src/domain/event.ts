/** One immutable state-change record (plan section 二十二). */
export interface EventRecord {
  id: string;
  type: string;
  taskId?: string;
  runId?: string;
  problemId?: string;
  payload: unknown;
  createdAt: string;
}

export interface RecordEventInput {
  type: string;
  taskId?: string;
  runId?: string;
  problemId?: string;
  payload?: unknown;
}

export const EVENT_TYPES = [
  "TaskCreated",
  "TaskReady",
  "TaskBlocked",
  "RunCreated",
  "RunStarted",
  "AgentStarted",
  "AgentFinished",
  "VerificationStarted",
  "VerificationPassed",
  "VerificationFailed",
  "RunSucceeded",
  "RunFailed",
  "RunTimedOut",
  "RunCancelled",
  "RunLost",
  "TaskReview",
  "TaskApproved",
  "TaskRejected",
  "TaskDone",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}
