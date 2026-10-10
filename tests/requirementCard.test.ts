import { describe, expect, it } from "vitest";
import {
  renderRequirementCard,
  REQUIREMENT_NEXT_ACTION,
} from "../src/channel/rendering/requirement.js";
import type { OutgoingMessage } from "../src/channel/message.js";
import type { RequirementView } from "../src/requirement/application/resolver.js";

function view(overrides: Partial<RequirementView> = {}): RequirementView {
  return {
    problemId: "prob-950662cc5b",
    title: "专辑页「播放全部」间距",
    stage: "awaiting_acceptance",
    tasks: [],
    ...overrides,
  };
}

function textOf(message: OutgoingMessage): string {
  return [
    message.text ?? "",
    ...(message.blocks ?? []).flatMap((block) =>
      block.type === "markdown" || block.type === "text" || block.type === "section"
        ? [block.text]
        : block.type === "actions"
          ? block.actions.map((action) => `[${action.label}]`)
          : [],
    ),
  ].join("\n");
}

function actionsOf(message: OutgoingMessage) {
  const block = (message.blocks ?? []).find((entry) => entry.type === "actions");
  return block?.type === "actions" ? block.actions : [];
}

// TASK-1259: the card must say what the next step concretely does, carry the
// prob id as the tracking handle, and offer the actions as buttons.
describe("requirement card next step", () => {
  it("shows the prob id and spells out what the primary action will do", () => {
    const card = renderRequirementCard(view(), { conversationId: "conv-1" });
    const text = textOf(card);
    expect(text).toContain("prob-950662cc5b");
    expect(text).toContain("👉 下一步「推测试环境」");
    // Concrete: which branch target and where it lands — not just "继续".
    expect(text).toContain("test 分支");
    expect(text).toContain("测试环境");
  });

  it("carries one button per action, tagged with the requirement and its stage", () => {
    const card = renderRequirementCard(
      view({
        stage: "awaiting_release",
        delivery: { id: "dlv-9128847051", specificationId: "spec-9", status: "READY_FOR_RELEASE" } as never,
      }),
      { conversationId: "conv-1" },
    );
    const actions = actionsOf(card);
    expect(actions.map((action) => action.label)).toEqual([
      "发布",
      "再看测试环境",
      "打回并说明问题",
    ]);
    expect(actions[0]!.id).toBe(REQUIREMENT_NEXT_ACTION);
    expect(JSON.parse(actions[0]!.value!)).toEqual({
      requirementId: "prob-950662cc5b",
      action: "publish",
      stage: "awaiting_release",
    });
    expect(textOf(card)).toContain("合并 PR 到 main");
  });

  it("asks nothing once the requirement is released", () => {
    const card = renderRequirementCard(view({ stage: "released" }), {
      conversationId: "conv-1",
    });
    expect(actionsOf(card)).toEqual([]);
    expect(textOf(card)).toContain("另开一条需求");
  });

  it("keeps the internal ids in the troubleshooting line only", () => {
    const card = renderRequirementCard(
      view({ specification: { id: "spec-9d0df14cad" } as never }),
      { conversationId: "conv-1", includeIds: true },
    );
    const text = textOf(card);
    expect(text).toContain("排查详情");
    expect(text).toContain("spec-9d0df14cad");
    // …but the requirement handle stays in the header, always visible.
    expect(text).toContain("prob-950662cc5b");
  });
});
