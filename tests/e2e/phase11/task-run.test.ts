import { existsSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { renderRunMessage } from "../../../src/channel/rendering/run.js";
import { renderTaskMessage } from "../../../src/channel/rendering/task.js";
import {
  createPhase11Harness,
  SampleAgentEngine,
} from "./harness.js";

describe("Phase 11 E2E — task and run", () => {
  const cleanups: (() => void)[] = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup();
    }
  });

  it("runs a task through the Worker and produces reviewable evidence", async () => {
    const h = await createPhase11Harness();
    cleanups.push(h.cleanup);
    await h.seedTask({ status: "READY" });

    const shown = await h.dispatchCommand({
      messageId: "msg-show",
      command: { type: "task.show", payload: { taskId: "task-sample" } },
      roles: ["guest"],
    });
    expect(shown.status).toBe("succeeded");
    const described = shown.data as {
      task: Parameters<typeof renderTaskMessage>[0];
      repositoryNames: Map<string, string>;
    };
    expect(
      JSON.stringify(
        renderTaskMessage(described.task, {
          repositoryNames: described.repositoryNames,
        }).blocks,
      ),
    ).toContain("sample-project");

    const ran = await h.dispatchCommand({
      messageId: "msg-run",
      command: { type: "task.run", payload: { taskId: "task-sample" } },
      roles: ["developer"],
    });
    expect(ran.status).toBe("succeeded");
    const runId = (ran.data as { runId: string }).runId;

    const run = await h.runs.findRun(runId);
    expect(run.status).toBe("SUCCEEDED");
    expect((await h.tasks.findTask("task-sample")).status).toBe("REVIEW");
    expect((h.engine as SampleAgentEngine).calls).toBe(1);

    const result = run.result as {
      targets: { repositoryId: string; passed: boolean; checks: { status: string }[] }[];
      workspaces: { path: string; branch: string }[];
    };
    expect(result.targets[0]).toMatchObject({ repositoryId: "repo-sample", passed: true });
    expect(result.targets[0]?.checks[0]?.status).toBe("passed");
    expect(result.workspaces).toHaveLength(1);
    expect(existsSync(result.workspaces[0]!.path)).toBe(true);

    const rendered = JSON.stringify(renderRunMessage(run).blocks);
    expect(rendered).toContain("✓ sample-project (主仓库)");
    expect(rendered).toContain("验证：通过");

    const shownRun = await h.dispatchCommand({
      messageId: "msg-run-show",
      command: { type: "run.show", payload: { runId } },
      roles: ["guest"],
    });
    expect(shownRun.status).toBe("succeeded");
  });
});
