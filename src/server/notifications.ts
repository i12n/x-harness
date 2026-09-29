import type { OutgoingMessage } from "../channel/message.js";
import { renderRunMessage } from "../channel/rendering/run.js";
import { isTerminalRunStatus } from "../domain/run.js";
import type { Run } from "../domain/run.js";
import type { EventStore } from "../store/eventStore.js";
import type { RunStore } from "../store/runStore.js";

/** Where a chat-initiated Run should report back to. */
export interface ChatTarget {
  conversationId: string;
  receiveId: string;
  receiveIdType?: "chat_id" | "open_id" | "user_id" | "email";
}

export const RUN_CHAT_TARGET_EVENT = "run.chat_target";
export const RUN_NOTIFIED_EVENT = "run.notified";

export interface RunChatNotifierOptions {
  runs: RunStore;
  events: EventStore;
  send: (target: ChatTarget, message: OutgoingMessage) => Promise<void>;
  /**
   * Used when a Run has no chat binding (e.g. created from the CLI). Without
   * it those runs stay silent in chat, which is the safe default.
   */
  defaultTarget?: ChatTarget;
}

/**
 * Reports finished Runs back to the conversation that started them.
 *
 * The binding and the "already told them" marker are both EventStore records,
 * so a daemon restart neither loses a notification nor sends it twice — the
 * run card is emitted exactly once per terminal Run.
 */
export class RunChatNotifier {
  constructor(private readonly options: RunChatNotifierOptions) {}

  /** Called when a chat command queues a Run. Idempotent per Run. */
  async bind(runId: string, target: ChatTarget): Promise<void> {
    try {
      await this.options.events.record({
        type: RUN_CHAT_TARGET_EVENT,
        runId,
        payload: target,
      });
    } catch {
      // Notification bookkeeping must never fail the command itself.
    }
  }

  /** Sends every pending terminal-run card; returns how many were sent. */
  async flush(): Promise<number> {
    const bindings = await this.pendingBindings();
    let sent = 0;
    for (const { runId, target } of bindings) {
      const run = await this.findRun(runId);
      if (!run || !isTerminalRunStatus(run.status)) {
        continue;
      }
      try {
        await this.options.send(target, {
          ...renderRunMessage(run, { conversationId: target.conversationId }),
          metadata: {
            receiveId: target.receiveId,
            receiveIdType: target.receiveIdType ?? "chat_id",
          },
        });
      } catch {
        // A transient send failure leaves the Run unmarked, so the next flush
        // retries it.
        continue;
      }
      try {
        await this.options.events.record({
          type: RUN_NOTIFIED_EVENT,
          runId,
          payload: { status: run.status, conversationId: target.conversationId },
        });
      } catch {
        // Worst case the card is sent twice; never fail the flush.
      }
      sent += 1;
    }
    return sent;
  }

  private async pendingBindings(): Promise<{ runId: string; target: ChatTarget }[]> {
    let events;
    try {
      events = await this.options.events.listEvents({ type: RUN_CHAT_TARGET_EVENT });
    } catch {
      return [];
    }
    const byRun = new Map<string, ChatTarget>();
    for (const event of events) {
      if (!event.runId) {
        continue;
      }
      const target = asTarget(event.payload);
      if (target) {
        byRun.set(event.runId, target);
      }
    }

    const pending: { runId: string; target: ChatTarget }[] = [];
    for (const [runId, target] of byRun) {
      let notified;
      try {
        notified = await this.options.events.listEvents({
          runId,
          type: RUN_NOTIFIED_EVENT,
        });
      } catch {
        continue;
      }
      if (notified.length === 0) {
        pending.push({ runId, target });
      }
    }
    return pending;
  }

  private async findRun(runId: string): Promise<Run | undefined> {
    try {
      return await this.options.runs.findRun(runId);
    } catch {
      return undefined;
    }
  }
}

function asTarget(value: unknown): ChatTarget | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const conversationId =
    typeof record.conversationId === "string" ? record.conversationId : undefined;
  const receiveId = typeof record.receiveId === "string" ? record.receiveId : undefined;
  if (!conversationId || !receiveId) {
    return undefined;
  }
  const receiveIdType =
    record.receiveIdType === "open_id" ||
    record.receiveIdType === "user_id" ||
    record.receiveIdType === "email"
      ? record.receiveIdType
      : "chat_id";
  return { conversationId, receiveId, receiveIdType };
}
