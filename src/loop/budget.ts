import type { Run } from "../domain/run.js";
import type { EventStore } from "../store/eventStore.js";
import type { RunStore } from "../store/runStore.js";

export interface TokenBudgetDeps {
  runs: RunStore;
  events?: EventStore;
  /** Tokens allowed per UTC day; 0 disables the guard. */
  dailyTokenBudget: number;
  now?: () => Date;
}

/**
 * TASK-1215 (③): with auto-start on, a runaway loop can spend without anyone
 * noticing. The guard reads the usage every Run recorded and stops handing out
 * new work once the day's budget is gone. It reports the transition once — not
 * once per tick — so the log and the chat stay readable.
 */
export class TokenBudget {
  private exhausted = false;

  constructor(private readonly deps: TokenBudgetDeps) {}

  get enabled(): boolean {
    return this.deps.dailyTokenBudget > 0;
  }

  async spentToday(): Promise<number> {
    if (!this.enabled) {
      return 0;
    }
    const now = this.deps.now?.() ?? new Date();
    const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    let spent = 0;
    for (const run of await this.safeListRuns()) {
      if (!run.finishedAt || Date.parse(run.finishedAt) < dayStart) {
        continue;
      }
      spent += totalTokensOf(run);
    }
    return spent;
  }

  /** False when the day's budget is gone; emits once on each transition. */
  async canStart(): Promise<boolean> {
    if (!this.enabled) {
      return true;
    }
    const spent = await this.spentToday();
    const exhausted = spent >= this.deps.dailyTokenBudget;
    if (exhausted !== this.exhausted) {
      this.exhausted = exhausted;
      await this.record(exhausted ? "TokenBudgetExhausted" : "TokenBudgetRestored", {
        spent,
        budget: this.deps.dailyTokenBudget,
      });
    }
    return !exhausted;
  }

  private async record(type: string, payload: unknown): Promise<void> {
    try {
      await this.deps.events?.record({ type, payload });
    } catch {
      // Budget accounting must never break scheduling.
    }
  }

  private async safeListRuns(): Promise<Run[]> {
    try {
      return await this.deps.runs.listRuns();
    } catch {
      // A read failure must not stop the pipeline.
      return [];
    }
  }
}

/** `run.result.usage.totalTokens`, when a Run recorded usage (TASK-1215 ①). */
export function totalTokensOf(run: Run): number {
  const result = run.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return 0;
  }
  const usage = (result as Record<string, unknown>).usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
    return 0;
  }
  const total = (usage as Record<string, unknown>).totalTokens;
  return typeof total === "number" && total > 0 ? total : 0;
}
