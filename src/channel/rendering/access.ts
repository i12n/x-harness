import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

export interface AccessOutcomeView {
  action: "granted" | "revoked";
  openId: string;
  role?: string;
  /** False when the stored state already matched the request. */
  changed?: boolean;
  /** Resulting allow-list, so the operator sees the whole picture. */
  allowed: string[];
}

export function renderAccessMessage(
  outcome: AccessOutcomeView,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const verb = outcome.action === "granted" ? "✅ 已授权" : "🚫 已移除";
  const unchanged = outcome.changed === false;
  const headline = unchanged
    ? outcome.action === "granted"
      ? `ℹ️ 未改动：${outcome.openId} 已经是这个状态`
      : `ℹ️ 未改动：${outcome.openId} 本来就不在允许列表里`
    : `${verb} ${outcome.openId}${outcome.role ? ` · 角色 ${outcome.role}` : ""}`;
  const blocks: MessageBlock[] = [
    sectionBlock(headline, `允许列表现在有 ${outcome.allowed.length} 人`),
  ];
  blocks.push(
    markdownBlock(
      outcome.allowed.length > 0
        ? `**允许列表**\n${outcome.allowed.map((id) => `- ${id}`).join("\n")}`
        : "**允许列表为空**（所有人都无法使用；请至少保留一个 admin）",
    ),
  );
  if (!unchanged) {
    blocks.push(
      markdownBlock("回复 `重启服务` 使改动生效（当前登录状态在重启后依然有效）。"),
    );
  }
  return { conversationId: options.conversationId ?? "access", blocks };
}
