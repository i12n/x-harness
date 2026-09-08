import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface GitFixture {
  path: string;
  cleanup(): void;
}

export function createGitFixture(): GitFixture {
  const path = mkdtempSync(join(tmpdir(), "ai-harness-repo-"));
  runGit(["init", "-b", "main"], path);
  runGit(["config", "user.email", "test@example.com"], path);
  runGit(["config", "user.name", "Test"], path);
  writeFileSync(join(path, "README.md"), "# fixture\n");
  writeFileSync(
    join(path, "AGENTS.md"),
    "# AGENTS.md\nDo not touch unrelated modules.\n",
  );
  runGit(["add", "."], path);
  runGit(["commit", "-m", "init"], path);
  return {
    path,
    cleanup: () => {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    },
  };
}

export function runGit(args: string[], cwd: string): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}
