import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Repository } from "../domain/repository.js";
import type { Task } from "../domain/task.js";
import type { AgentContext } from "./types.js";

const ROOT_INSTRUCTION_FILES = ["AGENTS.md", "PROJECT.md", "README.md"];
const MAX_INSTRUCTION_BYTES = 256 * 1024;

export interface BuildAgentContextParams {
  runId: string;
  task: Task;
  repository: Repository;
  workspacePath: string;
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
  const instructions = await collectProjectInstructions(params.workspacePath);
  return {
    runId: params.runId,
    task: params.task,
    repository: params.repository,
    workspacePath: params.workspacePath,
    prompt: composePrompt(params.task, params.repository, instructions),
  };
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
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_INSTRUCTION_BYTES) {
      break;
    }
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
