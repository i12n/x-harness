import type { Repository } from "../../domain/repository.js";
import type { Clarification, Problem } from "../../domain/problem.js";
import { HarnessError } from "../../errors.js";
import type { ChatClient } from "../../llm/chatClient.js";
import { parseJsonObject } from "../../llm/text.js";
import {
  composeAnalyzerPrompt,
  normalizeAnalysis,
  type ProblemAnalysisResult,
  type ProblemAnalyzerLike,
} from "../analyzer.js";

/**
 * Chat-completion backed Problem Analyzer.
 *
 * `ProblemAnalyzer` (the Codex-backed one) spawns a full agent session per
 * analysis; on a chat-driven deployment the analysis runs once per clarification
 * round, so a direct model call is faster and cheaper. Both share the same
 * prompt contract and the same normalization rules.
 */
export class LlmProblemAnalyzer implements ProblemAnalyzerLike {
  constructor(private readonly client: ChatClient) {}

  async analyze(
    problem: Problem,
    repository?: Repository,
    history: Clarification[] = [],
  ): Promise<ProblemAnalysisResult> {
    const text = await this.client.complete({
      json: true,
      messages: [
        {
          role: "system",
          content:
            "You analyse software problems and return JSON only, with no prose and no code fences.",
        },
        { role: "user", content: composeAnalyzerPrompt(problem, repository, history) },
      ],
    });
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
