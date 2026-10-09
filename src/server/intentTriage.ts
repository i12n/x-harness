import type { IntentEngine, IntentInput, IntentResult } from "../command/types.js";
import {
  COMMAND_TYPES,
  type CommandType,
  type IntentAction,
} from "../command/types.js";

export type IntentKind = "query" | "act" | "work" | "chat";

export interface TriageDecision {
  kind: IntentKind;
  /** Candidate command; absent for `chat`. */
  command?: unknown;
  /** TASK-1244: user-level action; absent when the engine produced a command. */
  action?: IntentAction;
  confidence: number;
  /** Where the decision came from — deterministic rules or the model. */
  stage: "rule" | "model";
  reason: string;
  /** `work` below the confidence threshold: ask before creating anything. */
  needsConfirmation: boolean;
}

export interface IntentTriage {
  classify(input: IntentInput): Promise<TriageDecision>;
}

export interface IntentTriageOptions {
  engine: IntentEngine;
  /** Below this, a `work` classification is confirmed with the user first. */
  confirmThreshold?: number;
  /** Turn off the deterministic id+verb rules (tests only). */
  rules?: boolean;
}

const DEFAULT_CONFIRM_THRESHOLD = 0.6;

/** Commands that only read facts — they never change anything. */
const QUERY_COMMANDS = new Set<CommandType>([
  "task.show",
  "task.list",
  "run.show",
  "run.list",
  "review.show",
  "review.list",
  "spec.show",
  "delivery.show",
  "delivery.list",
  "config.show",
  "conversation.show",
  "repository.list",
  "repository.show",
  "problem.list",
]);

/**
 * Deterministic routes for the highest-frequency action phrasings.
 *
 * Every one of them needs a concrete id, so precision is high and a
 * mis-route costs nothing: the model is never asked a question it can only
 * answer by guessing. Anything not matched here goes to the model.
 */
const RULES: { pattern: RegExp; build: (match: RegExpExecArray) => unknown }[] = [
  {
    pattern: /^\s*(?:运行|跑|执行|开始|run|start)\s+(task-[A-Za-z0-9_-]+)\s*$/i,
    build: (match) => ({ type: "task.run", payload: { taskId: match[1] } }),
  },
  {
    pattern: /^\s*(?:取消|停止|停掉|cancel|stop)\s+(run-[A-Za-z0-9_-]+)\s*$/i,
    build: (match) => ({ type: "run.cancel", payload: { runId: match[1] } }),
  },
  {
    pattern: /^\s*(?:通过|批准|approve)\s+(task-[A-Za-z0-9_-]+)\s*$/i,
    build: (match) => ({ type: "review.approve", payload: { taskId: match[1] } }),
  },
  {
    pattern:
      /^\s*(?:待评审|等评审|待审批|批量评审|有哪些待评审|review\s*list|pending\s*review)\s*$/i,
    build: () => ({ type: "review.list", payload: {} }),
  },
  {
    pattern: /^\s*(?:预览|构建预览|preview)\s+(dlv-[A-Za-z0-9_-]+)\s*$/i,
    build: (match) => ({ type: "preview.build", payload: { deliveryId: match[1] } }),
  },
  {
    pattern: /^\s*(?:推送|push)\s+(task-[A-Za-z0-9_-]+)\s*$/i,
    build: (match) => ({ type: "git.publish", payload: { taskId: match[1] } }),
  },
];

export function createIntentTriage(options: IntentTriageOptions): IntentTriage {
  const threshold = options.confirmThreshold ?? DEFAULT_CONFIRM_THRESHOLD;
  const useRules = options.rules !== false;

  return {
    async classify(input): Promise<TriageDecision> {
      if (useRules) {
        const rule = matchRule(input.text);
        if (rule) {
          return {
            kind: commandKind(rule),
            command: rule,
            confidence: 1,
            stage: "rule",
            reason: "识别到「动作 + 具名对象」的固定句式",
            needsConfirmation: false,
          };
        }
      }
      return decideFromIntentResult(await options.engine.parse(input), threshold, "model");
    },
  };
}

function matchRule(text: string): unknown {
  for (const rule of RULES) {
    const match = rule.pattern.exec(text);
    if (match) {
      return rule.build(match);
    }
  }
  return undefined;
}

/**
 * Shared by the triage and by callers that only have an `IntentEngine`
 * (CLI wiring, existing tests), so classification never depends on which path
 * produced the intent.
 */
export function decideFromIntentResult(
  intent: IntentResult,
  threshold = DEFAULT_CONFIRM_THRESHOLD,
  stage: "rule" | "model" = "model",
): TriageDecision {
  if (intent.action) {
    return decideFromAction(intent, threshold, stage);
  }
  const commandType = commandTypeOf(intent.command);
  const kind: IntentKind = intent.kind ?? (commandType ? commandKind(intent.command) : "chat");
  const confidence = typeof intent.confidence === "number" ? intent.confidence : 0.7;

  // A "work" verdict without a usable command is the one case we must not act
  // on: we cannot invent the statement the user is asking for.
  if (kind === "work" && !commandType) {
    return {
      kind: "work",
      confidence: Math.min(confidence, 0.5),
      stage,
      reason: intent.reason ?? "判断为新工作，但没有可执行的命令",
      needsConfirmation: true,
    };
  }
  if (kind === "chat" || !commandType) {
    return {
      kind: "chat",
      confidence,
      stage,
      reason: intent.reason ?? "没有匹配到可执行的动作",
      needsConfirmation: false,
    };
  }
  return {
    kind,
    command: intent.command,
    confidence,
    stage,
    reason: intent.reason ?? `映射到 ${commandType}`,
    needsConfirmation: kind === "work" && confidence < threshold,
  };
}

/**
 * TASK-1244: one user-level action at a time. `create` is new work, so a
 * low-confidence one keeps the confirmation step; everything else is explicit
 * enough to act on (the irreversible ones are confirmed upstream).
 */
function decideFromAction(
  intent: IntentResult,
  threshold: number,
  stage: "rule" | "model",
): TriageDecision {
  const action = intent.action!;
  const confidence = typeof intent.confidence === "number" ? intent.confidence : 0.7;
  const kind: IntentKind =
    action.type === "show"
      ? "query"
      : action.type === "create"
        ? "work"
        : action.type === "chat" || action.type === "clarify"
          ? "chat"
          : "act";
  return {
    kind,
    action,
    confidence,
    stage,
    reason: intent.reason ?? `识别为 ${action.type}`,
    needsConfirmation: action.type === "create" && confidence < threshold,
  };
}

function commandTypeOf(command: unknown): CommandType | undefined {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return undefined;
  }
  const type = (command as { type?: unknown }).type;
  return typeof type === "string" && (COMMAND_TYPES as readonly string[]).includes(type)
    ? (type as CommandType)
    : undefined;
}

function commandKind(command: unknown): IntentKind {
  const type = commandTypeOf(command);
  if (!type) {
    return "chat";
  }
  if (type === "problem.create") {
    return "work";
  }
  return QUERY_COMMANDS.has(type) ? "query" : "act";
}
