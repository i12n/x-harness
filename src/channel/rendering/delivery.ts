import type { Delivery, Release } from "../../domain/delivery.js";
import type { DeliveryBlockingFact } from "../../domain/delivery.js";
import type { Task } from "../../domain/task.js";
import type { OutgoingMessage } from "../message.js";
import type { DeliveryAcceptanceView } from "../../delivery/application/acceptance.js";
import { markdownBlock, sectionBlock } from "./common.js";
import { formatFailure } from "./task.js";

export interface DeliveryRenderOptions {
  conversationId?: string;
}

export interface DeliveryRenderFacts {
  delivery: Delivery;
  tasks: Task[];
  blocking?: Task[];
  /** TASK-1207: structured blocking reasons (chain + failure evidence). */
  blockingFacts?: DeliveryBlockingFact[];
  release?: Release;
  /** TASK-1223: what the delivery proved, and whether a human must accept it. */
  acceptance?: DeliveryAcceptanceView;
}

/**
 * TASK-1205: Delivery aggregation facts → OutgoingMessage. The renderer only
 * displays what the application aggregated; it never computes delivery status
 * or decides whether a release should happen.
 */
export function renderDeliveryMessage(
  facts: DeliveryRenderFacts,
  options: DeliveryRenderOptions = {},
): OutgoingMessage {
  const { delivery } = facts;
  const blocks = [
    sectionBlock(
      `${delivery.id} · Delivery`,
      [`Specification: ${delivery.specificationId}`, `Status: ${delivery.status}`].join(
        "\n",
      ),
    ),
  ];

  const tasks =
    facts.tasks.length > 0
      ? facts.tasks
          .map((task) => {
            const fact = facts.blockingFacts?.find((entry) => entry.taskId === task.id);
            const state =
              fact?.state === "dependency-blocked"
                ? "dependency-blocked" +
                  (fact.blockingTaskIds.length > 0
                    ? ` (blocked by ${fact.blockingTaskIds.join(", ")})`
                    : "")
                : task.status;
            return (
              `- ${fact ? "✗" : taskMark(task)} ${task.id} ${task.title} · ${state}` +
              (isOptional(task) ? " · optional" : " · required")
            );
          })
          .join("\n")
      : "(no tasks)";
  blocks.push(markdownBlock(`**Tasks**\n${tasks}`));

  const chains = collectChains(facts);
  if (chains.length > 0) {
    blocks.push(
      markdownBlock(
        `**Blocking chain**\n${chains
          .map((chain) =>
            chain
              .map(
                (entry) =>
                  `${entry.taskId}${entry.title ? ` ${entry.title}` : ""}` +
                  (entry.status ? ` (${entry.status})` : "") +
                  (entry.note ? ` — ${entry.note}` : ""),
              )
              .join("\n  ↓\n"),
          )
          .join("\n\n")}`,
      ),
    );
  } else if (facts.blocking && facts.blocking.length > 0) {
    blocks.push(
      markdownBlock(
        `**Blocking**\n${facts.blocking
          .map((task) => `- ${task.id} is ${task.status}`)
          .join("\n")}`,
      ),
    );
  }

  const failures = (facts.blockingFacts ?? [])
    .map((fact) => ({ fact, evidence: fact.evidence }))
    .filter((entry) => entry.evidence !== undefined);
  if (failures.length > 0) {
    blocks.push(
      markdownBlock(
        `**Failure**\n${failures
          .map(
            (entry) =>
              `${failureOwner(entry.fact)}: ${formatFailure(entry.evidence!)}`,
          )
          .join("\n")}`,
      ),
    );
  }

  const release = facts.release;
  blocks.push(
    markdownBlock(
      release
        ? `**Release**\n- ${release.id} · ${release.status}` +
            (release.releasedAt ? ` · ${release.releasedAt}` : "") +
            (release.createdBy ? ` · by ${release.createdBy}` : "")
        : "**Release**\n(not released)",
    ),
  );

  // TASK-1223: the delivery-level acceptance view — what the whole change set
  // proved, and the single confirmation a human still owes.
  const acceptance = facts.acceptance;
  if (acceptance) {
    const lines = acceptance.tasks.map((task) => {
      const marks = [
        task.status === "DONE" ? "✓" : `(${task.status})`,
        task.review ? `评审 ${task.review.verdict}` : undefined,
        task.acceptance?.requiresHumanAcceptance ? "有不可验证标准" : undefined,
      ].filter(Boolean);
      return `- ${task.taskId} ${task.title} · ${marks.join(" · ")}`;
    });
    blocks.push(markdownBlock(`**验收**\n${lines.join("\n") || "(no tasks)"}`));
    if (acceptance.requiresHumanAcceptance) {
      blocks.push(
        markdownBlock(`⚠️ 需要人验收：${acceptance.reasons.slice(0, 5).join("；")}`),
      );
    }
    if (acceptance.ready) {
      blocks.push({
        type: "actions",
        actions: [
          {
            id: "delivery.release",
            label: "确认验收并发布",
            style: "primary",
            value: JSON.stringify({ deliveryId: delivery.id }),
          },
        ],
      });
    }
  }

  return {
    conversationId: options.conversationId ?? delivery.id,
    text: `${delivery.id} ${delivery.specificationId} (${delivery.status})`,
    blocks,
  };
}

function taskMark(task: Task): string {
  if (task.status === "DONE") {
    return "✓";
  }
  if (task.status === "BLOCKED" || task.status === "FAILED") {
    return "✗";
  }
  return "○";
}

function isOptional(task: Task): boolean {
  const primary =
    task.targets.find((target) => target.role === "primary") ?? task.targets[0];
  return primary ? !primary.required : false;
}

/** The failure belongs to the task that actually ran (the chain's blocker). */
function failureOwner(fact: DeliveryBlockingFact): string {
  if (fact.state === "dependency-blocked" && fact.blockingTaskIds.length > 0) {
    return fact.blockingTaskIds[0]!;
  }
  return fact.taskId;
}

/** Distinct chains from the blocking facts (deterministic, plan order). */
function collectChains(
  facts: DeliveryRenderFacts,
): DeliveryBlockingFact["chain"][] {
  const chains: DeliveryBlockingFact["chain"][] = [];
  const seen = new Set<string>();
  for (const fact of facts.blockingFacts ?? []) {
    if (fact.state !== "dependency-blocked" || fact.chain.length < 2) {
      continue;
    }
    const key = fact.chain.map((entry) => entry.taskId).join(">");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    chains.push(fact.chain);
  }
  return chains;
}
