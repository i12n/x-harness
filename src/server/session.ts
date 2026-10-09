import {
  CARD_CHOICE_TOGGLE,
  type MessageChoice,
  type OutgoingMessage,
} from "../channel/message.js";
import { parseFeishuEvent } from "../channel/feishu/events.js";
import { prepareCommand } from "../command/engine.js";
import type { CommandDispatcher } from "../command/dispatcher.js";
import type {
  CommandResult,
  IntentAction,
  IntentEngine,
  IntentInput,
  Role,
} from "../command/types.js";
import type { IncomingMessage } from "../channel/message.js";
import { commandsForRequirementAction } from "../requirement/application/actions.js";
import type { RequirementResolver } from "../requirement/application/resolver.js";
import { renderRequirementCard } from "../channel/rendering/requirement.js";
import type { ConversationService } from "../conversation/service.js";
import type { Problem } from "../domain/problem.js";
import type { Task } from "../domain/task.js";
import { HarnessError } from "../errors.js";
import { resolveRoles, type AccessConfig } from "./config.js";
import type { ChatTarget, RunChatNotifier } from "./notifications.js";
import type { CardRegistry } from "./cardRegistry.js";
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
  /** TASK-1244: resolves "what is this conversation about" for user actions. */
  requirements?: RequirementResolver;
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
  /** Interactive-card state for multi-select toggles (TASK-1216). */
  cards?: CardRegistry;
  specificationBootstrap?: SpecificationBootstrap;
  /** Injected: restarts the process so saved configuration takes effect. */
  restartService?: () => Promise<void>;
  log?: (message: string) => void;
  /** Audit hook: every classification is recorded (docs/intent-triage.md §5.5). */
  recordEvent?: (type: string, payload: unknown) => Promise<void>;
}

/** A normalised `card.action.trigger` click (TASK-1216). */
export interface CardActionInput {
  messageId: string;
  chatId: string;
  operatorOpenId: string;
  actionId: string;
  value?: string;
}

/**
 * What a click produces. `immediate` is returned to Feishu as the callback
 * response (it must be a valid card, otherwise the client shows an error);
 * `deferred` is work that must not delay that response past Feishu's ~3s
 * callback budget — the answer triggers a model call, so it always runs after.
 */
export interface CardActionOutcome {
  immediate: OutgoingMessage;
  deferred?: () => Promise<void>;
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
    // TASK-1243: answer in the requirement's own topic — anchored to the message
    // that started it, falling back to this one. The chat's main flow never gets
    // an answer (`never` is an explicit operator override).
    const threadMode = this.deps.threadReplies ?? "always";
    const anchor = outcome.conversation.anchorMessageId ?? message.messageId;
    let routing: ReplyRouting | undefined =
      threadMode === "never" || (threadMode === "group" && !isGroup)
        ? undefined
        : { replyToMessageId: anchor, replyInThread: true };

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
      // TASK-1244: user-level actions (show/reject/deploy/publish/rerun/create)
      // have no command — they are resolved against the requirement this
      // conversation is about.
      if (decision.action) {
        const handled = await this.handleRequirementAction(
          target,
          message,
          input,
          roles,
          decision.action,
          routing,
        );
        if (handled) {
          return;
        }
      }
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
    if (result.status === "succeeded" && result.type === "problem.create") {
      // TASK-1243: a new requirement gets its own topic — anchor it to the
      // message that asked for it, so two requirements never share one thread.
      try {
        await this.deps.conversations.setAnchor(target.conversationId, message.messageId);
        routing = { replyToMessageId: message.messageId, replyInThread: true };
      } catch (error) {
        this.log(`could not re-anchor the conversation: ${describeError(error)}`);
      }
    }
    const rendered = renderCommandResult(result, target.conversationId);
    await this.reply(target, rendered, routing);

    if (result.status === "succeeded") {
      await this.afterSuccess(target, result.type, result.data);
    }
  }

  /**
   * Handles a card click (TASK-1216). A toggle is answered synchronously —
   * it only re-renders the card, so it fits inside Feishu's callback budget.
   * A submit is acknowledged immediately and executed in the background,
   * because the work behind it (answering a clarification) calls a model.
   */
  async handleCardAction(action: CardActionInput): Promise<CardActionOutcome> {
    const target = await this.cardTarget(action.chatId);
    const roles = resolveRoles(this.deps.access, action.operatorOpenId);
    if (roles.length === 0) {
      return {
        immediate: renderNotAllowedMessage(target.conversationId, action.operatorOpenId),
      };
    }
    if (action.actionId === CARD_CHOICE_TOGGLE) {
      return { immediate: this.toggleChoice(action, target) };
    }
    return this.submitCardCommand(action, target, roles);
  }

  private async cardTarget(chatId: string): Promise<ChatTarget> {
    let conversationId = chatId;
    try {
      const conversation = await this.deps.conversations.findByExternal({
        channel: "feishu",
        externalChatId: chatId,
      });
      if (conversation) {
        conversationId = conversation.id;
      }
    } catch (error) {
      this.log(`could not resolve the conversation for a card action: ${describeError(error)}`);
    }
    return { conversationId, receiveId: chatId, receiveIdType: "chat_id" };
  }

  /** Toggle one option and re-render the card so the selection stays visible. */
  private toggleChoice(action: CardActionInput, target: ChatTarget): OutgoingMessage {
    const cards = this.deps.cards;
    const value = parseJsonRecord(action.value);
    const groupId = asString(value?.groupId);
    const optionId = asString(value?.optionId);
    const current = cards?.selectedMessage(action.messageId);
    if (!cards || !groupId || !optionId || !current) {
      return expiredCard(target.conversationId);
    }
    const choice = findChoice(current, groupId);
    if (!choice) {
      return expiredCard(target.conversationId);
    }
    cards.toggle(action.messageId, groupId, optionId, choice.multi);
    return cards.selectedMessage(action.messageId) ?? current;
  }

  /**
   * A submit carries the whole selection in one callback; we acknowledge it and
   * run the command afterwards so the response is never late.
   */
  private submitCardCommand(
    action: CardActionInput,
    target: ChatTarget,
    roles: Role[],
  ): CardActionOutcome {
    const cards = this.deps.cards;
    const payload: Record<string, unknown> = { ...(parseJsonRecord(action.value) ?? {}) };
    const groupId = asString(payload.groupId);
    delete payload.groupId;

    let labels: string[] = [];
    if (groupId) {
      const choice = cards?.selectedMessage(action.messageId);
      const block = choice ? findChoice(choice, groupId) : undefined;
      const selected = cards?.selection(action.messageId, groupId) ?? [];
      if (!block) {
        return { immediate: expiredCard(target.conversationId) };
      }
      if (selected.length === 0) {
        return {
          immediate: {
            conversationId: target.conversationId,
            text: "⚠️ 请先勾选至少一个选项，再点提交。",
          },
        };
      }
      payload[block.submit.selectionField ?? "optionIds"] = selected;
      labels = selected.map(
        (id) => block.options.find((option) => option.id === id)?.label ?? id,
      );
    }

    const input: IntentInput = {
      channel: "feishu",
      conversationId: target.conversationId,
      messageId: action.messageId,
      senderId: action.operatorOpenId,
      text: "",
    };
    const command = { type: action.actionId, payload };
    return {
      immediate: {
        conversationId: target.conversationId,
        text:
          labels.length > 0
            ? `⏳ 已提交：${labels.join("、")}（正在处理…）`
            : "⏳ 已收到，正在处理…",
      },
      deferred: async () => {
        const result = await this.deps.dispatcher.dispatch(
          prepareCommand(input, command),
          { channel: "feishu", userId: action.operatorOpenId, roles },
        );
        await this.reply(target, renderCommandResult(result, target.conversationId));
        if (result.status === "succeeded") {
          await this.afterSuccess(target, result.type, result.data);
        }
      },
    };
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
    // TASK-1231: remember where the delivery was started, so its deployment
    // messages come back to THIS conversation (one delivery, one thread)
    // instead of drifting into the default chat.
    if (type === "deploy.test") {
      const deliveryId =
        typeof payload?.deliveryId === "string" ? payload.deliveryId : undefined;
      if (deliveryId && this.deps.recordEvent) {
        await this.deps.recordEvent("deploy.chat_target", { deliveryId, ...target });
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
            text: describePlannedTasks(outcome.tasks),
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
          specificationFailureHint(error),
      });
    }
  }

  /**
   * TASK-1244: carry out a user-level action against the requirement this
   * conversation is about. `chat` returns false so the caller can answer with
   * the help card; everything else is handled here (and answered) — the user
   * never has to know which internal object an action maps to.
   */
  private async handleRequirementAction(
    target: ChatTarget,
    message: IncomingMessage,
    input: IntentInput,
    roles: Role[],
    action: IntentAction,
    routing: ReplyRouting | undefined,
  ): Promise<boolean> {
    if (action.type === "chat" || !this.deps.requirements) {
      return false;
    }
    // Pasted ids are ignored on purpose; say so once instead of failing.
    const hint = pastedIdHint(message.text);
    // TASK-1250: a new requirement is created without resolving anything — that
    // ordering bug is why a fresh chat got "I don't know which one you mean".
    const view = await this.deps.requirements
      .resolve(target.conversationId)
      .catch(() => undefined);
    if (action.type === "clarify") {
      const question =
        asTrimmedString(action.payload?.question) ?? "你是想做什么？";
      const options = Array.isArray(action.payload?.options)
        ? action.payload.options.filter(
            (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
          )
        : [];
      await this.reply(
        target,
        {
          conversationId: target.conversationId,
          text: [hint, question, options.length > 0 ? `[${options.join("] [")}]` : undefined]
            .filter(Boolean)
            .join("\n"),
        },
        routing,
      );
      return true;
    }

    const outcome = commandsForRequirementAction(action, view);
    if (outcome.ask) {
      await this.reply(
        target,
        {
          conversationId: target.conversationId,
          // TASK-1249: name the requirement the bot acted on. When a chat has
          // more than one similar requirement, this is what shows the operator
          // that the answer belongs to a different one than they meant.
          text: [hint, view ? `「${view.title}」：${outcome.ask}` : outcome.ask]
            .filter(Boolean)
            .join("\n"),
        },
        routing,
      );
      return true;
    }
    // TASK-1252: "开始做吧 / 重试生成规格" on a requirement that stopped before
    // planning — advance it (derive the specification, then plan).
    if (outcome.advance) {
      if (view?.problemId && this.deps.specificationBootstrap) {
        await this.bootstrap(target, view.problemId);
        return true;
      }
      await this.reply(
        target,
        {
          conversationId: target.conversationId,
          text: [hint, "这项需求还没到能开工的阶段——先确认要做什么。"].filter(Boolean).join("\n"),
        },
        routing,
      );
      return true;
    }
    if (outcome.showCard && view) {
      const card = renderRequirementCard(view, {
        conversationId: target.conversationId,
      });
      await this.reply(
        target,
        hint ? { ...card, text: `${hint}\n${card.text ?? ""}` } : card,
        routing,
      );
      return true;
    }
    if (outcome.commands.length === 0) {
      return false;
    }

    let first = true;
    for (const command of outcome.commands) {
      const result = await this.deps.dispatcher.dispatch(
        prepareCommand(input, command),
        { channel: message.channel, userId: message.senderId, roles },
      );
      const rendered = renderCommandResult(result, target.conversationId);
      await this.reply(
        target,
        hint && first ? { ...rendered, text: `${hint}\n${rendered.text ?? ""}` } : rendered,
        routing,
      );
      first = false;
      if (result.status === "succeeded") {
        await this.afterSuccess(target, result.type, result.data);
      }
    }
    return true;
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

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function findChoice(message: OutgoingMessage, groupId: string): MessageChoice | undefined {
  return (message.blocks ?? []).find(
    (block): block is MessageChoice => block.type === "choice" && block.id === groupId,
  );
}

/**
 * Shown when a card click arrives for a card we no longer know about (process
 * restarted, or the card predates this deploy). Returning a real card keeps
 * the client from showing the opaque 200672 callback error.
 */
function expiredCard(conversationId: string): OutgoingMessage {
  return {
    conversationId,
    text: "⚠️ 这张卡片已失效，请重新发送指令，或重新打开对应的问题/评审。",
  };
}

/**
 * TASK-1219: planning now ends with tasks the Scheduler already picked up, so
 * the reply reports what happens by itself and only asks for attention on the
 * tasks intake refused.
 */
export function describePlannedTasks(tasks: Task[]): string {
  if (tasks.length === 0) {
    return "**没有拆解出任务**";
  }
  const lines = tasks.map((task) => `- ${task.id} · ${task.title} · ${task.status}`);
  const blocked = tasks.filter((task) => task.status === "BLOCKED");
  const pending = tasks.filter((task) => task.status === "INBOX");
  let tail: string;
  if (blocked.length > 0) {
    tail =
      `\n\n⚠️ ${blocked.length} 个任务没通过 intake，需要你处理：` +
      `${blocked.map((task) => task.id).join("、")}\n（用 \`查看 ${blocked[0]!.id}\` 看原因）`;
  } else if (pending.length > 0) {
    // AI_AUTO_START=off: the old manual mode.
    tail = `\n\n回复 \`运行 ${pending[0]!.id}\` 开始开发。`;
  } else {
    tail = "\n\n已自动排队开始，不需要逐条确认。要干预可以用 `停止 run-x` 或 `打回 task-x`。";
  }
  return `**已拆解 ${tasks.length} 个工作项**\n${lines.join("\n")}${tail}`;
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
 * TASK-1244: the user does not need ids any more. If one is pasted anyway, the
 * action still runs against the current requirement — and one short line says
 * so, instead of silently ignoring what they typed.
 */
function pastedIdHint(text: string): string | undefined {
  return /\b(?:prob|spec|task|run|dlv)-[A-Za-z0-9_-]{4,}/.test(text)
    ? "（编号我忽略了——直接说就行，我知道你说的是哪件事）"
    : undefined;
}

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * The ⚠️ that follows a failed specification derivation must name the real
 * cause. A model/transport failure (empty answer, bad JSON, HTTP error) has
 * nothing to do with the repository list, and the old copy sent the operator
 * looking for a repository that was already registered.
 */
function specificationFailureHint(error: unknown): string {
  if (/chat completion|model output|no JSON/i.test(describeError(error))) {
    return (
      "（这是模型调用失败，不是仓库问题：可直接重试；" +
      "若反复出现，检查 AI_LLM_BASE_URL / AI_LLM_MODEL / AI_LLM_API_KEY，" +
      "以及该模型是否把输出额度耗在推理上）"
    );
  }
  return "（通常是因为没有可用的目标仓库；请在对话里点名要改的仓库，或先用 CLI 注册仓库）";
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
