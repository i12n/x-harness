import { describe, expect, it } from "vitest";
import {
  checkExecutionProfileContract,
  validateExecutionProfileContract,
  EXECUTION_IMAGE_PREFIX,
} from "../src/execution/contract.js";
import { buildExecutionProfile, defaultExecutionProfile } from "../src/domain/executionProfile.js";
import { DockerExecutionDriver } from "../src/execution/manager.js";
import { ValidationError } from "../src/errors.js";

describe("Execution container contract (TASK-911)", () => {
  it("accepts the default profile without issues", () => {
    const check = checkExecutionProfileContract(defaultExecutionProfile());
    expect(check.ok).toBe(true);
    expect(check.issues).toEqual([]);
    expect(defaultExecutionProfile().image.startsWith(EXECUTION_IMAGE_PREFIX)).toBe(true);
  });

  it("flags workspace and secret violations as hard issues", () => {
    const badWorkspace = buildExecutionProfile({
      name: "n",
      image: "harness/execution:node22",
      workspace: "/app",
    });
    expect(checkExecutionProfileContract(badWorkspace).issues).toEqual([
      "workspace must live under /workspace: /app",
    ]);

    const rootWorkspace = buildExecutionProfile({
      name: "n",
      image: "harness/execution:node22",
      workspace: "/",
    });
    expect(checkExecutionProfileContract(rootWorkspace).issues.length).toBeGreaterThan(0);

    const badSecret = buildExecutionProfile({
      name: "n",
      image: "harness/execution:node22",
      secrets: ["bad-name"],
    });
    expect(checkExecutionProfileContract(badSecret).issues).toEqual([
      "secret name is not a valid environment variable: bad-name",
    ]);
  });

  it("treats image naming as an advisory, not a hard failure", () => {
    const profile = buildExecutionProfile({ name: "n", image: "node:22" });
    const check = checkExecutionProfileContract(profile);
    expect(check.ok).toBe(true);
    expect(check.advisories.join(" ")).toContain(EXECUTION_IMAGE_PREFIX);
    expect(() => validateExecutionProfileContract(profile)).not.toThrow();
  });

  it("aborts docker start on a hard violation before spawning docker", async () => {
    const driver = new DockerExecutionDriver({
      dockerBinary: "definitely-not-a-real-binary",
    });
    const environment = await driver.create({
      runId: "run-001",
      workspacePath: "/tmp/ws",
      profile: buildExecutionProfile({
        name: "n",
        image: "harness/execution:node22",
        workspace: "/",
      }),
    });

    await expect(driver.start(environment)).rejects.toBeInstanceOf(ValidationError);
  });
});
