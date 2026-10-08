import { describe, expect, it } from "vitest";
import { isDeliverable, mergeNonDeliverables } from "../src/specification/domain/planGranularity.js";
import type { SpecificationWorkItem } from "../src/domain/specification.js";

const item = (title: string, extra: Partial<SpecificationWorkItem> = {}): SpecificationWorkItem => ({
  title,
  description: title,
  acceptance: [],
  checks: [],
  ...extra,
});

/** The three items that dlv-487e422b44 was actually split into. */
const live = [
  item("移动端专辑页「播放全部」按钮与上方标签的间距增大到合理视觉间距"),
  item("调整只作用于移动端专辑页的该处布局，不改变桌面端及其它页面的现有样式与元素位置"),
  item("调整后在不同移动端屏幕宽度下布局保持稳定，按钮与其它元素不发生重叠或错位"),
];

describe("plan granularity (TASK-1232)", () => {
  it("keeps one task out of the live three-item split", () => {
    const { items, merged } = mergeNonDeliverables(live);
    expect(items).toHaveLength(1);
    expect(merged).toHaveLength(2);
    // The merged wording is not lost — it rides on the deliverable.
    expect(items[0]!.description).toContain("不改变桌面端");
    expect(items[0]!.description).toContain("不发生重叠或错位");
  });

  it("classifies the live constraint and criterion as non-deliverables", () => {
    expect(isDeliverable(live[0]!)).toBe(true);
    expect(isDeliverable(live[1]!)).toBe(false);
    expect(isDeliverable(live[2]!)).toBe(false);
  });

  it("leaves a plan of real deliverables untouched", () => {
    const plans = [
      item("给专辑页加一个分享按钮", { checks: ["npm test"] }),
      item("把首页空状态文案改成引导语"),
    ];
    const { items, merged } = mergeNonDeliverables(plans);
    expect(items).toEqual(plans);
    expect(merged).toEqual([]);
  });

  it("keeps everything when nothing looks like a deliverable", () => {
    const onlyRules = [item("只作用于移动端"), item("不得改变桌面端")];
    const { items, merged } = mergeNonDeliverables(onlyRules);
    expect(items).toEqual(onlyRules);
    expect(merged).toEqual([]);
  });

  it("carries the merged item's acceptance over", () => {
    const withChecks = [
      item("加播放按钮", { checks: ["npm test"] }),
      item("按钮不得重叠", { acceptance: [3] }),
    ];
    const { items } = mergeNonDeliverables(withChecks);
    expect(items).toHaveLength(1);
    expect(items[0]!.checks).toEqual(["npm test"]);
    expect(items[0]!.acceptance).toEqual([3]);
  });

  // Conservative by design: a planner that attached executable checks to an
  // item meant it to be provable, so we keep it as a Task.
  it("keeps an item that carries executable checks", () => {
    expect(isDeliverable(item("按钮不得重叠", { checks: ["npm run e2e"] }))).toBe(true);
  });

  it("treats a change with proof as deliverable even if worded oddly", () => {
    expect(isDeliverable(item("不得重叠地实现新按钮", { checks: ["npm test"] }))).toBe(true);
  });
});
