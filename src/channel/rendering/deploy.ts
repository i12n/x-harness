import type { OutgoingMessage } from "../message.js";
import type {
  PromoteOutcome,
  TestDeployStart,
  TestDeployStatus,
} from "../../deploy/application/deployService.js";
import { markdownBlock, sectionBlock } from "./common.js";

const STATE_LABEL: Record<TestDeployStatus["state"], string> = {
  none: "⏳ 还没排到（Actions 可能还在排队）",
  pending: "🔄 部署中",
  succeeded: "✅ 测试环境就绪",
  failed: "❌ 部署失败",
};

export function renderTestDeployMessage(
  started: TestDeployStart,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  return {
    conversationId: options.conversationId ?? started.deliveryId,
    blocks: [
      sectionBlock(`测试部署 ${started.deliveryId}`, "已推送测试分支，等待 GitHub Actions 部署"),
      markdownBlock(
        `- 仓库：${started.repositoryId}\n- 测试分支：\`${started.branch}\`\n- PR：${started.pullRequest.url}`,
      ),
      markdownBlock(
        "部署由该仓库的 GitHub Actions 完成。查状态：`部署状态 " + started.deliveryId + "`",
      ),
    ],
  };
}

export function renderDeployStatusMessage(
  status: TestDeployStatus,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const blocks = [sectionBlock(`部署状态 ${status.deliveryId}`, STATE_LABEL[status.state])];
  blocks.push(markdownBlock(`- 测试分支：\`${status.branch}\``));
  if (status.run) {
    blocks.push(
      markdownBlock(
        `- Workflow：${status.run.name}\n- 结论：${status.run.conclusion ?? status.run.status}\n- Run：${status.run.url}`,
      ),
    );
  }
  return { conversationId: options.conversationId ?? status.deliveryId, blocks };
}

export function renderPromotedMessage(
  outcome: PromoteOutcome,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  // TASK-1255: 发布 merges the PR, but the delivery is only 已上线 once the
  // production deploy is confirmed — say which of the two happened.
  const detail = outcome.released
    ? "线上部署已确认，交付已标记为已上线"
    : outcome.productionState === "failed"
      ? "PR 已合并，但线上部署失败——交付仍是待发布，可以打回"
      : outcome.alreadyMerged
        ? "PR 已合并，正在等线上部署结果"
        : "线上发布由该仓库的 GitHub Actions 触发，部署成功后交付自动标记为已上线";
  return {
    conversationId: options.conversationId ?? outcome.deliveryId,
    blocks: [
      sectionBlock(
        `${outcome.alreadyMerged ? "PR 已合并" : "已合并到主分支"} ${outcome.deliveryId}`,
        detail,
      ),
      markdownBlock(`- PR：${outcome.pullRequest.url}`),
    ],
  };
}
