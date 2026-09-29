import type { Conversation, ConversationMessage } from "../../domain/conversation.js";
import type { ConversationStore } from "../../store/conversationStore.js";

export interface ConversationListOptions {
  channel?: string;
  status?: Conversation["status"];
  /** Keep only the most recently active N conversations. */
  limit?: number;
}

export interface ConversationSummary {
  conversation: Conversation;
  messageCount: number;
  lastMessageAt?: string;
}

/**
 * Chat history is a first-class record: it is what the intent model sees as
 * context, and it is the only place where "who asked for what" is written
 * down. These commands expose it without pretending it is a domain object.
 */
export async function listConversationsCommand(
  store: ConversationStore,
  options: ConversationListOptions = {},
): Promise<ConversationSummary[]> {
  const conversations = await store.listConversations({
    channel: options.channel,
    status: options.status,
  });
  const summaries: ConversationSummary[] = [];
  for (const conversation of conversations) {
    const messages = await store.listMessages(conversation.id);
    summaries.push({
      conversation,
      messageCount: messages.length,
      lastMessageAt: messages[messages.length - 1]?.createdAt,
    });
  }
  summaries.sort((a, b) =>
    (b.lastMessageAt ?? b.conversation.updatedAt).localeCompare(
      a.lastMessageAt ?? a.conversation.updatedAt,
    ),
  );
  return options.limit ? summaries.slice(0, options.limit) : summaries;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: ConversationMessage[];
}

export async function showConversationCommand(
  store: ConversationStore,
  idOrChatId: string,
  options: { limit?: number } = {},
): Promise<ConversationDetail> {
  const conversation = await resolveConversation(store, idOrChatId);
  const messages = await store.listMessages(conversation.id, { limit: options.limit });
  return { conversation, messages };
}

/** Markdown transcript — pipe it to a file, or paste it into an issue. */
export async function exportConversationCommand(
  store: ConversationStore,
  idOrChatId: string,
): Promise<string> {
  const { conversation, messages } = await showConversationCommand(store, idOrChatId);
  const lines = [
    `# Conversation ${conversation.id}`,
    "",
    `- channel: ${conversation.channel}`,
    `- external_chat_id: ${conversation.externalChatId}`,
    conversation.externalThreadId
      ? `- external_thread_id: ${conversation.externalThreadId}`
      : undefined,
    conversation.subjectType
      ? `- subject: ${conversation.subjectType} ${conversation.subjectId}`
      : "- subject: (none)",
    `- messages: ${messages.length}`,
    "",
  ].filter((line): line is string => line !== undefined);

  for (const message of messages) {
    const who = message.direction === "INBOUND" ? `user ${message.senderId}` : "harness";
    lines.push(`## ${message.createdAt} · ${who}`, "", message.content, "");
  }
  return lines.join("\n");
}

/** Accepts the internal id (`conv-…`) or the platform chat id (`oc_…`). */
export async function resolveConversation(
  store: ConversationStore,
  idOrChatId: string,
): Promise<Conversation> {
  const all = await store.listConversations();
  const byId = all.find((conversation) => conversation.id === idOrChatId);
  if (byId) {
    return byId;
  }
  const byChat = all
    .filter((conversation) => conversation.externalChatId === idOrChatId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  if (byChat) {
    return byChat;
  }
  // Fall through to the store so the domain error message is the familiar one.
  return store.findConversation(idOrChatId);
}

export interface PruneOptions {
  /** Delete messages older than this many days. */
  keepDays: number;
  /** Without it the command only reports what would be deleted. */
  execute?: boolean;
  now?: () => Date;
}

export interface PruneResult {
  before: string;
  keepDays: number;
  deleted: number;
  executed: boolean;
}

/**
 * Retention. Deleting the transcript is irreversible and it is the only record
 * of who asked for what, so this defaults to a dry run.
 */
export async function pruneConversationsCommand(
  store: ConversationStore,
  options: PruneOptions,
): Promise<PruneResult> {
  if (!Number.isFinite(options.keepDays) || options.keepDays <= 0) {
    throw new Error("keep-days must be a positive number");
  }
  const now = options.now?.() ?? new Date();
  const before = new Date(now.getTime() - options.keepDays * 24 * 60 * 60 * 1000).toISOString();
  const deleted = await store.deleteMessagesBefore(before, {
    dryRun: !options.execute,
  });
  return { before, keepDays: options.keepDays, deleted, executed: Boolean(options.execute) };
}
