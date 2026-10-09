import type { ChatClient } from "../llm/chatClient.js";
import { parseJsonObject } from "../llm/text.js";
import {
  COMMAND_TYPES,
  COMMAND_VERSION,
  isRequirementAction,
  type Command,
  type IntentEngine,
  type IntentInput,
  type IntentAction,
  type IntentResult,
} from "./types.js";

export interface LlmIntentEngineOptions {
  client: ChatClient;
  /**
   * Recent conversation lines (oldest → newest) used to resolve "it"/"确认"
   * references. Optional so the engine stays usable without a conversation.
   */
  context?: (input: IntentInput) => Promise<string[]>;
  /**
   * Registered repositories the model may target. Resolved per message so the
   * intent can be tied to the repository the conversation is about, without a
   * deployment-wide default.
   */
  repositories?: () => Promise<IntentRepositoryHint[]>;
  /** Shown to the model as extra deployment knowledge (repositories, users). */
  extraInstructions?: string;
}

/** A repository id/name pair handed to the intent model as deploy knowledge. */
export interface IntentRepositoryHint {
  id: string;
  name: string;
}

/**
 * Natural language → Command. The engine only ever produces a *candidate*
 * command shape: `prepareCommand()` re-injects actor/conversation/idempotency
 * from the trusted message, so a model can never impersonate a user.
 */
export class LlmIntentEngine implements IntentEngine {
  private readonly client: ChatClient;
  private readonly context: ((input: IntentInput) => Promise<string[]>) | undefined;
  private readonly repositories: (() => Promise<IntentRepositoryHint[]>) | undefined;
  private readonly extraInstructions: string | undefined;

  constructor(options: LlmIntentEngineOptions) {
    this.client = options.client;
    this.context = options.context;
    this.repositories = options.repositories;
    this.extraInstructions = options.extraInstructions;
  }

  async parse(input: IntentInput): Promise<IntentResult> {
    const context = (await this.context?.(input)) ?? [];
    const repositories = (await this.repositories?.()) ?? [];
    const text = await this.client.complete({
      json: true,
      messages: [
        {
          role: "system",
          content: intentSystemPrompt({ repositories, extraInstructions: this.extraInstructions }),
        },
        { role: "user", content: userTurn(input, context) },
      ],
    });
    const result = normalizeIntent(parseJsonObject(text));
    // When the engine knows the registered repositories, a repositoryId the
    // model invented is dropped so the harness asks instead of targeting a
    // repository that does not exist.
    return this.repositories
      ? dropUnknownRepository(result, repositories)
      : result;
  }
}

/** Removes a `problem.create.repositoryId` that is not a registered id. */
export function dropUnknownRepository(
  intent: IntentResult,
  repositories: IntentRepositoryHint[],
): IntentResult {
  const command = intent.command;
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return intent;
  }
  const record = command as Record<string, unknown>;
  if (record.type !== "problem.create") {
    return intent;
  }
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : undefined;
  if (!payload) {
    return intent;
  }
  const repositoryId = payload.repositoryId;
  if (typeof repositoryId !== "string" || !repositoryId.trim()) {
    return intent;
  }
  if (repositories.some((repository) => repository.id === repositoryId.trim())) {
    return intent;
  }
  const nextPayload = { ...payload };
  delete nextPayload.repositoryId;
  return { ...intent, command: { ...record, payload: nextPayload } };
}

export interface IntentPromptOptions {
  /** Registered repositories the model may pick a target from. */
  repositories?: IntentRepositoryHint[];
  /** Deployment knowledge appended after the catalog (see `AI_INTENT_NOTES`). */
  extraInstructions?: string;
}

/** Exported for testing: the exact prompt handed to the model (TASK-1244). */
export function intentSystemPrompt(options: IntentPromptOptions = {}): string {
  const repositories = options.repositories ?? [];
  const extraInstructions = options.extraInstructions;
  const lines = [
    "You are the intent router for an AI coding harness driven from a chat group.",
    "Understand what the user wants and return exactly ONE action.",
    "There is NO required phrasing: never ask the user to use specific words or ids.",
    "",
    "Actions:",
    "- show      — wants progress / evidence / the test URL / current state.",
    "- approve   — accepts what is waiting for them right now (a task under review, or",
    "              an accepted delivery they want released).",
    "- reject    — thinks the result is wrong and wants it adjusted (including a failed",
    "              acceptance on the test environment, or a change to the requirement).",
    "- deploy    — push the change to the test environment.",
    "- publish   — accepts the result and wants it merged/released.",
    "- rerun     — just run it again, with no new opinion.",
    "- create    — describes something NEW to do (new requirement / new bug); keep the",
    "              user's own wording in `statement`.",
    "- chat      — small talk, a concept question, or nothing to act on.",
    "- clarify   — the intent cannot be pinned down; ask one short question instead",
    "              (`payload.question` required, `payload.options` optional).",
    "",
    "How to decide (in this order):",
    "1. Questions first: a sentence with 吗 / ？ / 为什么 / 是不是 / 能不能 / 怎么 means",
    "   the user wants to KNOW something — never an execution. Answer with show when it",
    "   is about the current requirement, otherwise chat.",
    "2. Bare short replies with no object (可以 / 行 / 好 / 嗯 / ok / 批准) → clarify.",
    "3. deploy / publish / reject are irreversible: they need a clear action intent.",
    "   If it is not there, clarify — never guess.",
    "4. Something else, or something new → create.",
    "5. No matching action (e.g. 回滚) → chat; do not force it into a similar action.",
    "6. Stage decides meaning: 「可以上线了」 on an accepted delivery = publish intent,",
    "   while 「可以上线吗？」 is a question.",
    "",
    "Rules:",
    "- Never emit or ask for internal ids of any kind. The harness resolves the current",
    "  requirement from the conversation; if the user pastes an id, ignore it.",
    "- For reject keep the user's own wording in `feedback`; for create in `statement`.",
    "- 「通过 / 批准 / 可以了 / 没问题 / 验收通过」means approve; 「发布 / 上线 / 合并」means",
    "  publish. The stage decides which object that touches — never ask for an id.",
    "- Answer with JSON only, no prose and no code fences:",
    '  {"kind": "query"|"act"|"work"|"chat",',
    '   "action": "show"|"reject"|"deploy"|"publish"|"rerun"|"create"|"chat"|"clarify",',
    '   "payload": {...}, "confidence": 0.0-1.0, "reason": "<short, in the user\'s language>"}',
    "- kind: query = read-only, act = act on existing work, work = new work, chat = other.",
    "- Secret values never pass through you. The bot intercepts 「设置 <KEY> <值>」 before",
    "  you are called; if a credential still appears, return action \"chat\" and say",
    "  nothing about its content.",
  ];
  lines.push(
    "",
    "Registered repositories (used by action=create only):",
    repositories.length > 0
      ? repositories.map((repository) => `- ${repository.id} (${repository.name})`).join("\n")
      : "- (none registered)",
    "- Set repositoryId from the conversation context when the user names or clearly",
    "  implies one; otherwise leave it out and the harness will ask.",
  );
  if (extraInstructions?.trim()) {
    lines.push("", "Deployment notes:", extraInstructions.trim());
  }
  return lines.join("\n");
}

function userTurn(input: IntentInput, context: string[]): string {
  const parts: string[] = [];
  if (context.length > 0) {
    parts.push("Recent conversation (oldest first):", ...context, "");
  }
  parts.push(`Current message from ${input.senderId}:`, input.text);
  return parts.join("\n");
}

/**
 * Turns model output into an IntentResult. Unknown or malformed types become
 * "no actionable intent" so the channel can answer with help instead of
 * surfacing a raw validation rejection.
 */
export function normalizeIntent(raw: unknown): IntentResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { command: undefined };
  }
  const record = raw as Record<string, unknown>;
  // Classification survives even when no command came back: "this is new work
  // but I could not build the command for it" is exactly the case triage must
  // see, so it can ask instead of silently answering a help card.
  const confidence =
    typeof record.confidence === "number" && Number.isFinite(record.confidence)
      ? record.confidence
      : undefined;
  const kind = normalizeKind(record.kind);
  const reason = typeof record.reason === "string" ? record.reason.trim() : undefined;
  const classified = { confidence, kind, reason: reason || undefined };

  // TASK-1244: the user-level action is the primary shape. It carries no ids —
  // the harness resolves the requirement from the conversation.
  const action = normalizeAction(record.action, record.payload);
  if (action) {
    return { command: undefined, action, ...classified };
  }

  const type = typeof record.type === "string" ? record.type.trim() : "";
  if (!type || !(COMMAND_TYPES as readonly string[]).includes(type)) {
    return { command: undefined, ...classified };
  }
  const payload =
    record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  const command: Pick<Command, "type" | "version" | "payload"> = {
    type: type as Command["type"],
    version: COMMAND_VERSION,
    payload,
  };
  return { command, ...classified };
}

/** Triage classification; unknown values are dropped, not guessed. */
export function normalizeKind(value: unknown): IntentResult["kind"] | undefined {
  return value === "query" || value === "act" || value === "work" || value === "chat"
    ? value
    : undefined;
}

/**
 * TASK-1244: validates the model's user-level action. Only declared actions
 * survive, and the payload is filtered down to the fields each action uses — a
 * model that invents an id field cannot smuggle one through.
 */
export function normalizeAction(
  type: unknown,
  payload: unknown,
): IntentAction | undefined {
  if (!isRequirementAction(type)) {
    return undefined;
  }
  const raw =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  switch (type) {
    case "reject": {
      const feedback = text(raw.feedback);
      return { type, ...(feedback ? { payload: { feedback } } : { payload: {} }) };
    }
    case "create": {
      const statement = text(raw.statement);
      const repositoryId = text(raw.repositoryId);
      return {
        type,
        payload: { ...(statement ? { statement } : {}), ...(repositoryId ? { repositoryId } : {}) },
      };
    }
    case "clarify": {
      const question = text(raw.question);
      const options = Array.isArray(raw.options)
        ? raw.options.filter((entry): entry is string => typeof entry === "string")
        : undefined;
      return {
        type,
        payload: { ...(question ? { question } : {}), ...(options?.length ? { options } : {}) },
      };
    }
    default:
      // show / deploy / publish / rerun / chat take no arguments.
      return { type, payload: {} };
  }
}
