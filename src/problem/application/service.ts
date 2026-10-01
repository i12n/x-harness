import type { Clarification, Problem } from "../../domain/problem.js";
import { HarnessError } from "../../errors.js";
import type { ProblemStore } from "../../store/problemStore.js";
import type { ConfirmationLoop, AnalyzeOutcome } from "../confirmationLoop.js";

export class ProblemConfirmationError extends HarnessError {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProblemConfirmationError";
    this.code = code;
  }
}

export interface CreateProblemViaCommandInput {
  title: string;
  statement: string;
  repositoryId?: string;
}

export interface ProblemCreateOutcome {
  problem: Problem;
  needsInput: boolean;
  clarifications: Clarification[];
}

/**
 * TASK-1107: Problem application service used by command handlers. It owns the
 * Confirmation loop wiring and the *domain* rules (e.g. a problem with open
 * required clarifications cannot be force-confirmed).
 */
export class ProblemService {
  constructor(
    private readonly problems: ProblemStore,
    private readonly loop: ConfirmationLoop,
  ) {}

  /** Create the problem, then run one analysis round. */
  async create(input: CreateProblemViaCommandInput): Promise<ProblemCreateOutcome> {
    const problem = await this.problems.createProblem({
      title: input.title,
      statement: input.statement,
      repositoryId: input.repositoryId,
    });
    const outcome = await this.loop.analyze(problem.id);
    return {
      problem: outcome.problem,
      needsInput: outcome.needsInput,
      clarifications: outcome.clarifications,
    };
  }

  /** Domain rule: pending (OPEN) clarifications block manual confirmation. */
  async confirm(problemId: string): Promise<Problem> {
    const open = await this.problems.listClarifications(problemId, {
      status: "OPEN",
    });
    if (open.length > 0) {
      throw new ProblemConfirmationError(
        "required_clarification_pending",
        `problem ${problemId} has ${open.length} open clarification(s)`,
      );
    }
    return this.loop.confirm(problemId);
  }

  /**
   * Answer one clarification. `answer` may be an option id or free text; free
   * text is only used when it does not match an offered option.
   */
  async answer(
    problemId: string,
    clarificationId: string,
    input: { optionId?: string; optionIds?: string[]; text?: string; answer?: string },
  ): Promise<AnalyzeOutcome> {
    const clarification = await this.problems.findClarification(clarificationId);
    if (clarification.problemId !== problemId) {
      throw new ProblemConfirmationError(
        "invalid_clarification",
        `clarification ${clarificationId} does not belong to problem ${problemId}`,
      );
    }

    // A multi-select card submits every ticked option at once. One option keeps
    // the exact single-answer path; several become one combined text answer
    // (still built from the offered labels, never invented here).
    const optionIds = (input.optionIds ?? []).map((id) => id.trim()).filter(Boolean);
    if (optionIds.length > 0) {
      const labels = optionIds.map((id) => {
        const option = clarification.options.find((entry) => entry.id === id);
        if (!option) {
          throw new ProblemConfirmationError(
            "invalid_answer",
            `clarification ${clarificationId} has no option '${id}'`,
          );
        }
        return option.label;
      });
      if (optionIds.length === 1) {
        return this.loop.answer(problemId, clarificationId, { optionId: optionIds[0] });
      }
      return this.loop.answer(problemId, clarificationId, {
        text: labels.join("、"),
      });
    }

    let optionId = input.optionId?.trim() || undefined;
    let text = input.text?.trim() || undefined;
    const freeform = input.answer?.trim() || undefined;
    if (!optionId && freeform) {
      optionId = clarification.options.some((option) => option.id === freeform)
        ? freeform
        : undefined;
      text = optionId ? text : (text ?? freeform);
    }
    if (!optionId && !text) {
      throw new ProblemConfirmationError(
        "invalid_answer",
        `clarification ${clarificationId} requires an option or text answer`,
      );
    }
    return this.loop.answer(problemId, clarificationId, { optionId, text });
  }

  async get(problemId: string): Promise<Problem> {
    return this.problems.findProblem(problemId);
  }

  async listClarifications(problemId: string): Promise<Clarification[]> {
    return this.problems.listClarifications(problemId);
  }
}
