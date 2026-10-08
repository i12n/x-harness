import { describe, expect, it } from "vitest";
import { renderPreviewMessage } from "../src/channel/rendering/preview.js";
import type { MessageBlock } from "../src/channel/message.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import { PreviewService } from "../src/preview/application/previewService.js";
import { InMemoryEventStore } from "../src/store/inMemoryEventStore.js";

const GIT_URL = "git@github.com:i12n/x-music.git";

function repository(commands: Record<string, string>) {
  return {
    id: "repo-x",
    name: "x",
    url: GIT_URL,
    defaultBranch: "main",
    localPath: "/srv/repos/x",
    verificationCommands: [],
    executionProfile: buildExecutionProfile({
      name: "default",
      image: "harness/execution:node22",
      commands,
    }),
    createdAt: "",
    updatedAt: "",
  };
}

function fakeExecution(overrides: { failOn?: string } = {}) {
  const calls: string[][] = [];
  let prepared = 0;
  const manager = {
    async prepare() {
      prepared += 1;
      return { id: "container", runId: "preview", containerWorkspace: "/workspace" };
    },
    async exec(_env: unknown, command: string[]) {
      calls.push(command);
      const joined = command.join(" ");
      if (overrides.failOn && joined.includes(overrides.failOn)) {
        return { exitCode: 1, stdout: "boom", stderr: "" };
      }
      if (joined.includes("du -sk")) {
        const dir = command[command.length - 1] ?? "";
        return { exitCode: 0, stdout: `${dir === ".next" ? 4096 : 0}\t${dir}`, stderr: "" };
      }
      if (joined.includes("ls -1")) {
        return { exitCode: 0, stdout: "album-375.png\nalbum-320.png\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "ok", stderr: "" };
    },
    async stop() {},
    async finish() {},
    async cleanup() {},
  };
  return { manager, calls, preparedCount: () => prepared };
}

function service(commands: Record<string, string>, execution = fakeExecution()) {
  const events = new InMemoryEventStore();
  const preview = new PreviewService({
    deliveries: {
      load: async () => ({
        delivery: { id: "dlv-1", specificationId: "spec-1", status: "READY_FOR_RELEASE" } as never,
        tasks: [{ id: "task-1", repositoryId: "repo-x" } as never],
      }),
    },
    repositories: { findRepository: async () => repository(commands) },
    runs: {
      listRuns: async () => [
        {
          id: "run-1",
          taskId: "task-1",
          status: "SUCCEEDED",
          attempt: 1,
          agent: "codex",
          engine: "codex",
          createdAt: "",
          result: { workspaces: [{ targetId: "t1", path: "/root/ai-workspaces/x/w1", branch: "ai/x" }] },
        } as never,
      ],
    },
    executionManager: execution.manager as never,
    events,
    // Build "in place" in tests: the scratch copy is real filesystem work.
    fs: {
      prepare: async (source: string) => source,
      cleanup: async () => {},
      keepScreenshots: async () => {},
    },
  });
  return { preview, events, execution };
}

describe("preview build (TASK-1226)", () => {
  it("runs install → build → screenshot and records the evidence", async () => {
    const { preview, events, execution } = service({
      install: "npm ci",
      build: "npm run build",
      screenshot: "npm run preview:screenshot",
    });

    const evidence = await preview.build("dlv-1");

    expect(evidence.status).toBe("BUILT");
    expect(evidence.commands.map((entry) => entry.command.split(":")[0])).toEqual([
      "install",
      "build",
      "screenshot",
    ]);
    expect(evidence.screenshots).toEqual(["album-375.png", "album-320.png"]);
    expect(evidence.artifacts).toEqual([{ path: ".next", sizeKb: 4096 }]);
    expect(await events.listEvents({ type: "PreviewBuilt" })).toHaveLength(1);
    expect(execution.calls.some((call) => call.join(" ").includes("npm ci"))).toBe(true);
  });

  it("does not start a container when no build commands are configured", async () => {
    const { preview, execution, events } = service({});

    const evidence = await preview.build("dlv-1");

    expect(evidence.status).toBe("NO_BUILD");
    expect(evidence.notes.join()).toContain("没有配置");
    expect(execution.preparedCount()).toBe(0);
    expect(await events.listEvents({ type: "PreviewBuilt" })).toHaveLength(1);
  });

  it("reports a failed build without pretending the app works", async () => {
    const execution = fakeExecution({ failOn: "npm run build" });
    const { preview, events } = service({ install: "npm ci", build: "npm run build" }, execution);

    const evidence = await preview.build("dlv-1");

    expect(evidence.status).toBe("FAILED");
    expect(evidence.notes.join()).toContain("起不来");
    expect(evidence.commands[1]).toMatchObject({ status: "failed", exitCode: 1 });
    expect(await events.listEvents({ type: "PreviewFailed" })).toHaveLength(1);
  });

  it("previews with a restricted network that only adds package sources", async () => {
    const seen: unknown[] = [];
    const execution = fakeExecution();
    const original = execution.manager.prepare;
    execution.manager.prepare = async () => {
      seen.push("prepare");
      return original();
    };
    const { preview } = service({ build: "npm run build" }, execution);

    await preview.build("dlv-1");
    expect(seen).toEqual(["prepare"]);
  });

});

describe("preview card (TASK-1226)", () => {
  const textOf = (blocks: MessageBlock[] | undefined): string =>
    (blocks ?? []).map((block) => JSON.stringify(block)).join("\n");

  it("shows the commands, artifacts and screenshots", () => {
    const text = textOf(
      renderPreviewMessage({
        deliveryId: "dlv-1",
        status: "BUILT",
        commands: [
          { command: "build: npm run build", status: "passed", exitCode: 0, durationSeconds: 42, output: "" },
        ],
        screenshots: ["album-375.png"],
        artifacts: [{ path: ".next", sizeKb: 4096 }],
        notes: [],
        startedAt: "",
        finishedAt: "",
      }).blocks,
    );

    expect(text).toContain("构建成功");
    expect(text).toContain("npm run build");
    expect(text).toContain(".next");
    expect(text).toContain("album-375.png");
  });

  it("says plainly when there was nothing to build", () => {
    const text = textOf(
      renderPreviewMessage({
        deliveryId: "dlv-1",
        status: "NO_BUILD",
        commands: [],
        screenshots: [],
        artifacts: [],
        notes: ["执行档案没有配置 commands.install / build / screenshot"],
        startedAt: "",
        finishedAt: "",
      }).blocks,
    );
    expect(text).toContain("没有可执行的构建");
    expect(text).toContain("没有配置");
  });
});
