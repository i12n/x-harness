import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

/** One configuration entry as the application layer sees it. */
export interface ConfigEntryView {
  key: string;
  label: string;
  group: string;
  /** null for secrets that are set; undefined when unset. */
  value?: string | null;
  isSecret: boolean;
}

export interface ConfigSetOutcomeView {
  key: string;
  label: string;
  previous: string | null;
  value: string;
  /** Secret values are never echoed back, only their presence. */
  secret?: boolean;
  /** Changing it needs a restart to take effect. */
  restartRequired: boolean;
  /** Wrong value can only be repaired out-of-band (SSH / the env file). */
  risky: boolean;
}

export interface ConfigRenderOptions {
  conversationId?: string;
  /** Where secrets can be entered (the config page URL, when known). */
  secretEntryHint?: string;
}

export function renderConfigMessage(
  entries: ConfigEntryView[],
  options: ConfigRenderOptions = {},
): OutgoingMessage {
  const byGroup = new Map<string, ConfigEntryView[]>();
  for (const entry of entries) {
    const list = byGroup.get(entry.group) ?? [];
    list.push(entry);
    byGroup.set(entry.group, list);
  }

  const blocks: MessageBlock[] = [];
  const unset: string[] = [];
  for (const [group, groupEntries] of byGroup) {
    const lines: string[] = [];
    for (const entry of groupEntries) {
      if (entry.value === undefined) {
        unset.push(entry.key);
        continue;
      }
      const shown = entry.isSecret ? "已设置" : entry.value === "" ? "(空)" : entry.value;
      lines.push(`- \`${entry.key}\` = ${shown}`);
    }
    if (lines.length > 0) {
      blocks.push(markdownBlock(`**${group}**\n${lines.join("\n")}`));
    }
  }

  if (blocks.length === 0) {
    blocks.push(markdownBlock("当前没有任何已设置的配置项。"));
  }
  if (unset.length > 0) {
    blocks.push(
      markdownBlock(`未设置（共 ${unset.length} 项）：${unset.join(", ")}`),
    );
  }
  if (entries.some((entry) => entry.isSecret)) {
    blocks.push(
      markdownBlock(
        options.secretEntryHint ??
          "密钥类配置不会在这里显示，也不接受聊天输入，请在服务器配置页填写。",
      ),
    );
  }

  return {
    conversationId: options.conversationId ?? "config",
    blocks,
  };
}

export function renderConfigSetMessage(
  outcome: ConfigSetOutcomeView,
  options: ConfigRenderOptions = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock(
      `已保存 ${outcome.key}`,
      [
        `${outcome.label}`,
        outcome.secret
          ? `${outcome.previous === null ? "(未设置)" : "(已设置)"} → 已更新（值不回显）`
          : `${outcome.previous === null ? "(未设置)" : outcome.previous} → ${outcome.value}`,
      ].join("\n"),
    ),
  ];
  if (outcome.restartRequired) {
    blocks.push(
      markdownBlock("回复 `重启服务` 使配置生效（当前会话不受影响，进程重启后继续）。"),
    );
  }
  if (outcome.risky) {
    blocks.push(
      markdownBlock(
        "⚠️ 这项写错会让服务连不上/起不来，重启后就只能上服务器用配置页或手工改文件修复。确认无误再重启。",
      ),
    );
  }
  return { conversationId: options.conversationId ?? "config", blocks };
}

export function renderConfigAppliedMessage(
  restarted: boolean,
  options: ConfigRenderOptions = {},
): OutgoingMessage {
  return {
    conversationId: options.conversationId ?? "config",
    text: restarted
      ? "🔄 正在重启服务使配置生效，约 5 秒后我就能用新配置回话了。"
      : "没有待生效的改动。",
  };
}
