import type { OutgoingMessage } from "../message.js";
import type { PreviewEvidence } from "../../preview/application/previewService.js";
import { markdownBlock, sectionBlock } from "./common.js";

/** TASK-1226: build evidence as a card the acceptance flow can carry. */
export function renderPreviewMessage(
  evidence: PreviewEvidence,
  options: { conversationId?: string } = {},
): OutgoingMessage {
  const label =
    evidence.status === "BUILT"
      ? "✅ 构建成功"
      : evidence.status === "FAILED"
        ? "❌ 构建失败（应用很可能起不来）"
        : "➖ 没有可执行的构建";
  const blocks = [
    sectionBlock(`预览 ${evidence.deliveryId}`, label),
  ];

  if (evidence.commands.length > 0) {
    blocks.push(
      markdownBlock(
        `**命令**\n${evidence.commands
          .map(
            (command) =>
              `- ${command.status === "passed" ? "✓" : "✗"} ${command.command}` +
              `（退出码 ${command.exitCode ?? "?"}，耗时 ${command.durationSeconds} 秒）`,
          )
          .join("\n")}`,
      ),
    );
  }

  const artifacts = evidence.artifacts
    .map((artifact) => `${artifact.path} ${Math.round(artifact.sizeKb / 1024)}MB`)
    .join("、");
  if (artifacts) {
    blocks.push(markdownBlock(`**产物**\n${artifacts}`));
  }

  if (evidence.screenshots.length > 0) {
    blocks.push(
      markdownBlock(
        `**截图（${evidence.screenshots.length} 张）**\n` +
          evidence.screenshots.slice(0, 10).map((file) => `- ${file}`).join("\n"),
      ),
    );
  }

  if (evidence.notes.length > 0) {
    blocks.push(markdownBlock(evidence.notes.map((note) => `⚠️ ${note}`).join("\n")));
  }
  return {
    conversationId: options.conversationId ?? evidence.deliveryId,
    text: `预览 ${evidence.deliveryId} ${evidence.status}`,
    blocks,
  };
}
