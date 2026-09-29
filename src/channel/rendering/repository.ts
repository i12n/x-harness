import type { MessageBlock, OutgoingMessage } from "../message.js";
import type { Repository } from "../../domain/repository.js";
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

/** Domain repository → the plain facts a card may show (no store access). */
export function repositoryView(repository: Repository): RepositoryView {
  const profile = repository.executionProfile;
  return {
    id: repository.id,
    name: repository.name,
    url: repository.url,
    defaultBranch: repository.defaultBranch,
    localPath: repository.localPath,
    verificationCommands: repository.verificationCommands,
    gitPush: profile.policy.gitPush,
    executionImage: profile.image,
    networkMode: profile.network.mode,
    allowedHosts: profile.network.allow,
  };
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
        "还没有注册任何仓库。群里说 `拉取 <git-url> 仓库`（admin）即可，或用 CLI：\n" +
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

/** Facts about the host-side effects of a chat registration. */
export interface RepositoryRegistrationView {
  /** false when an identical repository was already registered. */
  created: boolean;
  clone: { path: string; cloned: boolean; message: string } | null;
}

export function renderRepositoryCreatedMessage(
  repository: RepositoryView,
  registration: RepositoryRegistrationView,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const conversationId = options.conversationId ?? repository.id;
  if (!registration.created) {
    return {
      conversationId,
      blocks: [
        sectionBlock("仓库已在册", `${repository.id} · ${repository.name}`),
        markdownBlock(
          [
            `地址：${repository.url}`,
            `本地：${repository.localPath}`,
            "",
            "同一地址重复注册不会重复克隆，直接开工即可。",
          ].join("\n"),
        ),
      ],
    };
  }

  const blocks: MessageBlock[] = [
    sectionBlock("已注册仓库", `${repository.id} · ${repository.name}`),
    markdownBlock(`**地址**\n${repository.url}\n\n**本地检出**\n${repository.localPath}`),
  ];
  if (registration.clone) {
    blocks.push(markdownBlock(`**克隆**\n${registration.clone.message}`));
  }
  blocks.push(
    markdownBlock(
      [
        `**执行档案**\n${repository.executionImage} · 网络 ${repository.networkMode}${
          repository.allowedHosts.length > 0 ? `（允许：${repository.allowedHosts.join(", ")}）` : ""
        } · 推送 ${repository.gitPush === "allow" ? "允许" : "禁止"}`,
        repository.verificationCommands.length > 0
          ? `**验证命令**\n${repository.verificationCommands.map((command) => `- \`${command}\``).join("\n")}`
          : "**验证命令**\n(未配置 —— 没有验证的 Run 不会被当作成功；要补请用 CLI 重新注册)",
      ].join("\n\n"),
    ),
  );
  blocks.push(
    markdownBlock(
      `说 \`用 ${repository.id} 做…\` 指定它开工，或 \`查看仓库 ${repository.id}\` 看执行档案。`,
    ),
  );
  return { conversationId, blocks };
}
