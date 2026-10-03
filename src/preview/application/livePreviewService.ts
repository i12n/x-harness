import { randomBytes } from "node:crypto";
import type { EventStore } from "../../store/eventStore.js";
import type { PreviewHostClient } from "./previewHostClient.js";

export interface LivePreview {
  deliveryId: string;
  url: string;
  port: number;
  expiresAt: string;
  token: string;
}

export interface LivePreviewServiceDeps {
  host: PreviewHostClient;
  events?: EventStore;
  /** Ports the host may hand out, in order. */
  ports?: number[];
  ttlMinutes?: number;
  /** Delivery → what to deploy. Supplied by the caller that has the evidence. */
  now?: () => Date;
}

export interface LivePreviewRequest {
  deliveryId: string;
  artifact: { kind: "bundle" | "image"; value: string };
  start: string;
  env?: Record<string, string>;
}

const DEFAULT_PORTS = [18080, 18081, 18082];
const DEFAULT_TTL_MINUTES = 120;

/**
 * TASK-1228 (harness side): start and stop live previews on a dedicated host.
 *
 * The service owns the things that must not be forgotten — one preview at a
 * time, a bounded port range, a random token and an expiry it enforces itself —
 * while the host itself is a port, so nothing here needs a real machine.
 */
export class LivePreviewService {
  private readonly running = new Map<string, LivePreview>();
  private readonly ports: number[];
  private readonly ttlMinutes: number;

  constructor(private readonly deps: LivePreviewServiceDeps) {
    this.ports = deps.ports ?? DEFAULT_PORTS;
    this.ttlMinutes = deps.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  }

  active(): LivePreview[] {
    return [...this.running.values()];
  }

  async serve(request: LivePreviewRequest): Promise<LivePreview> {
    const existing = this.running.get(request.deliveryId);
    if (existing) {
      return existing;
    }
    const port = await this.freePort();
    if (port === undefined) {
      throw new Error(
        `预览端口已用尽（${this.ports.join(", ")}）——先执行 \`预览停止\` 或等待 TTL 回收`,
      );
    }
    const token = randomBytes(16).toString("hex");
    try {
      const deployment = await this.deps.host.deploy({
        id: request.deliveryId,
        artifact: request.artifact,
        start: request.start,
        port,
        token,
        ttlMinutes: this.ttlMinutes,
        env: request.env,
      });
      const preview: LivePreview = {
        deliveryId: request.deliveryId,
        url: deployment.url,
        port: deployment.port,
        expiresAt: deployment.expiresAt,
        token,
      };
      this.running.set(request.deliveryId, preview);
      await this.record("PreviewServing", preview);
      return preview;
    } catch (error) {
      await this.record("PreviewServingFailed", {
        deliveryId: request.deliveryId,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async stop(deliveryId: string): Promise<boolean> {
    const preview = this.running.get(deliveryId);
    if (!preview) {
      return false;
    }
    this.running.delete(deliveryId);
    try {
      await this.deps.host.stop(deliveryId);
    } finally {
      await this.record("PreviewStopped", { deliveryId });
    }
    return true;
  }

  /** Called from the loop tick: expiry is enforced by us, not by the host. */
  async reap(): Promise<string[]> {
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const expired = [...this.running.values()]
      .filter((preview) => Date.parse(preview.expiresAt) <= now)
      .map((preview) => preview.deliveryId);
    for (const deliveryId of expired) {
      await this.stop(deliveryId);
    }
    return expired;
  }

  private async freePort(): Promise<number | undefined> {
    const used = new Set(this.active().map((preview) => preview.port));
    return this.ports.find((port) => !used.has(port));
  }

  private async record(type: string, payload: unknown): Promise<void> {
    try {
      await this.deps.events?.record({ type, payload });
    } catch {
      // Audit must never break a preview.
    }
  }
}
