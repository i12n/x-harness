import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Repository } from "../domain/repository.js";
import type { Task } from "../domain/task.js";
import { ValidationError } from "../errors.js";
import type { AgentContext } from "./types.js";

const ROOT_INSTRUCTION_FILES = ["AGENTS.md", "PROJECT.md", "README.md"];
const MAX_INSTRUCTION_BYTES = 256 * 1024;
const MAX_INSTRUCTION_BYTES_PER_TARGET = 96 * 1024;

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
    const instructions = await collectProjectInstructions(
      primary.hostWorkspacePath,
      MAX_INSTRUCTION_BYTES,
    );
    return {
      runId: params.runId,
      task: params.task,
      repository: primary.repository,
      workspacePath: primary.hostWorkspacePath,
      prompt: composePrompt(params.task, primary.repository, instructions),
    };
  }

  const instructionsPerTarget = new Map<string, InstructionFile[]>();
  let remainingBytes = MAX_INSTRUCTION_BYTES;
  for (const target of targets) {
    const budget = Math.min(MAX_INSTRUCTION_BYTES_PER_TARGET, remainingBytes);
    const instructions = await collectProjectInstructions(
      target.hostWorkspacePath,
      budget,
    );
    instructionsPerTarget.set(target.targetId, instructions);
    remainingBytes -= instructions.reduce(
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
      instructionsPerTarget,
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
  instructionsPerTarget: Map<string, InstructionFile[]>,
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
  if (Object.keys(task.constraints).length > 0) {
    sections.push(`Constraints: ${JSON.stringify(task.constraints)}`);
  }

  const contextLines: string[] = [
    "## Project Context",
    "Instructions are scoped to their repository; do not treat one repository's files as another's.",
  ];
  for (const target of targets) {
    contextLines.push(`### ${target.repository.name} (${target.targetId})`);
    const files = instructionsPerTarget.get(target.targetId) ?? [];
    if (files.length === 0) {
      contextLines.push("(no instruction files found)");
      continue;
    }
    for (const file of files) {
      contextLines.push(`[${file.path}]\n${file.content.trim()}`);
    }
  }
  sections.push(contextLines.join("\n\n"));

  sections.push(
    "Make the code changes required by the task in the listed workspaces only. " +
      "Do not modify files outside those workspaces. When you believe the task is " +
      "done, stop; the harness runs verification separately.",
  );
  return sections.join("\n\n");
}

function composePrompt(
  task: Task,
  repository: Repository,
  instructions: InstructionFile[],
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
  if (Object.keys(task.constraints).length > 0) {
    sections.push(`Constraints: ${JSON.stringify(task.constraints)}`);
  }
  if (instructions.length > 0) {
    const blocks = instructions
      .map(
        (file) =>
          `[${file.path}]\n${file.content.trim()}`,
      )
      .join("\n\n");
    sections.push(`Project instructions:\n${blocks}`);
  }
  sections.push(
    "Make the code changes required by the task inside this workspace only. " +
      "Do not modify files outside the workspace. When you believe the task is " +
      "done, stop; the harness runs verification separately.",
  );
  return sections.join("\n\n");
}

async function collectProjectInstructions(
  workspacePath: string,
  maxBytes = MAX_INSTRUCTION_BYTES,
): Promise<InstructionFile[]> {
  const found = new Map<string, string>();

  for (const name of ROOT_INSTRUCTION_FILES) {
    const content = await tryRead(join(workspacePath, name));
    if (content !== undefined) {
      found.set(name, content);
    }
  }

  const docsDir = join(workspacePath, "docs");
  for (const file of await listMarkdownFiles(docsDir)) {
    const content = await tryRead(file);
    if (content !== undefined) {
      found.set(relative(workspacePath, file), content);
    }
  }

  const result: InstructionFile[] = [];
  let totalBytes = 0;
  for (const [path, content] of [...found.entries()].sort()) {
    const size = Buffer.byteLength(content);
    if (totalBytes + size > maxBytes) {
      result.push({
        path: "(truncated)",
        content: "[additional instruction files omitted due to size limit]",
      });
      break;
    }
    totalBytes += size;
    result.push({ path, content });
  }
  return result;
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
