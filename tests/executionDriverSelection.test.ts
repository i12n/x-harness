import { homedir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  codexSandboxFor,
  createExecutionDriver,
  parseExecutionDriverMode,
  workspacesDir,
} from "../src/execution/driverSelection.js";

describe("execution driver selection", () => {
  it("defaults to the local driver", () => {
    expect(parseExecutionDriverMode(undefined)).toBe("local");
    expect(createExecutionDriver({}).name).toBe("local");
  });

  it("selects docker and scopes mounts to the workspace root", () => {
    expect(parseExecutionDriverMode("Docker")).toBe("docker");
    const driver = createExecutionDriver({
      AI_EXECUTION_DRIVER: "docker",
      AI_WORKSPACES_DIR: "/tmp/ai-ws",
    });
    expect(driver.name).toBe("docker");
    expect(workspacesDir({ AI_WORKSPACES_DIR: "/tmp/ai-ws" })).toBe("/tmp/ai-ws");
  });

  it("defaults the workspace root to ~/ai-workspaces", () => {
    expect(workspacesDir({})).toBe(resolve(homedir(), "ai-workspaces"));
  });

  it("rejects unknown modes instead of silently running on the host", () => {
    expect(() => parseExecutionDriverMode("podman")).toThrowError(
      /invalid AI_EXECUTION_DRIVER/,
    );
  });
});

describe("codex sandbox selection", () => {
  it("disables Codex's inner sandbox inside the container", () => {
    // Nested bwrap cannot create a user namespace in the Run container: the
    // container itself is the isolation boundary.
    expect(codexSandboxFor("docker", {})).toBe("danger-full-access");
  });

  it("keeps workspace-write when there is no outer boundary", () => {
    expect(codexSandboxFor("local", {})).toBe("workspace-write");
  });

  it("honours an explicit override", () => {
    expect(
      codexSandboxFor("docker", { AI_CODEX_SANDBOX: "read-only" }),
    ).toBe("read-only");
  });
});
