import type { Repository } from "../../domain/repository.js";
import type { Clarification, Problem } from "../../domain/problem.js";
import type {
  ProblemAnalysisResult,
  ProblemAnalyzerLike,
} from "../analyzer.js";

/**
 * Deterministic analyzer for offline tests/demos: returns queued analyses in
 * order. No model, no network — the real ProblemAnalyzer wires an AgentEngine.
 */
export class ScriptedProblemAnalyzer implements ProblemAnalyzerLike {
  private readonly queue: ProblemAnalysisResult[];
  private readonly fallback: ProblemAnalysisResult | undefined;

  constructor(script: ProblemAnalysisResult | ProblemAnalysisResult[]) {
    if (Array.isArray(script)) {
      this.queue = script.map((entry) => ({ ...entry }));
      this.fallback = script[script.length - 1]
        ? { ...script[script.length - 1]! }
        : undefined;
    } else {
      this.queue = [];
      this.fallback = { ...script };
    }
  }

  async analyze(
    problem: Problem,
    repository?: Repository,
    history?: Clarification[],
  ): Promise<ProblemAnalysisResult> {
    void problem;
    void repository;
    void history;
    const next = this.queue.shift() ?? this.fallback;
    if (!next) {
      throw new Error("ScriptedProblemAnalyzer has no analysis left");
    }
    return { ...next, uncertainties: [...next.uncertainties], clarifications: next.clarifications.map((clarification) => ({ ...clarification })) };
  }
}
