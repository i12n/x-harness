import type { AgentEngine } from "../agent/types.js";
import { extractAgentText, parseJsonObject } from "../agent/output.js";
import type { Repository } from "../domain/repository.js";
import type { ClarificationType, Problem } from "../domain/problem.js";
import type { Clarification } from "../domain/problem.js";
import { CLARIFICATION_TYPES } from "../domain/problem.js";
import { HarnessError } from "../errors.js";
import { makeId } from "../util/id.js";

export interface AnalyzerClarification {
  question: string;
  type: ClarificationType;
  required: boolean;
  options: { id: string; label: string }[];
  reason: string;
}

export interface ProblemAnalysisResult {
  summary: string;
  needsInput: boolean;
  uncertainties: string[];
  clarifications: AnalyzerClarification[];
}

/** Anything that can analyze a problem (LLM engine or scripted stub). */
export interface ProblemAnalyzerLike {
  analyze(
    problem: Problem,
    repository?: Repository,
    history?: Clarification[],
  ): Promise<ProblemAnalysisResult>;
}

/**
 * Problem Analyzer: decides whether the problem is clear enough to work on,
 * and if not, produces structured Clarifications (never a generic
 * "tell me more"). Uses the same AgentEngine abstraction as coding runs.
 */
export class ProblemAnalyzer implements ProblemAnalyzerLike {
  constructor(private readonly engine: AgentEngine) {}

  async analyze(
    problem: Problem,
    repository?: Repository,
    history: Clarification[] = [],
  ): Promise<ProblemAnalysisResult> {
    const result = await this.engine.execute({
      runId: makeId("anlz"),
      problem,
      repository,
      workspacePath: repository?.localPath ?? process.cwd(),
      prompt: composeAnalyzerPrompt(problem, repository, history),
    });
    const text = extractAgentText(result.stdout);
    if (!text) {
      throw new HarnessError(
        `problem analyzer produced no output (exit ${result.exitCode ?? "null"})`,
      );
    }
    let raw: unknown;
    try {
      raw = parseJsonObject(text);
    } catch (error) {
      throw new HarnessError(
        `problem analyzer returned no valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return normalizeAnalysis(raw, text);
  }
}

function normalizeAnalysis(raw: unknown, fallbackSummary: string): ProblemAnalysisResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new HarnessError("problem analyzer JSON is not an object");
  }
  const record = raw as Record<string, unknown>;
  const clarifications: AnalyzerClarification[] = [];
  if (Array.isArray(record.clarifications)) {
    for (const entry of record.clarifications) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const item = entry as Record<string, unknown>;
      const question = typeof item.question === "string" ? item.question.trim() : "";
      if (!question) {
        continue;
      }
      const type = (CLARIFICATION_TYPES as readonly string[]).includes(String(item.type))
        ? (item.type as ClarificationType)
        : "fact";
      const options: { id: string; label: string }[] = [];
      if (Array.isArray(item.options)) {
        for (const option of item.options) {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            continue;
          }
          const opt = option as Record<string, unknown>;
          const id = typeof opt.id === "string" ? opt.id.trim() : "";
          const label = typeof opt.label === "string" ? opt.label.trim() : "";
          if (id && label) {
            options.push({ id, label });
          }
        }
      }
      clarifications.push({
        question,
        type,
        required: item.required === undefined ? true : Boolean(item.required),
        options,
        reason: typeof item.reason === "string" ? item.reason.trim() : "",
      });
    }
  }

  const uncertainties = Array.isArray(record.uncertainties)
    ? record.uncertainties
        .filter((item): item is string => typeof item === "string")
        .map((item) => item.trim())
        .filter(Boolean)
    : [];

  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary.trim()
      : fallbackSummary.slice(0, 2000);

  const needsInput =
    record.needsInput === undefined ? clarifications.length > 0 : Boolean(record.needsInput);

  return { summary, needsInput, uncertainties, clarifications };
}

function composeAnalyzerPrompt(
  problem: Problem,
  repository: Repository | undefined,
  history: Clarification[],
): string {
  const sections: string[] = [];
  sections.push(
    "You are analyzing a software problem BEFORE any investigation starts.",
  );
  sections.push(`Problem title: ${problem.title}`);
  sections.push(`Problem statement:\n${problem.statement}`);
  if (repository) {
    sections.push(
      `Target repository: ${repository.name} (${repository.url}), local path ${repository.localPath}`,
    );
  }
  const answered = history.filter((clarification) => clarification.status === "ANSWERED");
  if (answered.length > 0) {
    const lines = answered.map((clarification) => {
      const option = clarification.options.find(
        (candidate) => candidate.id === clarification.answer?.optionId,
      );
      const answer = option
        ? `${option.id} (${option.label})`
        : clarification.answer?.text ?? "(no answer)";
      return `- Q: ${clarification.question}\n  A: ${answer}`;
    });
    sections.push(
      [
        "Clarifications already answered — do NOT ask these again; treat the answers as given:",
        ...lines,
      ].join("\n"),
    );
  }
  sections.push(
    [
      "Decide whether this problem is clear enough to investigate and fix.",
      "Ask the user ONLY about decisions an agent cannot resolve by reading code,",
      "running the project, or measuring (business/product decisions, scope and",
      "constraints). Never ask for information the agent can discover itself.",
      "Prefer multiple-choice options over free text; at most 3 clarifications;",
      "one decision per clarification.",
      "",
      "Return ONLY a JSON object (no prose, no markdown fences) with shape:",
      '{"summary": string, "needsInput": boolean, "uncertainties": string[],',
      ' "clarifications": [{"question": string,',
      '   "type": "fact"|"scope"|"decision"|"constraint",',
      '   "required": boolean,',
      '   "options": [{"id": string, "label": string}],',
      '   "reason": string}]}',
      "If the problem is already clear enough, set needsInput=false and clarifications=[].",
    ].join("\n"),
  );
  return sections.join("\n\n");
}
