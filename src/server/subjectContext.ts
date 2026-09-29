import type { Conversation } from "../domain/conversation.js";
import type { ProblemStore } from "../store/problemStore.js";
import type { RunStore } from "../store/runStore.js";
import type { TaskStore } from "../store/taskStore.js";

export interface SubjectContextDeps {
  problems: ProblemStore;
  tasks: TaskStore;
  runs: RunStore;
}

/**
 * Renders the facts the intent model needs to resolve pronouns and ids
 * ("确认", "回答第二个", "运行它").
 *
 * The Conversation row only carries `subjectType`/`subjectId`; the ids the
 * model must not invent — open clarification ids, the latest run id — are
 * loaded here so they never have to appear in a rendered card.
 */
export async function describeConversationSubject(
  conversation: Conversation,
  deps: SubjectContextDeps,
): Promise<string[]> {
  try {
    if (conversation.subjectType === "problem" && conversation.subjectId) {
      return await describeProblem(conversation.subjectId, deps);
    }
    if (conversation.subjectType === "task" && conversation.subjectId) {
      return await describeTask(conversation.subjectId, deps);
    }
  } catch {
    // Context is best-effort: the model still works without it.
  }
  return [];
}

async function describeProblem(problemId: string, deps: SubjectContextDeps): Promise<string[]> {
  const problem = await deps.problems.findProblem(problemId);
  const lines = [`# current problem ${problem.id} (${problem.status}): ${problem.title}`];
  const open = await deps.problems.listClarifications(problemId, { status: "OPEN" });
  if (open.length === 0) {
    return lines;
  }
  lines.push("# open clarifications — use these clarificationIds verbatim:");
  for (const clarification of open) {
    const options = clarification.options
      .map((option) => `${option.id}=${option.label}`)
      .join(", ");
    lines.push(
      `# - clarificationId=${clarification.id} question="${clarification.question}"` +
        (options ? ` options: ${options}` : " (free text answer)"),
    );
  }
  return lines;
}

async function describeTask(taskId: string, deps: SubjectContextDeps): Promise<string[]> {
  const task = await deps.tasks.findTask(taskId);
  const lines = [`# current task ${task.id} (${task.status}): ${task.title}`];
  const runs = await deps.runs.listRuns({ taskId });
  const latest = runs[runs.length - 1];
  if (latest) {
    lines.push(`# latest run ${latest.id} (${latest.status})`);
  }
  return lines;
}
