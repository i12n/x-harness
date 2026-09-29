import type { OutgoingMessage } from "../channel/message.js";
import { parseFeishuEvent } from "../channel/feishu/events.js";
import { prepareCommand } from "../command/engine.js";
import type { CommandDispatcher } from "../command/dispatcher.js";
import type { CommandResult, IntentEngine, IntentInput, Role } from "../command/types.js";
import type { ConversationService } from "../conversation/service.js";
import type { Problem } from "../domain/problem.js";
import { HarnessError } from "../errors.js";
import { resolveRoles, type AccessConfig } from "./config.js";
import type { ChatTarget, RunChatNotifier } from "./notifications.js";
import { renderCommandResult, renderNotAllowedMessage } from "./reply.js";
import type { SpecificationBootstrap } from "./specificationBootstrap.js";
import { decideFromIntentResult, type IntentTriage, type TriageDecision } from "./intentTriage.js";
import {
  renderChatFallbackMessage,
  renderWorkConfirmationMessage,
  renderWorkConfirmedMessage,
  renderWorkDeclinedMessage,
} from "../channel/rendering/triage.js";

export interface ChatSessionDeps {
  conversations: ConversationService;
  intent: IntentEngine;
  /** Optional triage: classify (query/act/work/chat) before dispatching. */
  triage?: IntentTriage;
  dispatcher: CommandDispatcher;
  access: AccessConfig;
  /**
  /** Transport adapter: also records the outgoing conversation message. */
  send: (target: ChatTarget, message: OutgoingMessage) => Promise<void>;
  /**
   * The bot's own open_id. Group messages that do not mention it are ignored,
   * so the bot never barges into a conversation it was not addressed in.
   * When unknown, any mention counts as addressing the bot.
   */
  botOpenId?: string;
  /** Where replies land: a topic thread on the trigger message, or the chat. */
  threadReplies?: "always" | "group" | "never";
  notifier?: RunChatNotifier;
  specificationBootstrap?: SpecificationBootstrap;
  /** Injected: restarts the process so saved configuration takes effect. */
  restartService?: () => Promise<void>;
  log?: (message: string) => void;
  /** Audit hook: every classification is recorded (docs/intent-triage.md §5.5). */
  recordEvent?: (type: string, payload: unknown) => Promise<void>;
}

/**
 * One inbound chat event → at most one command → one rendered reply.
 *
 * This lives in the deployment layer on purpose: it is the only place that
 * knows about Feishu envelopes, authorization config and the chat target, while
 * the command layer keeps receiving structured, already-authenticated commands.
 */
export class ChatSession {
  /**
   * Requests awaiting a 开工 / 只是问问 answer, per conversation. Kept in memory
   * on purpose: a restart costs one rephrasing, whereas a persisted
   * half-decided intent would outlive the conversation it belonged to.
   */
  private readonly pendingWork = new Map<string, string>();

  constructor(private readonly deps: ChatSessionDeps) {}

  /** Handles an `im.message.receive_v1` payload (long connection or webhook). */
  async handleEvent(envelope: unknown): Promise<void> {
    const record = asRecord(envelope);
    if (!record) {
      this.log("ignoring event: payload is not an object");
      return;
    }
    if (isBotSender(record)) {
      return;
    }

    const parsed = parseFeishuEvent(record);
    if (parsed.kind === "ignored") {
      this.log(`ignoring event: ${parsed.reason}`);
      return;
    }
    const message = parsed.message;
    const chatId =
      typeof message.metadata?.chatId === "string"
        ? message.metadata.chatId
        : message.conversationId;
    const threadId =
      typeof message.metadata?.threadId === "string" ? message.metadata.threadId : undefined;

    // Group etiquette: only answer when addressed. Private chats have no
    // mention, so they are never filtered.
    const chatType =
      typeof message.metadata?.chatType === "string" ? message.metadata.chatType : "";
    const isGroup = chatType !== "" && chatType !== "p2p";
    if (isGroup && !isBotMentioned(message.metadata?.mentions, this.deps.botOpenId)) {
      this.log(
        `ignoring group message ${message.messageId}: the bot was not mentioned`,
      );
      return;
    }
    // Answer inside a topic thread on the triggering message (default for both
    // groups and private chats), so the main flow stays readable.
    const threadMode = this.deps.threadReplies ?? "always";
    const inThread =
      threadMode === "always" || (threadMode === "group" && isGroup);
    const routing: ReplyRouting | undefined = inThread
      ? { replyToMessageId: message.messageId, replyInThread: true }
      : undefined;

    // Deterministic configuration router. It runs BEFORE the language model so
    // a value typed here can never be sent to a model provider, and the stored
    // conversation text is redacted for anything that looks like a credential.
    const direct = parseDirectSet(message.text);
    const secretLike = direct ? looksLikeSecretKey(direct.key) : looksLikeSecretAssignment(message.text);
    const storedText = direct
      ? secretLike
        ? `设置 ${direct.key} [已隐去]`
        : message.text
      : secretLike
        ? "[疑似密钥内容，已隐去]"
        : message.text;

    const outcome = await this.deps.conversations.handleIncoming({
      channel: message.channel,
      externalChatId: chatId,
      externalThreadId: threadId,
      messageId: message.messageId,
      senderId: message.senderId,
      text: storedText,
      timestamp: message.timestamp,
      metadata: message.metadata,
    });
    if (outcome.duplicate) {
      this.log(`duplicate message ${message.messageId} ignored`);
      return;
    }

    const target: ChatTarget = {
      conversationId: outcome.conversation.id,
      receiveId: chatId,
      receiveIdType: "chat_id",
    };

    // A message inside a Feishu topic is its own conversation (parallel
    // discussions stay isolated), but the first thread message must inherit
    // the subject the chat had, otherwise "确认"/"运行它" lose their referent.
    if (threadId && !outcome.conversation.subjectType) {
      await this.inheritSubject(outcome.conversation.id, message.channel, chatId);
    }

    const roles = resolveRoles(this.deps.access, message.senderId);
    if (roles.length === 0) {
      await this.reply(
        target,
        renderNotAllowedMessage(target.conversationId, message.senderId),
        routing,
      );
      return;
    }

    const input: IntentInput = {
      channel: message.channel,
      conversationId: outcome.conversation.id,
      messageId: message.messageId,
      senderId: message.senderId,
      text: message.text,
    };

    // A credential typed in chat is never handed to the model.
    if (direct || secretLike) {
      const result = await this.dispatch(
        input,
        roles,
        direct
          ? { type: "config.setDirect", payload: { key: direct.key, value: direct.value } }
          : undefined,
      );
      const rendered =
        result === undefined
          ? {
              conversationId: target.conversationId,
              blocks: [
                {
                  type: "markdown" as const,
                  text:
                    "🔑 看起来你想设置密钥/令牌。请用这个格式（不经过模型、不入库）：\n" +
                    "`设置 <KEY> <值>`　例如：`设置 FEISHU_APP_SECRET hydU…`\n" +
                    "如果你不是在设置密钥，请换个说法重发。",
                },
              ],
            }
          : renderCommandResult(result, target.conversationId);
      await this.reply(target, rendered, routing);
      if (result && result.status === "succeeded") {
        await this.afterSuccess(target, result.type, result.data);
      }
      return;
    }

    // A pending "开工 / 只是问问" answer is resolved deterministically, before
    // the model is consulted about anything.
    const pending = this.pendingWork.get(outcome.conversation.id);
    if (pending) {
      const answer = message.text.trim();
      if (isConfirmWork(answer)) {
        this.pendingWork.delete(outcome.conversation.id);
        await this.reply(target, renderWorkConfirmedMessage(pending), routing);
        const result = await this.dispatch(input, roles, {
          type: "problem.create",
          payload: { title: firstLine(pending), statement: pending },
        });
        if (result) {
          await this.reply(
            target,
            renderCommandResult(result, target.conversationId),
            routing,
          );
          if (result.status === "succeeded") {
            await this.afterSuccess(target, result.type, result.data);
          }
        }
        return;
      }
      if (isDeclineWork(answer)) {
        this.pendingWork.delete(outcome.conversation.id);
        await this.reply(target, renderWorkDeclinedMessage(), routing);
        return;
      }
    }

    let decision: TriageDecision;
    try {
      decision = this.deps.triage
        ? await this.deps.triage.classify(input)
        : decideFromIntentResult(await this.deps.intent.parse(input));
    } catch (error) {
      await this.reply(
        target,
        {
          conversationId: target.conversationId,
          text: `⚠️ 无法解析这条消息：${describeError(error)}`,
        },
        routing,
      );
      return;
    }
    await this.audit(decision, message.text);

    if (decision.needsConfirmation) {
      this.rememberPendingWork(outcome.conversation.id, message.text);
      await this.reply(
        target,
        renderWorkConfirmationMessage(message.text, {
          conversationId: target.conversationId,
          reason: decision.reason,
        }),
        routing,
      );
      return;
    }
    if (decision.kind === "chat" || !decision.command) {
      await this.reply(
        target,
        renderChatFallbackMessage({ conversationId: target.conversationId }),
        routing,
      );
      return;
    }

    const result = await this.deps.dispatcher.dispatch(
      prepareCommand(input, decision.command),
      { channel: message.channel, userId: message.senderId, roles },
    );
    const rendered = renderCommandResult(result, target.conversationId);
    await this.reply(target, rendered, routing);

    if (result.status === "succeeded") {
      await this.afterSuccess(target, result.type, result.data);
    }
  }

  /** One structured command → dispatcher (validation, authz, audit, replay). */
  private async dispatch(
    input: IntentInput,
    roles: Role[],
    command: unknown,
  ): Promise<CommandResult | undefined> {
    if (!command) {
      return undefined;
    }
    return this.deps.dispatcher.dispatch(prepareCommand(input, command), {
      channel: input.channel,
      userId: input.senderId,
      roles,
    });
  }

  /** Side effects that only make sense for a chat-driven deployment. */
  private async afterSuccess(
    target: ChatTarget,
    type: string,
    data: unknown,
  ): Promise<void> {
    const payload = asRecord(data);
    if (type === "config.apply") {
      const pending = typeof payload?.pending === "number" ? payload.pending : 0;
      if (pending > 0 && this.deps.restartService) {
        // The reply has already been sent; restarting now only interrupts us.
        await this.deps.restartService().catch((error: unknown) => {
          this.log(`restart failed: ${describeError(error)}`);
        });
      }
      return;
    }
    if (type === "task.run") {
      const run = asRecord(payload?.run);
      const runId = typeof run?.id === "string" ? run.id : undefined;
      if (runId && this.deps.notifier) {
        await this.deps.notifier.bind(runId, target);
      }
      return;
    }

    const problem = payload?.problem as Problem | undefined;
    if (
      this.deps.specificationBootstrap &&
      problem &&
      problem.status === "CONFIRMED" &&
      (type === "problem.create" || type === "problem.confirm" || type === "problem.clarification.answer")
    ) {
      await this.bootstrap(target, problem.id);
    }
  }

  private async inheritSubject(
    conversationId: string,
    channel: string,
    chatId: string,
  ): Promise<void> {
    try {
      const parent = await this.deps.conversations.findByExternal({
        channel,
        externalChatId: chatId,
      });
      if (parent && parent.id !== conversationId && parent.subjectType && parent.subjectId) {
        await this.deps.conversations.attachSubject(conversationId, {
          type: parent.subjectType,
          id: parent.subjectId,
        });
      }
    } catch (error) {
      this.log(`could not inherit the conversation subject: ${describeError(error)}`);
    }
  }

  private async bootstrap(target: ChatTarget, problemId: string): Promise<void> {
    try {
      const outcome = await this.deps.specificationBootstrap!.bootstrap(problemId);
      if (!outcome) {
        return;
      }
      await this.reply(target, {
        conversationId: target.conversationId,
        blocks: [
          { type: "markdown", text: `**规格已就绪** ${outcome.specification.id}` },
          {
            type: "markdown",
            text: outcome.specification.acceptance
              .map((criterion) => `- ${criterion}`)
              .join("\n") || "- (no acceptance criteria)",
          },
          {
            type: "markdown",
            text:
              outcome.tasks.length > 0
                ? `**已拆解 ${outcome.tasks.length} 个任务**\n${outcome.tasks
                    .map((task) => `- ${task.id} · ${task.title}`)
                    .join("\n")}\n\n回复 \`运行 ${outcome.tasks[0]!.id}\` 开始开发。`
                : "**没有拆解出任务**",
          },
          ...(outcome.unknownTargets.length > 0
            ? [
                {
                  type: "markdown" as const,
                  text: `⚠️ 未注册的仓库被忽略：${outcome.unknownTargets.join(", ")}`,
                },
              ]
            : []),
        ],
      });
    } catch (error) {
      await this.reply(target, {
        conversationId: target.conversationId,
        text:
          `⚠️ 问题已确认，但无法生成规格：${describeError(error)}\n` +
          "（通常是因为没有可用的目标仓库；请用 `AI_DEFAULT_REPOSITORY_ID` 或先在 CLI 注册仓库）",
      });
    }
  }

  private async reply(
    target: ChatTarget,
    message: OutgoingMessage,
    routing?: ReplyRouting,
  ): Promise<void> {
    try {
      await this.deps.send(
        target,
        routing
          ? { ...message, metadata: { ...message.metadata, ...routing } }
          : message,
      );
    } catch (error) {
      this.log(`failed to send reply: ${describeError(error)}`);
      return;
    }
  }

  private rememberPendingWork(conversationId: string, text: string): void {
    const maxPending = 100;
    if (this.pendingWork.size >= maxPending) {
      const oldest = this.pendingWork.keys().next().value;
      if (oldest !== undefined) {
        this.pendingWork.delete(oldest);
      }
    }
    this.pendingWork.set(conversationId, text);
  }

  private async audit(decision: TriageDecision, text: string): Promise<void> {
    if (!this.deps.recordEvent) {
      return;
    }
    try {
      await this.deps.recordEvent("intent.classified", {
        kind: decision.kind,
        stage: decision.stage,
        confidence: decision.confidence,
        command: commandTypeName(decision.command),
        needsConfirmation: decision.needsConfirmation,
        reason: decision.reason,
        excerpt: text.slice(0, 120),
      });
    } catch (error) {
      this.log(`could not record the classification: ${describeError(error)}`);
    }
  }

  private log(message: string): void {
    this.deps.log?.(message);
  }
}

interface ReplyRouting {
  replyToMessageId: string;
  replyInThread: boolean;
}

interface MentionLike {
  openId?: string;
  name?: string;
}

function parseMentions(raw: unknown): MentionLike[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is MentionLike => !!entry && typeof entry === "object",
  );
}

export function isBotMentioned(raw: unknown, botOpenId: string | undefined): boolean {
  const mentions = parseMentions(raw);
  if (mentions.length === 0) {
    return false;
  }
  if (!botOpenId) {
    // Without the bot's own id, any mention is treated as addressing it —
    // permissive, but it beats silently ignoring the operator.
    return true;
  }
  return mentions.some((mention) => mention.openId === botOpenId);
}

/** The two fixed answers to the work-confirmation card. */
export function isConfirmWork(text: string): boolean {
  return /^(开工|开始做|做吧|要|是|确认开工|go|yes)$/i.test(text.trim());
}

export function isDeclineWork(text: string): boolean {
  return /^(只是问问|只是问一下|不用了|算了|先不用|no|nope)$/i.test(text.trim());
}

/** First non-empty line, used as the problem title when the user confirms. */
function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((entry) => entry.trim());
  return (line ?? text).trim().slice(0, 80);
}

function commandTypeName(command: unknown): string | undefined {
  if (!command || typeof command !== "object" || Array.isArray(command)) {
    return undefined;
  }
  const type = (command as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

function isBotSender(envelope: Record<string, unknown>): boolean {
  const sender = asRecord(asRecord(envelope.event)?.sender);
  const senderType = typeof sender?.sender_type === "string" ? sender.sender_type : "";
  return senderType === "app" || senderType === "bot";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function describeError(error: unknown): string {
  if (error instanceof HarnessError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * `设置 <KEY> <值>` / `设定 <KEY>=<值>` / `set <KEY> <值>`.
 *
 * Deliberately strict: configuration keys are SCREAMING_SNAKE identifiers, so
 * ordinary sentences never accidentally match and reach the write path.
 */
export function parseDirectSet(text: string): { key: string; value: string } | undefined {
  const match = /^\s*(?:设置|设定|set)\s+([A-Z][A-Z0-9_]{2,})\s*(?:=|:|\s)\s*([\s\S]+?)\s*$/i.exec(
    text,
  );
  if (!match) {
    return undefined;
  }
  const key = match[1]!.toUpperCase();
  const value = match[2]!;
  return value ? { key, value } : undefined;
}

/** Keys whose value is a credential and must never be echoed or stored. */
export function looksLikeSecretKey(key: string): boolean {
  return /(SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|_KEY$)/i.test(key);
}

/**
 * Heuristic for "the user is pasting a credential in prose" — used to keep the
 * text away from the model. A false positive only costs a rephrasing.
 */
export function looksLikeSecretAssignment(text: string): boolean {
  if (/\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|API_?KEY)[A-Z0-9_]*\b/.test(text)) {
    return true;
  }
  return /(密钥|密码|api[\s_-]?key|secret|token)[^。\n]{0,10}(?:设|改|换|更新|为|成|是|[:=])\s*\S/i.test(
    text,
  );
}
