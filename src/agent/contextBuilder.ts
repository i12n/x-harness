import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Repository } from "../domain/repository.js";
import { readTaskReviews } from "../domain/task.js";
import type { Task } from "../domain/task.js";
import { ValidationError } from "../errors.js";
import type { AgentContext } from "./types.js";

const ROOT_INSTRUCTION_FILES = ["AGENTS.md", "PROJECT.md", "README.md"];
/**
 * TASK-1236: root instruction files are injected verbatim, the `docs/` tree
 * only as a path index.
 *
 * Injecting every `docs/**` markdown file made the base prompt ~260 KB
 * (~87k tokens) for a repository with a real documentation tree, and the agent
 * re-sends that prompt on every model call — a live Run spent 29 calls and
 * 2.6M input tokens on a one-line CSS change, with the task itself worth a few
 * thousand tokens. The agent has a shell in the worktree, so it can read the
 * documents it actually needs instead of carrying all of them forever.
 */
const MAX_INSTRUCTION_BYTES = 32 * 1024;
const MAX_INSTRUCTION_BYTES_PER_TARGET = 16 * 1024;
/** Path-only index of `docs/**` (cheap, keeps the documents discoverable). */
const MAX_DOC_INDEX_BYTES = 4 * 1024;

/** One repository the agent must work in, with its workspace and workdir. */
export interface ContextTarget {
  targetId: string;
  repository: Repository;
  role: "primary" | "supporting";
  branch: string;
  /** Container workdir (or host path for the local driver). */
  workdir: string;
  /** Host-side workspace path used to read project instructions. */
  hostWorkspacePath: string;
}

export interface BuildAgentContextParams {
  runId: string;
  task: Task;
  /** Phase 10 multi-repository input. */
  targets?: ContextTarget[];
  primaryTargetId?: string;
  /** Legacy single-repository input. */
  repository?: Repository;
  workspacePath?: string;
}

interface InstructionFile {
  path: string;
  content: string;
}

/** What the harness tells the agent about a repository's own documentation. */
interface ProjectContext {
  /** Root instruction files, injected verbatim. */
  instructions: InstructionFile[];
  /** Relative paths of `docs/**` markdown, for the agent to read on demand. */
  docIndex: string[];
}

/**
 * Context Builder (plan section 十七): Task + Repository Context +
 * Project Instructions + Acceptance Criteria -> AgentContext.
 */
export async function buildAgentContext(
  params: BuildAgentContextParams,
): Promise<AgentContext> {
  const targets = normalizeContextTargets(params);
  const primary =
    targets.find((target) => target.targetId === params.primaryTargetId) ??
    targets.find((target) => target.role === "primary") ??
    targets[0]!;

  if (targets.length === 1) {
    // Single-repository prompt stays byte-for-byte compatible with Phase 1–9.
    const context = await collectProjectContext(
      primary.hostWorkspacePath,
      MAX_INSTRUCTION_BYTES,
      { includeInstructions: false },
    );
    return {
      runId: params.runId,
      task: params.task,
      repository: primary.repository,
      workspacePath: primary.hostWorkspacePath,
      prompt: composePrompt(params.task, primary.repository, context),
    };
  }

  const contextsPerTarget = new Map<string, ProjectContext>();
  let remainingBytes = MAX_INSTRUCTION_BYTES;
  for (const target of targets) {
    const budget = Math.min(MAX_INSTRUCTION_BYTES_PER_TARGET, remainingBytes);
    const context = await collectProjectContext(
      target.hostWorkspacePath,
      budget,
      { includeInstructions: target.targetId !== primary.targetId },
    );
    contextsPerTarget.set(target.targetId, context);
    remainingBytes -= context.instructions.reduce(
      (total, file) => total + Buffer.byteLength(file.content),
      0,
    );
    if (remainingBytes <= 0) {
      break;
    }
  }

  return {
    runId: params.runId,
    task: params.task,
    repository: primary.repository,
    workspacePath: primary.hostWorkspacePath,
    prompt: composeMultiRepositoryPrompt(
      params.task,
      targets,
      primary.targetId,
      contextsPerTarget,
    ),
  };
}

function normalizeContextTargets(params: BuildAgentContextParams): ContextTarget[] {
  if (params.targets && params.targets.length > 0) {
    return params.targets;
  }
  if (!params.repository || !params.workspacePath) {
    throw new ValidationError(
      "buildAgentContext requires targets[] or repository + workspacePath",
    );
  }
  const taskTarget =
    params.task.targets?.find((target) => target.role === "primary") ??
    params.task.targets?.[0];
  return [
    {
      targetId: taskTarget?.id ?? "primary",
      repository: params.repository,
      role: "primary",
      branch: "",
      workdir: params.workspacePath,
      hostWorkspacePath: params.workspacePath,
    },
  ];
}

function composeMultiRepositoryPrompt(
  task: Task,
  targets: ContextTarget[],
  primaryTargetId: string,
  contextsPerTarget: Map<string, ProjectContext>,
): string {
  const sections: string[] = [];
  sections.push(
    "You are executing a coding task across multiple repositories inside one execution environment.",
  );

  const targetLines: string[] = ["## Targets"];
  for (const target of targets) {
    const label = target.targetId === primaryTargetId ? "Primary" : "Supporting";
    targetLines.push(
      [
        `### ${label} (${target.repository.name})`,
        `Repository: ${target.repository.name} (${target.repository.url})`,
        `Target: ${target.targetId} (${target.role})`,
        `Branch: ${target.branch || "(unknown)"}`,
        `Workdir: ${target.workdir}`,
      ].join("\n"),
    );
  }
  sections.push(targetLines.join("\n\n"));

  sections.push(`Task: ${task.title}`);
  sections.push(`Task description:\n${task.description || "(none)"}`);
  if (task.acceptance.length > 0) {
    sections.push(
      `Acceptance criteria:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  const constraints = constraintsSection(task);
  if (constraints) {
    sections.push(constraints);
  }

  const contextLines: string[] = [
    "## Project Context",
    "Instructions are scoped to their repository; do not treat one repository's files as another's.",
  ];
  for (const target of targets) {
    contextLines.push(`### ${target.repository.name} (${target.targetId})`);
    const context = contextsPerTarget.get(target.targetId);
    const files = context?.instructions ?? [];
    const docs = context?.docIndex ?? [];
    const isPrimary = target.targetId === primaryTargetId;
    if (isPrimary) {
      // The primary worktree: the agent CLI loads its AGENTS.md itself.
      contextLines.push(
        "Instructions: AGENTS.md in this workspace (loaded by the agent CLI when present).",
      );
    } else if (files.length === 0 && docs.length === 0) {
      contextLines.push("(no instruction files found)");
      continue;
    } else {
      for (const file of files) {
        contextLines.push(`[${file.path}]\n${file.content.trim()}`);
      }
    }
    if (docs.length > 0) {
      contextLines.push(docIndexSection(docs));
    }
  }
  sections.push(contextLines.join("\n\n"));

  sections.push(
    harnessContract(
      targets.map((target) => ({
        repository: target.repository,
        label: `in ${target.repository.name} (${target.targetId})`,
      })),
    ),
  );
  return sections.join("\n\n");
}

function composePrompt(
  task: Task,
  repository: Repository,
  context: ProjectContext,
): string {
  const sections: string[] = [];
  sections.push(`You are executing a coding task inside a dedicated git worktree.`);
  sections.push(`Repository: ${repository.name} (${repository.url})`);
  sections.push(`Task: ${task.title}`);
  sections.push(`Task description:\n${task.description || "(none)"}`);
  if (task.acceptance.length > 0) {
    sections.push(
      `Acceptance criteria:\n${task.acceptance.map((item) => `- ${item}`).join("\n")}`,
    );
  }
  const constraints = constraintsSection(task);
  if (constraints) {
    sections.push(constraints);
  }
  const review = latestReviewSection(task);
  if (review) {
    sections.push(review);
  }
  if (context.instructions.length > 0) {
    const blocks = context.instructions
      .map(
        (file) =>
          `[${file.path}]\n${file.content.trim()}`,
      )
      .join("\n\n");
    sections.push(`Project instructions:\n${blocks}`);
  }
  if (context.docIndex.length > 0) {
    sections.push(docIndexSection(context.docIndex));
  }
  sections.push(harnessContract([{ repository }]));
  return sections.join("\n\n");
}

/**
 * The documents exist for the agent, not in the prompt: shipping their contents
 * cost ~87k tokens per model call (TASK-1236), so the harness ships the *list*
 * and lets the agent open the one or two files it needs.
 */
function docIndexSection(docIndex: string[]): string {
  return [
    "Project docs — read only the files you need (do not cat whole documents):",
    ...docIndex.map((path) => `- ${path}`),
  ].join("\n");
}

/**
 * TASK-1242: a reopened task must know what the reviewer/human objected to.
 *
 * Feedback lives in `task.constraints.reviews`, which reaches the prompt only as
 * a JSON blob among the constraints. Stating the latest one as its own section is
 * what makes the "打回 → 带着意见重跑" loop actually work.
 */
function latestReviewSection(task: Task): string | undefined {
  const reviews = readTaskReviews(task);
  const latest = reviews[reviews.length - 1];
  const text = latest?.text.trim();
  if (!text) {
    return undefined;
  }
  return `Latest review feedback (the reason this run exists — address it):\n${text}`;
}

/**
 * Constraints reach the prompt as JSON, but the reviews array does not belong in
 * it: every past review would be re-sent forever, and the latest one is stated
 * separately above. Reviews are already rendered by `latestReviewSection`.
 */
function constraintsSection(task: Task): string | undefined {
  const { reviews: _reviews, ...rest } = task.constraints;
  return Object.keys(rest).length > 0 ? `Constraints: ${JSON.stringify(rest)}` : undefined;
}

/**
 * TASK-1237: the harness, not the repository, owns delivery.
 *
 * Live evidence: a one-line CSS task ran 24+ commands over 13 minutes because
 * the agent followed the repository's AGENTS.md bookkeeping workflow (read four
 * context documents, update board/changelog/handoff, commit, then review the
 * next task) — 7 of its 10 changed files were documentation. The contract below
 * states the deployment facts the repository cannot know (what verification
 * runs, what the sandbox can reach) and settles the conflict in the harness's
 * favour.
 *
 * The repository's own AGENTS.md is *not* injected: the agent CLI loads it from
 * the workspace root (verified against codex-cli 0.154.0 — a directory holding
 * only AGENTS.md answers questions about its contents).
 */
function harnessContract(
  entries: { repository: Repository; label?: string }[],
): string {
  const lines = ["Harness contract (it overrides project docs where they conflict):"];
  const withCommands = entries.filter(
    (entry) => entry.repository.verificationCommands.length > 0,
  );
  if (withCommands.length === 1 && entries.length === 1) {
    lines.push(
      `- After you stop, the harness runs these commands in this workspace: ${withCommands[0]!.repository.verificationCommands.join(" / ")}. They must pass — do not add or rewrite package.json scripts to make them pass.`,
    );
  } else if (withCommands.length > 0) {
    for (const entry of withCommands) {
      const label = entry.label ? `${entry.label}: ` : "";
      lines.push(
        `- After you stop, the harness runs ${label}${entry.repository.verificationCommands.join(" / ")}. They must pass — do not add or rewrite package.json scripts to make them pass.`,
      );
    }
  } else {
    lines.push(
      "- The harness runs the repository's own verification separately; do not add or rewrite package.json scripts.",
    );
  }
  const networks = [
    ...new Set(entries.map((entry) => describeNetwork(entry.repository))),
  ];
  lines.push(`- Network: ${networks.join("; ")}. Assume no browser and no database.`);
  lines.push(
    "- Make the smallest change that satisfies the task. Do not commit, push, open PRs, or touch files outside the workspace — the harness owns git.",
  );
  lines.push(
    "- Do not update task boards, changelogs, handoff or project-state notes unless the task itself asks for documentation. The harness owns that bookkeeping.",
  );
  lines.push(
    "- Follow the repository's AGENTS.md, which the agent CLI loads from the workspace. When the change is done, stop; the harness runs verification separately.",
  );
  return lines.join("\n");
}

function describeNetwork(repository: Repository): string {
  const network = repository.executionProfile?.network;
  if (!network || network.mode === "none") {
    return "disabled in this environment";
  }
  return network.allow.length > 0
    ? `restricted to ${network.allow.join(", ")}`
    : "restricted";
}

async function collectProjectContext(
  workspacePath: string,
  maxBytes = MAX_INSTRUCTION_BYTES,
  options: { includeInstructions?: boolean } = {},
): Promise<ProjectContext> {
  const instructions: InstructionFile[] = [];
  let totalBytes = 0;
  // TASK-1237: the primary worktree's instruction files are loaded by the agent
  // CLI itself; only a supporting repository (mounted elsewhere) needs them in
  // the prompt, because discovery would never reach it.
  const includeInstructions = options.includeInstructions ?? true;
  for (const name of ROOT_INSTRUCTION_FILES) {
    if (!includeInstructions) {
      break;
    }
    const content = await tryRead(join(workspacePath, name));
    if (content === undefined) {
      continue;
    }
    const size = Buffer.byteLength(content);
    if (totalBytes + size > maxBytes) {
      instructions.push({
        path: "(truncated)",
        content: "[additional instruction files omitted due to size limit]",
      });
      break;
    }
    totalBytes += size;
    instructions.push({ path: name, content });
  }

  const docIndex: string[] = [];
  let indexBytes = 0;
  const docsDir = join(workspacePath, "docs");
  for (const file of await listMarkdownFiles(docsDir)) {
    const path = relative(workspacePath, file);
    const size = Buffer.byteLength(path) + 3;
    if (indexBytes + size > MAX_DOC_INDEX_BYTES) {
      docIndex.push("…(more documents omitted)");
      break;
    }
    indexBytes += size;
    docIndex.push(path);
  }

  return { instructions, docIndex };
}

async function tryRead(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const result: string[] = [];
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.pop();
    if (!current) {
      continue;
    }
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        result.push(full);
      }
    }
  }
  return result;
}
