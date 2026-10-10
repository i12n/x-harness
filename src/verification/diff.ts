import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface CollectedDiff {
  files: string[];
  /** `git diff --stat` output (short summary for humans). */
  stat: string;
  /** Truncated patch; empty when the change is too large to carry around. */
  patch: string;
}

const MAX_PATCH_CHARS = 20_000;
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

export interface GitDiffOptions {
  maxPatchChars?: number;
  /** `AI_GIT_BIN`; defaults to `git`. */
  gitBinary?: string;
  timeoutMs?: number;
  /** Test seam: run git yourself instead of spawning it. */
  runGit?: (args: string[], cwd: string) => Promise<string>;
}

/**
 * TASK-1221: the reviewer must look at what actually changed, not at what the
 * agent said it changed.
 *
 * TASK-1235: collected on the **host**, never through the execution driver. A
 * Run container cannot read the worktree's gitdir — the worktree's `.git` file
 * points at `<repo>/.git/worktrees/<id>` on the host, a path the container does
 * not mount — so `git diff` inside the container dies with "not a git
 * repository". Because collection must never fail a Run, that error was
 * swallowed and every change looked empty: the reviewer rejected real work
 * (run-aa7a46f758 shipped a CSS change plus tests and was told the diff was
 * empty). The harness owns the workspace path, so it reads the diff itself —
 * the same place `GitService` fetches, commits and publishes from.
 *
 * Evidence collection never fails a Run: if git is unavailable the diff is
 * empty and the reviewer gets less to work with.
 */
export async function collectGitDiff(
  workdir: string,
  options: GitDiffOptions = {},
): Promise<CollectedDiff> {
  const run = options.runGit ?? hostGitRunner(options);
  const limit = options.maxPatchChars ?? MAX_PATCH_CHARS;
  await includeUntrackedFiles(run, workdir);
  const names = await safeRun(run, ["diff", "--name-only"], workdir);
  const stat = await safeRun(run, ["diff", "--stat"], workdir);
  const patch = await safeRun(run, ["diff"], workdir);
  return {
    files: names
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    stat: stat.trim(),
    patch: truncate(patch, limit),
  };
}

/**
 * TASK-1265: `git diff` only reports *tracked* files, so every file the agent
 * created during a Run was invisible to the reviewer and to the harness's own
 * "production code changed without tests" check. The agent never runs
 * `git add` (publishing does), so on a real Run that meant "新增文件完全不在
 * diff 里": a task that shipped the unified download method, its component, its
 * API route and its unit tests was rejected three times in a row
 * (run-2877ce4260 / run-9a70657e35 / run-6e85d50e1d) for "missing tests".
 *
 * `add --intent-to-add` records the path only — no content is staged — and from
 * then on `git diff` reports the new file like any other change. It is
 * idempotent (the paths stop being "untracked"), and the later `git add -A` at
 * publish time still stages the real content.
 */
async function includeUntrackedFiles(
  run: (args: string[], cwd: string) => Promise<string>,
  workdir: string,
): Promise<void> {
  const listing = await safeRun(
    run,
    ["ls-files", "--others", "--exclude-standard"],
    workdir,
  );
  const files = listing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (files.length === 0) {
    return;
  }
  await safeRun(run, ["add", "--intent-to-add", "--", ...files], workdir);
}

/**
 * Run containers write worktrees as uid 1000 while the harness runs as root,
 * which trips git's "dubious ownership" guard (CVE-2022-24765). Trust exactly
 * the directory we are reading — a workspace the harness itself created — the
 * same way `GitService` does, instead of mutating the host's git config.
 */
function hostGitRunner(options: GitDiffOptions): (args: string[], cwd: string) => Promise<string> {
  const gitBinary = options.gitBinary ?? process.env.AI_GIT_BIN ?? "git";
  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  return async (args: string[], cwd: string): Promise<string> => {
    const trusted = ["-c", `safe.directory=${resolve(cwd)}`];
    const { stdout } = await execFileAsync(gitBinary, [...trusted, ...args], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      encoding: "utf8",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    return stdout;
  };
}

async function safeRun(
  run: (args: string[], cwd: string) => Promise<string>,
  args: string[],
  workdir: string,
): Promise<string> {
  try {
    return await run(args, workdir);
  } catch {
    return "";
  }
}

function truncate(value: string, limit: number): string {
  const trimmed = value.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n…(truncated)`;
}
