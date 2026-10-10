import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";
import { subjectTypeLabel } from "./copy.js";

export interface TranscriptEntry {
  at: string;
  speaker: "user" | "harness";
  /** Channel-scoped sender id (Feishu open_id) for user turns. */
  senderId?: string;
  text: string;
}

export interface TranscriptRenderOptions {
  conversationId?: string;
  subject?: { type: string; id: string };
  /** Total character budget for the transcript body. */
  budget?: number;
  perMessageLimit?: number;
  /** Count of messages left out because of the budget/limit. */
  omitted?: number;
}

const DEFAULT_BUDGET = 3_000;
const DEFAULT_PER_MESSAGE = 400;

/**
 * Chat transcript → OutgoingMessage. Chat clients cap message size, so this
 * renders the newest turns and says plainly what was left out; the complete
 * transcript stays available through `ai conversation export`.
 */
export function renderTranscriptMessage(
  entries: TranscriptEntry[],
  options: TranscriptRenderOptions = {},
): OutgoingMessage {
  const budget = options.budget ?? DEFAULT_BUDGET;
  const perMessage = options.perMessageLimit ?? DEFAULT_PER_MESSAGE;
  const header = `${entries.length} 条已显示` +
    (options.omitted ? ` · 另有 ${options.omitted} 条更早的消息未显示` : "");

  const blocks: MessageBlock[] = [
    sectionBlock(
      "聊天记录",
      [
        header,
        options.subject
          ? `当前主题：${subjectTypeLabel(options.subject.type)} ${options.subject.id}`
          : "当前主题：（无）",
      ].join("\n"),
    ),
  ];

  const lines: string[] = [];
  let used = 0;
  for (const entry of [...entries].reverse()) {
    const who =
      entry.speaker === "user" ? `用户 ${entry.senderId ?? ""}`.trim() : "助手";
    const text = truncate(entry.text.replace(/\n{2,}/g, "\n"), perMessage);
    const line = `**${formatTime(entry.at)} · ${who}**\n${text}`;
    if (used + line.length > budget) {
      break;
    }
    used += line.length;
    lines.unshift(line);
  }

  if (lines.length === 0) {
    blocks.push(markdownBlock("(这个会话还没有消息)"));
  } else {
    blocks.push(markdownBlock(lines.join("\n\n")));
  }
  blocks.push(
    markdownBlock(
      "完整记录：`ai conversation show <会话id>` / `ai conversation export <会话id>`",
    ),
  );

  return { conversationId: options.conversationId ?? "history", blocks };
}

function formatTime(value: string): string {
  return value.length >= 16 ? value.slice(0, 16).replace("T", " ") : value;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
