export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

/**
 * TASK-1215 (①): codex `--json` reports per-turn usage. The harness used to
 * throw it away, which made every cost question unanswerable.
 *
 * Parsing is tolerant: the stream is JSONL and may contain anything, so we scan
 * for records that carry a usage object and sum them.
 */
export function parseAgentUsage(stdout: string | undefined): AgentUsage | undefined {
  if (!stdout) {
    return undefined;
  }
  let input = 0;
  let output = 0;
  let seen = false;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const usage = usageOf(record);
    if (!usage) {
      continue;
    }
    seen = true;
    input += usage.inputTokens;
    output += usage.outputTokens;
  }
  if (!seen) {
    return undefined;
  }
  return { inputTokens: input, outputTokens: output, totalTokens: input + output };
}

function usageOf(record: unknown): AgentUsage | undefined {
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return undefined;
  }
  const candidates: unknown[] = [(record as Record<string, unknown>).usage];
  const nested = (record as Record<string, unknown>).turn;
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    candidates.push((nested as Record<string, unknown>).usage);
  }
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const usage = candidate as Record<string, unknown>;
    const inputTokens = numberOrZero(usage.input_tokens ?? usage.prompt_tokens);
    const outputTokens = numberOrZero(usage.output_tokens ?? usage.completion_tokens);
    if (inputTokens > 0 || outputTokens > 0) {
      return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
    }
  }
  return undefined;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
