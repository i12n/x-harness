import type { OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

/**
 * Shown when triage cannot tell "do this" from "just asking".
 *
 * The two replies are deliberate fixed phrases: they are recognised
 * deterministically on the next message, so answering costs no model call and
 * the pending request is never re-interpreted.
 */
export function renderWorkConfirmationMessage(
  originalText: string,
  options: { conversationId?: string; reason?: string } = {},
): OutgoingMessage {
  return {
    conversationId: options.conversationId ?? "triage",
    blocks: [
      sectionBlock("这是要我开工，还是只想了解情况？", options.reason ?? ""),
      markdownBlock(`我理解到的是：\n> ${truncate(originalText, 200)}`),
      markdownBlock(
        [
          "回复 **`开工`** → 我按上面这句建问题、开始澄清",
          "回复 **`只是问问`** → 我不动手，你可以换个问法",
          "",
          "（也可以直接补全需求，例如：`把首页的空状态加上`）",
        ].join("\n"),
      ),
    ],
  };
}

/** Shown for messages triage classified as neither a question nor work. */
export function renderChatFallbackMessage(options: { conversationId?: string } = {}): OutgoingMessage {
  return {
    conversationId: options.conversationId ?? "triage",
    blocks: [
      markdownBlock(
        [
          "我没理解成可执行的动作。你可以：",
          "- 描述要开发/修复的东西，例如 `首页在没有数据时没有任何提示`",
          "- 问状态：`有哪些仓库` / `现在有几个任务` / `最近跑了什么` / `聊天记录`",
          "- 对已有工作下指令：`运行 task-x` / `通过 task-x` / `取消 run-x`",
          "",
          "**如果刚才那句其实是要我做的事，请直接说要改什么**，我会建问题并开始澄清。",
        ].join("\n"),
      ),
    ],
  };
}

export function renderWorkConfirmedMessage(
  statement: string,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  return {
    conversationId: options.conversationId ?? "triage",
    text: `好，按这句开工：${truncate(statement, 120)}`,
  };
}

export function renderWorkDeclinedMessage(options: { conversationId?: string } = {}): OutgoingMessage {
  return {
    conversationId: options.conversationId ?? "triage",
    text: "好，那我不动手。需要时再叫我。",
  };
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
