import type { Delivery } from "../../domain/delivery.js";
import type { Run } from "../../domain/run.js";
import type { Task } from "../../domain/task.js";
import type { AcceptanceEvidence } from "../../verification/acceptance.js";
import { parseReviewerReport } from "../../reviewer/domain/verdict.js";

export interface DeliveryTaskEvidence {
  taskId: string;
  title: string;
  status: string;
  /** What the task's latest Run proved about its criteria (TASK-1220). */
  acceptance?: AcceptanceEvidence;
  /** The reviewer's verdict, when one was produced (TASK-1221). */
  review?: { verdict: string; notes: string };
}

export interface DeliveryAcceptanceView {
  deliveryId: string;
  status: string;
  tasks: DeliveryTaskEvidence[];
  /** The delivery is ready to be released. */
  ready: boolean;
  /** A human still has to judge something. */
  requiresHumanAcceptance: boolean;
  reasons: string[];
}

export interface DeliveryAcceptanceInput {
  delivery: Delivery;
  tasks: Task[];
  runs?: { listRuns(filter: { taskId: string }): Promise<Run[]> };
}

/**
 * TASK-1223: one place that answers "what does this delivery actually prove?".
 * Everything is read from evidence the harness produced itself — never from the
 * agent's own summary.
 */
export async function buildDeliveryAcceptance(
  input: DeliveryAcceptanceInput,
): Promise<DeliveryAcceptanceView> {
  const evidence: DeliveryTaskEvidence[] = [];
  const reasons: string[] = [];

  for (const task of input.tasks) {
    const latest = await latestRun(input.runs, task.id);
    const result = asRecord(latest?.result);
    const acceptance = readAcceptance(result?.acceptance);
    const review = parseReviewerReport(result?.review);
    evidence.push({
      taskId: task.id,
      title: task.title,
      status: task.status,
      ...(acceptance ? { acceptance } : {}),
      ...(review ? { review: { verdict: review.verdict, notes: review.notes } } : {}),
    });

    if (task.status !== "DONE") {
      reasons.push(`${task.id} 还没完成（${task.status}）`);
    }
    if (acceptance?.requiresHumanAcceptance) {
      reasons.push(`${task.id} 有验收标准没有可执行检查`);
    }
    if (review?.verdict === "needs_human") {
      reasons.push(`${task.id} 评审需要人判断`);
    }
  }

  const released = input.delivery.status === "RELEASED";
  return {
    deliveryId: input.delivery.id,
    status: input.delivery.status,
    tasks: evidence,
    ready: !released && input.delivery.status === "READY_FOR_RELEASE",
    requiresHumanAcceptance: reasons.length > 0,
    reasons,
  };
}

async function latestRun(
  runs: DeliveryAcceptanceInput["runs"],
  taskId: string,
): Promise<Run | undefined> {
  if (!runs) {
    return undefined;
  }
  try {
    const list = await runs.listRuns({ taskId });
    return list[list.length - 1];
  } catch {
    return undefined;
  }
}

function readAcceptance(raw: unknown): AcceptanceEvidence | undefined {
  const record = asRecord(raw);
  if (!record || !Array.isArray(record.criteria)) {
    return undefined;
  }
  return record as unknown as AcceptanceEvidence;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
