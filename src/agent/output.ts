/**
 * Extract the assistant text from a codex `--json` JSONL stream.
 * Falls back to raw stdout for engines that print plain text (tests, stubs).
 */
export function extractAgentText(stdout: string): string {
  const messages: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as {
        type?: string;
        item?: { type?: string; text?: string };
      };
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        if (typeof event.item.text === "string") {
          messages.push(event.item.text);
        }
      }
    } catch {
      // Ignore non-JSON lines.
    }
  }
  if (messages.length > 0) {
    return messages[messages.length - 1] ?? "";
  }
  return stdout.trim();
}

/** Parse a JSON object out of model text (tolerates prose/fences around it). */
export function parseJsonObject(text: string): unknown {
  const withoutFences = text.replace(/```(?:json)?/gi, "");
  const start = withoutFences.indexOf("{");
  const end = withoutFences.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object found in model output");
  }
  return JSON.parse(withoutFences.slice(start, end + 1));
}
