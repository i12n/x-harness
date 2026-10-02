import type { ChatClient } from "../llm/chatClient.js";
import { parseJsonObject } from "../llm/text.js";
import {
  COMMAND_TYPES,
  COMMAND_VERSION,
  type Command,
  type IntentEngine,
  type IntentInput,
  type IntentResult,
} from "./types.js";

export interface LlmIntentEngineOptions {
  client: ChatClient;
  /**
   * Recent conversation lines (oldest → newest) used to resolve "it"/"确认"
   * references. Optional so the engine stays usable without a conversation.
   */
  context?: (input: IntentInput) => Promise<string[]>;
  /** Repository applied to `problem.create` when the user names no target. */
  defaultRepositoryId?: string;
  /** Shown to the model as extra deployment knowledge (repositories, users). */
  extraInstructions?: string;
}

/**
 * Natural language → Command. The engine only ever produces a *candidate*
 * command shape: `prepareCommand()` re-injects actor/conversation/idempotency
 * from the trusted message, so a model can never impersonate a user.
 */
export class LlmIntentEngine implements IntentEngine {
  private readonly client: ChatClient;
  private readonly context: ((input: IntentInput) => Promise<string[]>) | undefined;
  private readonly defaultRepositoryId: string | undefined;
  private readonly extraInstructions: string | undefined;

  constructor(options: LlmIntentEngineOptions) {
    this.client = options.client;
    this.context = options.context;
    this.defaultRepositoryId = options.defaultRepositoryId;
    this.extraInstructions = options.extraInstructions;
  }

  async parse(input: IntentInput): Promise<IntentResult> {
    const context = (await this.context?.(input)) ?? [];
    const text = await this.client.complete({
      json: true,
      messages: [
        { role: "system", content: intentSystemPrompt(this.defaultRepositoryId, this.extraInstructions) },
        { role: "user", content: userTurn(input, context) },
      ],
    });
    return normalizeIntent(parseJsonObject(text));
  }
}

/** Exported for testing: the exact catalog text handed to the model. */
export function intentSystemPrompt(
  defaultRepositoryId?: string,
  extraInstructions?: string,
): string {
  const lines = [
    "You are the intent router for an AI coding harness driven from a chat group.",
    "Map the user's message to exactly ONE command from this catalog:",
    "",
    "- problem.create {title: string, statement: string, repositoryId?: string}",
    "    The user describes something to build or fix. title is short; statement keeps the",
    "    user's own wording and constraints. Use this instead of asking the user to rephrase.",
    "- problem.confirm {problemId: string}",
    "    The user accepts the current understanding and wants work to start. Only valid",
    "    when the context lists NO open clarifications; while a question is open the user",
    "    is answering it, not confirming.",
    "- problem.clarification.answer {problemId, clarificationId, optionId?, text?}",
    "    The user answers a pending question. Prefer optionId when the answer matches one of",
    "    the offered options; otherwise put the free-text answer in `text`.",
    "- task.show {taskId: string}",
    "- task.run {taskId: string} — start development for that task.",
    "- run.show {runId: string}",
    "- run.cancel {runId: string}",
    "- review.show {taskId: string}",
    "- review.list {} — every task waiting for review, as one batch card the user can",
    "    tick several items on and approve in a single submit.",
    "- review.approve {taskId: string}",
    "- review.approve_batch {taskIds: string[]} — approve several tasks at once; the ids",
    "    come from the batch review card the user ticked.",
    "- review.request_changes {taskId: string, feedback?: string}",
    "- spec.create {problemId: string, title?: string, summary?: string, acceptance?: string[], repositories?: string[]}",
    "    Turn a CONFIRMED problem into a DRAFT specification. Leave fields out to let the",
    "    harness derive them from the confirmed problem; pass acceptance / repositories",
    "    when the user states acceptance criteria or target repositories.",
    "- spec.update {specificationId: string, title?, summary?, requirements?: string[], acceptance?: string[], repositories?: string[]}",
    "    Edit a DRAFT specification before it is planned. READY/PLANNED specifications",
    "    are frozen.",
    "- spec.ready {specificationId: string}",
    "    DRAFT → READY so it can be planned. Used for 「这个规格可以做了」/「开始做吧」",
    "    on a specification; fails when acceptance criteria or targets are missing.",
    "- spec.show {specificationId: string}",
    "- spec.plan {specificationId: string}",
    "- delivery.show {deliveryId: string}",
    "- delivery.release {deliveryId: string}",
    "- preview.build {deliveryId: string} — build the delivery's change in a sandbox and",
    "    collect build evidence (and screenshots when the repository provides a script).",
    "- config.show {key?: string} — show the deployment configuration (admin only).",
    "    Also used for 「谁有权限」「看看白名单」「当前配置」.",
    "- config.set {key: string, value: string} — change one configuration item (admin only).",
    "    e.g. 「并发改成 1」 → config.set AI_MAX_CONCURRENCY. Never use this for secrets.",
    "- config.apply {} — restart the service so saved configuration takes effect (admin only).",
    "    Triggered by 「重启服务」/「让配置生效」.",
    "- access.grant {openId: string, role?: \"guest\"|\"developer\"|\"reviewer\"|\"admin\"}",
    "    Give a colleague access (admin only): 「授权 ou_xxx 为 developer」.",
    "    Use this — NOT config.set — for the allow-list and role map; openId is the",
    "    literal ou_… value, never a name.",
    "- access.revoke {openId: string} — remove someone's access (admin only).",
    "- git.publish {taskId: string} — commit + push the task's branch (reviewer/admin).",
    "    Used for 「推送 task-x」/「重新推送」; approval already publishes automatically.",
    "- conversation.show {limit?: number} — show this chat's transcript (admin only).",
    "    Used for 「聊天记录」/「我们刚才说了什么」.",
    "- repository.list {} — list the registered repositories (any role).",
    "    Used for 「有哪些仓库」/「都注册了什么项目」.",
    "- repository.show {repositoryId: string} — details of one repository.",
    "- task.list {status?: string, repositoryId?: string} — list tasks, optionally",
    "    filtered. Used for 「有哪些任务」/「现在有几个任务」/「有哪些在做的」.",
    "    status must be exactly one of: INBOX, READY, RUNNING, VERIFYING, REVIEW, BLOCKED, DONE.",
    "- run.list {limit?: number, taskId?: string} — recent runs with their outcome.",
    "    Used for 「最近跑了什么」/「为什么失败了」/「跑到哪了」.",
    "- problem.list {status?: string} — current problems and how many questions are open.",
    "    Used for 「有哪些问题」/「还有什么没确认的」.",
    "- delivery.list {} — deliveries and how far each is from release.",
    "",
    "Rules:",
    "- First decide what the user wants:",
    "    kind=query → they only want to know something that already exists.",
    "    kind=act   → an action on something that already exists (run/cancel/approve/",
    "                 publish/config/access).",
    "    kind=work  → they want behaviour or a deliverable changed; this is new",
    "                 development work. Describe-the-problem counts, even without",
    "                 「帮我做」.",
    "    kind=chat  → greeting, question about you, or unrelated.",
    "  A question is query even when it mentions tasks or runs (「为什么 task-3 失败了」",
    "  is query; 「task-3 失败了，重跑一下」 is act). When unsure between query and work,",
    "  prefer work and give a low confidence.",
    "- Ids look like `prob-…`, `task-…`, `run-…`, `spec-…`, `dlv-…`. Never invent one:",
    "  copy the id from the conversation context, and if it is missing return type null.",
    "- Clarification answers need BOTH problemId and clarificationId; take the",
    "  clarificationId from the context lines (they are listed explicitly).",
    "- Answer with JSON only, no prose and no code fences:",
    '  {"kind": "query"|"act"|"work"|"chat", "type": <command type or null>,',
    '   "payload": {...}, "confidence": 0.0-1.0, "reason": "<short, in the user\'s language>"}',
    "- For kind=work the command is problem.create with the user's own wording as",
    "  `statement`. Never invent a task id for work.",
    "- Use type null for greetings, questions about the bot itself, or anything that is not",
    "  one of the commands above. Never guess an id.",
    "- Secret values (app secret, API keys, tokens) never pass through you. The bot",
    "  intercepts the deterministic form 「设置 <KEY> <值>」 before you are called; if a",
    "  credential still appears in a message, answer with type null and say nothing about",
    "  its content.",
  ];
  if (defaultRepositoryId) {
    lines.push(
      "",
      `- Unless the user names another repository, set repositoryId to "${defaultRepositoryId}"`,
      "  on problem.create.",
    );
  }
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
