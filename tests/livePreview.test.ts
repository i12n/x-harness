import { describe, expect, it } from "vitest";
import { LivePreviewService } from "../src/preview/application/livePreviewService.js";
import type {
  PreviewDeployRequest,
  PreviewDeployment,
} from "../src/preview/application/previewHostClient.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

function fakeHost(options: { fail?: boolean; base?: Date } = {}) {
  const deployed: PreviewDeployRequest[] = [];
  const stopped: string[] = [];
  const host = {
    async deploy(request: PreviewDeployRequest): Promise<PreviewDeployment> {
      if (options.fail) {
        throw new Error("host unreachable");
      }
      deployed.push(request);
      const base = options.base ?? new Date();
      return {
        id: request.id,
        port: request.port,
        url: `http://preview.test:${request.port}/${request.token}/`,
        expiresAt: new Date(base.getTime() + request.ttlMinutes * 60_000).toISOString(),
      };
    },
    async stop(id: string): Promise<void> {
      stopped.push(id);
    },
    async list(): Promise<{ id: string; port: number }[]> {
      return [];
    },
  };
  return { host, deployed, stopped };
}

const request = (deliveryId = "dlv-1") => ({
  deliveryId,
  artifact: { kind: "bundle" as const, value: "/srv/previews/dlv-1.tar" },
  start: "npm ci && npm run build && npm start",
});

describe("live preview service (TASK-1228, harness side)", () => {
  it("deploys with a random token, a bounded port and an expiry", async () => {
    const { host, deployed } = fakeHost();
    const events = new InMemoryEventStore();
    const service = new LivePreviewService({ host, events, ports: [18080] });

    const preview = await service.serve(request());

    expect(deployed[0]).toMatchObject({ id: "dlv-1", port: 18080, ttlMinutes: 120 });
    expect(deployed[0]!.token).toMatch(/^[0-9a-f]{32}$/);
    expect(preview.url).toContain("preview.test:18080");
    expect(Date.parse(preview.expiresAt)).toBeGreaterThan(Date.now());
    expect(await events.listEvents({ type: "PreviewServing" })).toHaveLength(1);
  });

  it("is idempotent per delivery and refuses to oversubscribe the port range", async () => {
    const { host, deployed } = fakeHost();
    const service = new LivePreviewService({ host, ports: [18080] });

    const first = await service.serve(request("dlv-1"));
    expect(await service.serve(request("dlv-1"))).toEqual(first);
    await expect(service.serve(request("dlv-2"))).rejects.toThrow(/端口已用尽/);
    expect(deployed).toHaveLength(1);
  });

  it("stops a preview and frees its port", async () => {
    const { host, stopped } = fakeHost({ base: new Date("2026-10-03T00:00:00.000Z") });
    const events = new InMemoryEventStore();
    const service = new LivePreviewService({ host, events, ports: [18080] });

    await service.serve(request("dlv-1"));
    expect(await service.stop("dlv-1")).toBe(true);
    expect(stopped).toEqual(["dlv-1"]);
    expect(service.active()).toEqual([]);
    expect(await service.stop("dlv-1")).toBe(false);
    expect(await events.listEvents({ type: "PreviewStopped" })).toHaveLength(1);
  });

  it("reaps previews whose TTL ran out", async () => {
    const { host, stopped } = fakeHost({ base: new Date("2026-10-03T00:00:00.000Z") });
    let now = new Date("2026-10-03T00:00:00.000Z");
    const service = new LivePreviewService({
      host,
      ports: [18080],
      ttlMinutes: 60,
      now: () => now,
    });

    await service.serve(request("dlv-1"));
    expect(await service.reap()).toEqual([]);

    now = new Date("2026-10-03T01:30:00.000Z");
    expect(await service.reap()).toEqual(["dlv-1"]);
    expect(stopped).toEqual(["dlv-1"]);
  });

  it("reports a host failure instead of pretending a preview exists", async () => {
    const { host } = fakeHost({ fail: true });
    const events = new InMemoryEventStore();
    const service = new LivePreviewService({ host, events });

    await expect(service.serve(request())).rejects.toThrow(/unreachable/);
    expect(service.active()).toEqual([]);
    expect(await events.listEvents({ type: "PreviewServingFailed" })).toHaveLength(1);
  });
});
