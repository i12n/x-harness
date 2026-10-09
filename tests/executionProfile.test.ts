import { describe, expect, it } from "vitest";
import {
  buildExecutionProfile,
  defaultExecutionProfile,
} from "../src/domain/executionProfile.js";
import { ValidationError } from "../src/errors.js";

describe("ExecutionProfile", () => {
  it("requires name and image", () => {
    expect(() => buildExecutionProfile({ name: "", image: "x" })).toThrow(
      ValidationError,
    );
    expect(() => buildExecutionProfile({ name: "n", image: " " })).toThrow(
      ValidationError,
    );
  });

  it("applies safe defaults", () => {
    const profile = buildExecutionProfile({ name: "node", image: "harness/node:22" });

    expect(profile.workspace).toBe("/workspace");
    expect(profile.network).toEqual({ mode: "none", allow: [] });
    expect(profile.resources).toEqual({ cpus: 2, memoryMb: 2048, pidsLimit: 512 });
    expect(profile.policy).toEqual({
      workspaceAccess: "read_write",
      hostFilesystem: "deny",
      // TASK-1240: new repositories may publish (only ai/,test/ branches, and
      // only after approval); everything else stays denied.
      gitPush: "allow",
      dockerAccess: "deny",
      productionAccess: "deny",
    });
    expect(profile.secrets).toEqual([]);
  });

  it("clamps resources to safe ranges", () => {
    const profile = buildExecutionProfile({
      name: "node",
      image: "harness/node:22",
      resources: { cpus: 1000, memoryMb: 1, pidsLimit: 1 },
    });
    expect(profile.resources).toEqual({ cpus: 64, memoryMb: 128, pidsLimit: 16 });
  });

  it("rejects an invalid network mode and dedupes secrets/allow-list", () => {
    expect(() =>
      buildExecutionProfile({
        name: "node",
        image: "img",
        // @ts-expect-error invalid on purpose
        network: { mode: "open" },
      }),
    ).toThrow(ValidationError);

    const profile = buildExecutionProfile({
      name: "node",
      image: "img",
      network: { mode: "restricted", allow: ["github.com", "github.com", " "] },
      secrets: ["GITHUB_TOKEN", "GITHUB_TOKEN"],
    });
    expect(profile.network.allow).toEqual(["github.com"]);
    expect(profile.secrets).toEqual(["GITHUB_TOKEN"]);
  });

  it("provides a default profile", () => {
    const profile = defaultExecutionProfile();
    expect(profile.name).toBe("default");
    expect(profile.image).toContain("harness/execution");
  });
});
