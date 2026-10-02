import type { ExecutionExec } from "../execution/manager.js";

export interface CollectedDiff {
  files: string[];
  /** `git diff --stat` output (short summary for humans). */
  stat: string;
  /** Truncated patch; empty when the change is too large to carry around. */
  patch: string;
}

const MAX_PATCH_CHARS = 20_000;

/**
 * TASK-1221: the reviewer must look at what actually changed, not at what the
 * agent said it changed. Collected through the execution driver so it works in
 * a container as well as locally.
 *
 * Evidence collection never fails a Run: if git is unavailable the diff is
 * empty and the reviewer gets less to work with.
 */
export async function collectGitDiff(
  exec: ExecutionExec | undefined,
  workdir: string,
  options: { maxPatchChars?: number } = {},
): Promise<CollectedDiff> {
  if (!exec) {
    return { files: [], stat: "", patch: "" };
  }
  const limit = options.maxPatchChars ?? MAX_PATCH_CHARS;
  const names = await run(exec, workdir, ["git", "diff", "--name-only"]);
  const stat = await run(exec, workdir, ["git", "diff", "--stat"]);
  const patch = await run(exec, workdir, ["git", "diff"]);
  return {
    files: names
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    stat: stat.trim(),
    patch: truncate(patch, limit),
  };
}

async function run(
  exec: ExecutionExec,
  workdir: string,
  command: string[],
): Promise<string> {
  try {
    const result = await exec(command, { cwd: workdir });
    return result.stdout ?? "";
  } catch {
    return "";
  }
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…(truncated)`;
}
