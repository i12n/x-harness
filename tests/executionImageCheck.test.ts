import { describe, expect, it } from "vitest";
import {
  assertExecutionImageAvailable,
  inspectExecutionImage,
  missingImageMessage,
} from "../src/execution/imageCheck.js";

describe("execution image check (TASK-1217)", () => {
  it("passes when the image can be inspected", async () => {
    const seen: string[] = [];
    const result = await inspectExecutionImage("harness/execution:node22", async (image) => {
      seen.push(image);
    });

    expect(result.ok).toBe(true);
    expect(seen).toEqual(["harness/execution:node22"]);
  });

  it("reports a missing image with the exact run-time symptom", async () => {
    const result = await inspectExecutionImage("harness/execution:base", async () => {
      throw new Error("Error: No such image: harness/execution:base");
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("harness/execution:base");
    expect(result.message).toContain("启动容器时直接失败");
    expect(result.message).toContain("deploy/install.sh");
    expect(result.message).toContain("--exec-image harness/execution:node22");
  });

  it("rejects an empty image name without shelling out", async () => {
    let called = false;
    const result = await inspectExecutionImage("   ", async () => {
      called = true;
    });

    expect(result.ok).toBe(false);
    expect(called).toBe(false);
  });

  it("keeps the docker detail in the message", () => {
    expect(missingImageMessage("x:1", new Error("boom\nsecond line"))).toContain("boom");
  });
});

describe("registration gate (TASK-1217)", () => {
  it("refuses to register a repository whose image is missing", async () => {
    await expect(
      assertExecutionImageAvailable("harness/execution:base", async () => ({
        ok: false,
        message: "missing image",
      })),
    ).rejects.toThrow("missing image");
  });

  it("lets a present image through", async () => {
    await expect(
      assertExecutionImageAvailable("harness/execution:node22", async () => ({
        ok: true,
        message: "present",
      })),
    ).resolves.toBeUndefined();
  });
});
