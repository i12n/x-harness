import { describe, expect, it } from "vitest";
import { updateRepositoryCommand } from "../src/cli/commands/repositoryCommands.js";
import { buildExecutionProfile } from "../src/domain/executionProfile.js";
import { applyRepositoryUpdate, buildRepository } from "../src/domain/repository.js";
import { InMemoryRepositoryStore } from "../src/store/inMemoryRepositoryStore.js";

const GIT_URL = "git@github.com:i12n/x-music.git";

function registered() {
  return buildRepository({
    id: "repo-x-music",
    name: "x-music",
    url: GIT_URL,
    localPath: "/srv/repos/x-music",
    verificationCommands: ["node test/verify.js"],
    executionProfile: buildExecutionProfile({
      name: "default",
      image: "harness/execution:node22",
      network: { mode: "restricted", allow: ["api.deepseek.com"] },
      secrets: ["DEEPSEEK_API_KEY"],
    }),
  });
}

describe("repository profile update (TASK-1218)", () => {
  it("leaves every field that was not passed alone", () => {
    const current = registered();
    const updated = applyRepositoryUpdate(current, {});

    expect(updated.verificationCommands).toEqual(["node test/verify.js"]);
    expect(updated.executionProfile).toBe(current.executionProfile);
    expect(updated.name).toBe("x-music");
    expect(updated.localPath).toBe("/srv/repos/x-music");
  });

  it("can repair the exact production misconfiguration", () => {
    const broken = buildRepository({ id: "repo-x-music", name: "x-music", url: GIT_URL });
    expect(broken.verificationCommands).toEqual([]);
    expect(broken.executionProfile.network.mode).toBe("none");

    const fixed = applyRepositoryUpdate(broken, {
      verificationCommands: ["node test/verify.js"],
      executionProfile: buildExecutionProfile({
        name: "default",
        image: "harness/execution:node22",
        network: { mode: "restricted", allow: ["api.deepseek.com"] },
        secrets: ["DEEPSEEK_API_KEY"],
      }),
    });

    expect(fixed.verificationCommands).toEqual(["node test/verify.js"]);
    expect(fixed.executionProfile.network).toEqual({
      mode: "restricted",
      allow: ["api.deepseek.com"],
    });
    expect(fixed.executionProfile.secrets).toEqual(["DEEPSEEK_API_KEY"]);
    expect(fixed.updatedAt >= broken.updatedAt).toBe(true);
  });

  it("updates the stored repository and keeps the rest intact", async () => {
    const store = new InMemoryRepositoryStore();
    await store.createRepository({
      id: "repo-x-music",
      name: "x-music",
      url: GIT_URL,
      verificationCommands: ["old"],
    });

    await updateRepositoryCommand(store, "repo-x-music", {
      verificationCommands: ["new"],
      executionProfile: buildExecutionProfile({
        name: "default",
        image: "harness/execution:node22",
      }),
    });

    const stored = await store.findRepository("repo-x-music");
    expect(stored.verificationCommands).toEqual(["new"]);
    expect(stored.executionProfile.image).toBe("harness/execution:node22");
    expect(stored.name).toBe("x-music");
  });

  it("refuses to update a repository that does not exist", async () => {
    const store = new InMemoryRepositoryStore();
    await expect(
      store.updateRepository("repo-nope", { verificationCommands: ["x"] }),
    ).rejects.toThrow(/repo-nope/);
  });

  it("rejects an invalid url instead of silently keeping the old one", () => {
    expect(() => applyRepositoryUpdate(registered(), { url: "not a url" })).toThrow(
      /invalid repository url/,
    );
  });
});
