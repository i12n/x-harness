import type { MessageBlock, OutgoingMessage } from "../message.js";
import { markdownBlock, sectionBlock } from "./common.js";

/** Repository facts a renderer may display (plain data, no store access). */
export interface RepositoryView {
  id: string;
  name: string;
  url: string;
  defaultBranch: string;
  localPath: string;
  verificationCommands: string[];
  /** Whether approval may commit + push this repository. */
  gitPush: "allow" | "deny";
  executionImage: string;
  networkMode: string;
  allowedHosts: string[];
}

export function renderRepositoryListMessage(
  repositories: RepositoryView[],
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock("仓库", `已注册 ${repositories.length} 个`),
  ];
  if (repositories.length === 0) {
    blocks.push(
      markdownBlock(
        "还没有注册任何仓库。用 CLI 注册：\n" +
          "```\nai repository create --id repo-x --name x --url <git-url> \\\n" +
          "  --local-path /srv/repos/x --verify \"npm test\" \\\n" +
          "  --exec-image harness/execution:node22 --git-push deny\n```",
      ),
    );
  } else {
    for (const repository of repositories) {
      blocks.push(
        markdownBlock(
          [
            `**${repository.name}** \`${repository.id}\``,
            `- 分支 ${repository.defaultBranch} · 推送 ${repository.gitPush === "allow" ? "允许" : "禁止"} · 验证 ${repository.verificationCommands.length} 条`,
            `- ${repository.url}`,
            `- 本地 ${repository.localPath}`,
          ].join("\n"),
        ),
      );
    }
    blocks.push(
      markdownBlock("说 `用 <id> 做…` 指定仓库，或用 `查看仓库 <id>` 看执行档案。"),
    );
  }
  return { conversationId: options.conversationId ?? "repositories", blocks };
}

export function renderRepositoryMessage(
  repository: RepositoryView,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const blocks: MessageBlock[] = [
    sectionBlock(
      `${repository.id} · ${repository.name}`,
      [
        `默认分支：${repository.defaultBranch}`,
        `推送：${repository.gitPush === "allow" ? "允许（审批后 commit + push ai/ 分支）" : "禁止"}`,
      ].join("\n"),
    ),
    markdownBlock(`**URL**\n${repository.url}\n\n**本地检出**\n${repository.localPath}`),
  ];
  blocks.push(
    markdownBlock(
      repository.verificationCommands.length > 0
        ? `**验证命令**\n${repository.verificationCommands.map((command) => `- \`${command}\``).join("\n")}`
        : "**验证命令**\n(未配置 —— 没有验证的 Run 不会被当作成功)",
    ),
  );
  blocks.push(
    markdownBlock(
      [
        "**执行档案**",
        `- 镜像 ${repository.executionImage}`,
        `- 网络 ${repository.networkMode}${
          repository.allowedHosts.length > 0 ? `（允许：${repository.allowedHosts.join(", ")}）` : ""
        }`,
      ].join("\n"),
    ),
  );
  return { conversationId: options.conversationId ?? repository.id, blocks };
}
