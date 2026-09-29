import type { Specification } from "../domain/specification.js";
import type { Task } from "../domain/task.js";
import type { ChatClient } from "../llm/chatClient.js";
import { parseJsonObject } from "../llm/text.js";
import type { PlanningService } from "../specification/application/planning.js";
import type { SpecificationService } from "../specification/application/service.js";
import type { ProblemStore } from "../store/problemStore.js";
import type { RepositoryStore } from "../store/repositoryStore.js";
import type { SpecificationPlanStore } from "../store/specificationPlanStore.js";
import type { SpecificationStore } from "../store/specificationStore.js";
import type { TaskStore } from "../store/taskStore.js";

export interface SpecificationBootstrapDeps {
  problems: ProblemStore;
  repositories: RepositoryStore;
  specifications: SpecificationStore;
  specificationPlans: SpecificationPlanStore;
  tasks: TaskStore;
  specificationService: SpecificationService;
  planning: PlanningService;
  chat: ChatClient;
}

export interface SpecificationBootstrapOutcome {
  specification: Specification;
  tasks: Task[];
  /** True when the outcome came from an already-planned specification. */
  replayed: boolean;
  /** Repositories the model wanted but that are not registered. */
  unknownTargets: string[];
}

interface DerivedSpecification {
  title?: string;
  summary?: string;
  requirements: string[];
  acceptance: string[];
  targets: { repositoryId: string; role: "primary" | "supporting" }[];
  unknownTargets: string[];
}

/**
 * The chat-driven continuation of a confirmed Problem:
 *
 *   CONFIRMED Problem → DRAFT Specification → READY → planned Tasks
 *
 * This is deployment composition, not a new command: the explicit command
 * catalog stays frozen, the agent-free planning path is reused, and planning
 * still never starts execution — a human asks for `task.run` next.
 */
export class SpecificationBootstrap {
  constructor(private readonly deps: SpecificationBootstrapDeps) {}

  async bootstrap(problemId: string): Promise<SpecificationBootstrapOutcome | undefined> {
    const problem = await this.deps.problems.findProblem(problemId);
    if (problem.status !== "CONFIRMED") {
      return undefined;
    }

    const existing = await this.deps.specifications.findSpecificationByProblem(problemId);
    if (existing) {
      return this.complete(existing);
    }

    const derived = await this.derive(problemId);
    const created = await this.deps.specificationService.createFromProblem({
      problemId,
      title: derived.title,
      summary: derived.summary,
      requirements: derived.requirements,
      ...(derived.acceptance.length > 0 ? { acceptance: derived.acceptance } : {}),
      ...(derived.targets.length > 0 ? { targets: derived.targets } : {}),
    });
    const outcome = await this.complete(created);
    return { ...outcome, unknownTargets: derived.unknownTargets };
  }

  /** DRAFT → READY (if needed) → PLANNED, and read back the planned Tasks. */
  private async complete(
    specification: Specification,
  ): Promise<SpecificationBootstrapOutcome> {
    let current = specification;
    if (current.status === "DRAFT") {
      current = await this.deps.specificationService.markReady(current.id);
    }
    if (current.status === "READY") {
      const planned = await this.deps.planning.plan(current.id);
      return {
        specification: planned.specification,
        tasks: planned.tasks,
        replayed: planned.replayed,
        unknownTargets: [],
      };
    }
    return {
      specification: current,
      tasks: await this.plannedTasks(current.id),
      replayed: true,
      unknownTargets: [],
    };
  }

  private async plannedTasks(specificationId: string): Promise<Task[]> {
    const items = await this.deps.specificationPlans.listPlanItems(specificationId);
    const tasks: Task[] = [];
    for (const item of items) {
      if (!item.taskId) {
        continue;
      }
      try {
        tasks.push(await this.deps.tasks.findTask(item.taskId));
      } catch {
        // A plan item without a task is a partial plan; the caller re-plans.
      }
    }
    return tasks;
  }

  private async derive(problemId: string): Promise<DerivedSpecification> {
    const problem = await this.deps.problems.findProblem(problemId);
    const repositories = await this.safeListRepositories();
    const text = await this.deps.chat.complete({
      json: true,
      messages: [
        {
          role: "system",
          content:
            "You turn a confirmed software problem into an engineering specification for an automated coding harness. Return JSON only.",
        },
        { role: "user", content: derivePrompt(problem, repositories) },
      ],
    });
    return normalizeDerived(parseJsonObject(text), repositories);
  }

  private async safeListRepositories(): Promise<{ id: string; name: string }[]> {
    try {
      const repositories = await this.deps.repositories.listRepositories();
      return repositories.map((repository) => ({
        id: repository.id,
        name: repository.name,
      }));
    } catch {
      return [];
    }
  }
}

/** Exported for testing: the exact prompt contract used for derivation. */
export function derivePrompt(
  problem: { id: string; title: string; statement: string; repositoryId?: string },
  repositories: { id: string; name: string }[],
): string {
  const confirmed = (problem as { confirmedSpec?: Record<string, unknown> }).confirmedSpec;
  const lines = [
    "A chat user confirmed this problem. Turn it into a specification an automated agent can implement.",
    "",
    `Problem id: ${problem.id}`,
    `Title: ${problem.title}`,
    `Statement: ${problem.statement}`,
  ];
  if (confirmed) {
    lines.push(
      "Confirmed understanding:",
      JSON.stringify(confirmed, null, 2),
    );
  }
  if (problem.repositoryId) {
    lines.push(`Repository chosen by the user: ${problem.repositoryId}`);
  }
  lines.push(
    "",
    "Registered repositories (use these ids only, never invent one):",
    repositories.length > 0
      ? repositories.map((repository) => `- ${repository.id} (${repository.name})`).join("\n")
      : "- (none registered)",
    "",
    "Return JSON only, no prose and no code fences:",
    '{"title": string, "summary": string, "requirements": string[],',
    ' "acceptance": string[], "targets": [{"repositoryId": string, "role": "primary"|"supporting"}]}',
    "",
    "Rules:",
    "- acceptance must hold 1..5 concrete, checkable criteria (a command to run or an observable outcome).",
    "- requirements state what must be true when the work is done, not how to do it.",
    "- give 2..4 requirements, phrased at outcome level: one task is planned per",
    "  requirement, so avoid splitting a single change into several near-duplicates.",
    "- write title, summary and requirements in the SAME LANGUAGE as the problem statement.",
    "- Exactly one target must be primary; use the repository the user chose, or the only registered one.",
  );
  return lines.join("\n");
}

/** Keeps only well-formed fields and drops unknown repository ids. */
export function normalizeDerived(
  raw: unknown,
  repositories: { id: string; name: string }[],
): DerivedSpecification {
  const record =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const known = new Set(repositories.map((repository) => repository.id));
  const unknownTargets: string[] = [];
  const targets: DerivedSpecification["targets"] = [];
  let primarySeen = false;
  for (const entry of asArray(record.targets)) {
    const item = asRecord(entry);
    const repositoryId =
      typeof item?.repositoryId === "string" ? item.repositoryId.trim() : "";
    if (!repositoryId) {
      continue;
    }
    if (known.size > 0 && !known.has(repositoryId)) {
      unknownTargets.push(repositoryId);
      continue;
    }
    const role: "primary" | "supporting" =
      item?.role === "supporting" || primarySeen ? "supporting" : "primary";
    primarySeen = primarySeen || role === "primary";
    if (!targets.some((target) => target.repositoryId === repositoryId)) {
      targets.push({ repositoryId, role });
    }
  }
  if (!primarySeen && targets.length > 0) {
    targets[0]!.role = "primary";
  }

  return {
    title: asString(record.title),
    summary: asString(record.summary),
    requirements: asStringArray(record.requirements),
    acceptance: asStringArray(record.acceptance),
    targets,
    unknownTargets,
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asStringArray(value: unknown): string[] {
  return asArray(value)
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
}
