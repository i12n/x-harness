import type { Loop, TickReport } from "../loop/loop.js";

export interface LoopDaemonOptions {
  loop: Loop;
  intervalMs: number;
  /** Runs after every tick (notification flushing, metrics, …). */
  afterTick?: (report: TickReport) => Promise<void> | void;
  onError?: (error: unknown) => void;
  log?: (message: string) => void;
}

/**
 * Drives `Loop.tick()` continuously.
 *
 * `setTimeout` chaining (not `setInterval`) so a slow tick — a Run can take
 * minutes — never stacks overlapping ticks, and `stop()` always leaves the
 * daemon in a state where a shutdown can await the in-flight tick.
 */
export class LoopDaemon {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private inFlight: Promise<void> | undefined;

  constructor(private readonly options: LoopDaemonOptions) {}

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.schedule(0);
  }

  /** Stops scheduling and awaits the tick that is currently running. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }

  /** One tick + post-tick work; also used by tests and `--once`. */
  async tickOnce(): Promise<TickReport> {
    const report = await this.options.loop.tick();
    await this.options.afterTick?.(report);
    return report;
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.runOnce().finally(() => {
        this.inFlight = undefined;
        if (this.running) {
          this.schedule(this.options.intervalMs);
        }
      });
    }, delayMs);
    // A pending tick must never keep the process alive on its own.
    this.timer.unref?.();
  }

  private async runOnce(): Promise<void> {
    try {
      const report = await this.tickOnce();
      for (const error of report.errors) {
        this.options.log?.(`loop phase ${error.phase} failed: ${error.message}`);
      }
    } catch (error) {
      this.options.onError?.(error);
      this.options.log?.(
        `loop tick failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
