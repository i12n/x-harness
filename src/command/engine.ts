import type { CommandDispatcher } from "./dispatcher.js";
import {
  COMMAND_VERSION,
  type AuthorizationContext,
  type CommandResult,
  type IntentEngine,
  type IntentInput,
  type IntentResult,
} from "./types.js";

/** Deterministic engine for offline tests and demos (no model, no network). */
export class ScriptedIntentEngine implements IntentEngine {
  private queue: IntentResult[];
  private readonly script:
    | IntentResult
    | ((input: IntentInput) => IntentResult | Promise<IntentResult>);

  constructor(
    script:
      | IntentResult
      | IntentResult[]
      | ((input: IntentInput) => IntentResult | Promise<IntentResult>),
  ) {
    if (Array.isArray(script)) {
      this.queue = [...script];
      this.script = { command: undefined };
    } else {
      this.queue = [];
      this.script = script;
    }
  }

  async parse(input: IntentInput): Promise<IntentResult> {
    if (typeof this.script === "function") {
      return this.script(input);
    }
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    return this.script;
  }
}

/**
 * Wraps an unvalidated intent into a Command, injecting only *trusted* facts
 * from the incoming message. Anything the engine claims about actor or
 * conversation is ignored on purpose.
 */
export function prepareCommand(input: IntentInput, intent: unknown): unknown {
  const record =
    intent && typeof intent === "object" && !Array.isArray(intent)
      ? (intent as Record<string, unknown>)
      : {};
  const type = typeof record.type === "string" ? record.type : undefined;
  return {
    type,
    version: COMMAND_VERSION,
    actor: { channel: input.channel, userId: input.senderId },
    conversation: { id: input.conversationId },
    payload: record.payload ?? {},
    idempotencyKey: `${input.channel}:${input.messageId}:${type ?? "unknown"}`,
  };
}

export interface IntentPipelineOptions {
  engine: IntentEngine;
  dispatcher: CommandDispatcher;
}

/** IncomingMessage → Intent → Command → Dispatcher (single entry point). */
export async function handleIntent(
  input: IntentInput,
  context: AuthorizationContext,
  options: IntentPipelineOptions,
): Promise<CommandResult> {
  const intent = await options.engine.parse(input);
  return options.dispatcher.dispatch(prepareCommand(input, intent.command), context);
}
