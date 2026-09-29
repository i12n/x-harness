import type { OutgoingMessage } from "../channel/message.js";
import { renderProblemMessage } from "../channel/rendering/problem.js";
import { renderRunCancelMessage, renderRunMessage } from "../channel/rendering/run.js";
import { renderPublishLines, type PublishView } from "../channel/rendering/review.js";
import type { CommandResult } from "../command/types.js";
import type { Clarification, Problem } from "../domain/problem.js";
import type { Run } from "../domain/run.js";

/**
 * Command results from a chat session are always rendered from facts. Handlers
 * that already produce a business card (`data.message`) win; everything else is
 * rendered here so the channel never inspects domain objects itself.
 */
export function renderCommandResult(
  result: CommandResult,
  conversationId: string,
): OutgoingMessage {
  if (result.status !== "succeeded") {
    return {
      conversationId,
      text: `❌ ${result.type} ${result.status}: ${
        result.error?.code ?? "unknown"
      } — ${result.error?.message ?? ""}`.trim(),
    };
  }

  const data = asRecord(result.data);
  const card = asOutgoingMessage(data?.message);
  if (card) {
    return { ...card, conversationId, metadata: { ...card.metadata } };
  }

  switch (result.type) {
    case "problem.create":
    case "problem.confirm":
    case "problem.clarification.answer": {
      const problem = data?.problem as Problem | undefined;
      if (problem) {
        return renderProblemMessage(problem, {
          conversationId,
          needsInput: Boolean(data?.needsInput),
          clarifications: (data?.clarifications as Clarification[] | undefined) ?? [],
        });
      }
      break;
    }
    case "task.run": {
      const run = data?.run as Run | undefined;
      if (run) {
        return {
          conversationId,
          text: `🚀 ${run.id} queued for task ${run.taskId}`,
          blocks: renderRunMessage(run, { conversationId }).blocks,
        };
      }
      break;
    }
    case "run.show": {
      const run = data?.run as Run | undefined;
      if (run) {
        return renderRunMessage(run, { conversationId });
      }
      break;
    }
    case "run.cancel": {
      const run = data?.run as Run | undefined;
      if (run) {
        return { ...renderRunCancelMessage(run), conversationId };
      }
      break;
    }
    case "review.approve":
    case "review.request_changes": {
      const task = asRecord(data?.task);
      if (task) {
        const verb =
          result.type === "review.approve" ? "✅ Approved" : "🔁 Changes requested for";
        const publish = (data?.publish as PublishView[] | undefined) ?? [];
        const lines = publish.length > 0 ? renderPublishLines(publish) : [];
        return lines.length === 0
          ? {
              conversationId,
              text: `${verb} ${String(task.id)} (status: ${String(task.status)})`,
            }
          : {
              conversationId,
              text: `${verb} ${String(task.id)} (status: ${String(task.status)})`,
              blocks: [{ type: "markdown", text: lines.join("\n") }],
            };
      }
      break;
    }
    case "git.publish": {
      const outcomes = (data?.outcomes as PublishView[] | undefined) ?? [];
      return {
        conversationId,
        blocks: [
          {
            type: "markdown",
            text: renderPublishLines(outcomes).join("\n") || "没有可发布的内容",
          },
        ],
      };
    }
    default:
      break;
  }

  return {
    conversationId,
    text: `✅ ${result.type} (${result.commandId})`,
  };
}

/** Shown when the sender is not on the allow-list. */
export function renderNotAllowedMessage(conversationId: string, userId: string): OutgoingMessage {
  return {
    conversationId,
    text: `⛔ 未授权：${userId} 不在 FEISHU_ALLOWED_OPEN_IDS 白名单内`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asOutgoingMessage(value: unknown): OutgoingMessage | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }
  if (typeof record.text !== "string" && !Array.isArray(record.blocks)) {
    return undefined;
  }
  return {
    conversationId: typeof record.conversationId === "string" ? record.conversationId : "",
    text: typeof record.text === "string" ? record.text : undefined,
    blocks: Array.isArray(record.blocks)
      ? (record.blocks as OutgoingMessage["blocks"])
      : undefined,
    metadata: asRecord(record.metadata),
  };
}
