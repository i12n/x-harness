import type { OutgoingMessage } from "../channel/message.js";
import { renderRunMessage } from "../channel/rendering/run.js";
import { isTerminalRunStatus, RUN_STATUSES } from "../domain/run.js";
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
  /**
   * TASK-1253: last resort before staying silent — resolve where a Run belongs
   * from the requirement it implements. Runs started by the *scheduler* (the
   * auto-start path) and by the CLI never carried a binding, so their cards used
   * to be dropped even though the conversation that asked for the work exists.
   */
  resolveTarget?: (run: Run) => Promise<ChatTarget | undefined>;
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
    const bindings = await this.pendingRuns();
    let sent = 0;
    for (const { runId, target } of bindings) {
      const run = await this.findRun(runId);
      if (!run || !isTerminalRunStatus(run.status)) {
        continue;
      }
      const resolved =
        target ??
        (this.options.resolveTarget
          ? await this.options.resolveTarget(run).catch(() => undefined)
          : undefined) ??
        this.options.defaultTarget;
      if (!resolved) {
        continue;
      }
      try {
        await this.options.send(resolved, {
          ...renderRunMessage(run, { conversationId: resolved.conversationId }),
          metadata: {
            receiveId: resolved.receiveId,
            receiveIdType: resolved.receiveIdType ?? "chat_id",
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
          payload: { status: run.status, conversationId: resolved.conversationId },
        });
      } catch {
        // Worst case the card is sent twice; never fail the flush.
      }
      sent += 1;
    }
    return sent;
  }

  /**
   * TASK-1253: every terminal Run whose card has not gone out yet — not only the
   * ones a chat command bound. Scheduler- and CLI-started Runs have no binding at
   * all, and they are exactly the ones that used to stay silent.
   */
  private async pendingRuns(): Promise<{ runId: string; target?: ChatTarget }[]> {
    const targets = await this.boundTargets();
    const notified = await this.notifiedRunIds();
    let runs: Run[] = [];
    try {
      runs = await this.options.runs.listRuns({
        statuses: RUN_STATUSES.filter(isTerminalRunStatus),
      });
    } catch {
      return [];
    }
    return runs
      .filter((run) => !notified.has(run.id))
      .map((run) => ({ runId: run.id, target: targets.get(run.id) }));
  }

  /** Run id → the conversation a chat command bound it to. */
  private async boundTargets(): Promise<Map<string, ChatTarget>> {
    const byRun = new Map<string, ChatTarget>();
    try {
      const events = await this.options.events.listEvents({ type: RUN_CHAT_TARGET_EVENT });
      for (const event of events) {
        const target = event.runId ? asTarget(event.payload) : undefined;
        if (target) {
          byRun.set(event.runId!, target);
        }
      }
    } catch {
      // No bindings readable: resolution falls back to resolveTarget/default.
    }
    return byRun;
  }

  private async notifiedRunIds(): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const events = await this.options.events.listEvents({ type: RUN_NOTIFIED_EVENT });
      for (const event of events) {
        if (event.runId) {
          ids.add(event.runId);
        }
      }
    } catch {
      // Unreadable history sends at worst a duplicate card.
    }
    return ids;
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
