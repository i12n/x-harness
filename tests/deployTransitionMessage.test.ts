import { describe, expect, it } from "vitest";
import { renderDeployTransitionMessage } from "../src/channel/rendering/deploy.js";

const urls = {
  testUrl: "http://47.100.5.48:18080/",
  productionUrl: "https://rehelu.net/",
};
const run = { url: "https://github.com/i12n/x-music/actions/runs/1" };

// TASK-1258: one message per meaningful transition, and no address before the
// deploy actually succeeded.
describe("deploy transition messages", () => {
  it("says nothing while Actions has not queued the run yet", () => {
    // `none` + `pending` both used to render as 部署中, so every deploy was
    // announced twice a few seconds apart.
    expect(
      renderDeployTransitionMessage(
        { deliveryId: "dlv-1", state: "none", kind: "production" },
        urls,
      ),
    ).toBeUndefined();
  });

  it("does not send people to the old build while production is deploying", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "pending", kind: "production", run },
      urls,
    );
    expect(message?.text).toContain("🔄 线上部署中");
    expect(message?.text).not.toContain("rehelu.net");
    expect(message?.text).toContain("部署完成后我会把地址发在这里");
    expect(message?.text).toContain(run.url);
  });

  it("shows the production address only once the deploy succeeded", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "succeeded", kind: "production", run },
      urls,
    );
    expect(message?.text).toContain("🚀 已上线");
    expect(message?.text).toContain("https://rehelu.net/");
  });

  it("holds the test address back until the test deploy is ready", () => {
    const pending = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "pending", kind: "test" },
      urls,
    );
    expect(pending?.text).not.toContain("47.100.5.48");

    const ready = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "succeeded", kind: "test" },
      urls,
    );
    expect(ready?.text).toContain("✅ 测试环境就绪");
    expect(ready?.text).toContain("http://47.100.5.48:18080/");
    expect(ready?.text).toContain("打开链接即可验收");
  });

  // TASK-1268: a repository without the conventional workflow is never "ready",
  // and the message has to say what to fix.
  it("says it cannot tell, and names the convention, when the workflow is gone", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "unconfigured", kind: "test" },
      urls,
    );
    expect(message?.text).toContain("⚠️ 无法确认测试环境部署结果");
    expect(message?.text).toContain("deploy-test.yml");
    expect(message?.text).not.toContain("测试环境就绪");
    expect(message?.text).not.toContain("47.100.5.48");
  });

  it("points at the delivery still being releasable when production fails", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "failed", kind: "production" },
      urls,
    );
    expect(message?.text).toContain("❌ 线上部署失败");
    expect(message?.text).not.toContain("rehelu.net");
    expect(message?.text).toContain("待发布");
  });

  // TASK-1269: a ready test environment is the acceptance moment — the message
  // carries 「验收完成」 plus the 验收结果反馈 box, both routed by prob id.
  it("attaches 验收完成 and a feedback box to a ready test environment", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "succeeded", kind: "test", run },
      {
        ...urls,
        acceptance: {
          requirementId: "prob-950662cc5b",
          stage: "awaiting_release",
          action: "publish",
        },
      },
    );
    const actions = (message?.blocks ?? []).find((block) => block.type === "actions");
    expect(actions?.type === "actions" ? actions.actions[0]?.label : undefined).toBe("验收完成");
    expect(
      JSON.parse((actions?.type === "actions" ? actions.actions[0]?.value : undefined) ?? "null"),
    ).toEqual({
      requirementId: "prob-950662cc5b",
      action: "publish",
      stage: "awaiting_release",
    });

    const input = (message?.blocks ?? []).find((block) => block.type === "input");
    expect(input?.type === "input" ? input.name : undefined).toBe("feedback");
    if (input?.type === "input") {
      expect(input.label).toContain("验收结果反馈");
      expect(input.submit.label).toContain("提交");
      expect(input.submit.payload).toMatchObject({
        requirementId: "prob-950662cc5b",
        action: "reject",
        stage: "awaiting_release",
      });
    }
  });

  it("accepts the work at 待验收 instead of publishing", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "succeeded", kind: "test" },
      {
        ...urls,
        acceptance: {
          requirementId: "prob-9",
          stage: "awaiting_acceptance",
          action: "approve",
        },
      },
    );
    const actions = (message?.blocks ?? []).find((block) => block.type === "actions");
    const value = actions?.type === "actions" ? actions.actions[0]?.value : undefined;
    expect(JSON.parse(value ?? "null")).toMatchObject({ action: "approve" });
  });

  it("stays a plain report without an acceptance context", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "succeeded", kind: "test" },
      urls,
    );
    expect(message?.blocks ?? []).toHaveLength(0);
    expect(message?.text).not.toContain("验收完成");
  });

  it("never puts acceptance controls on a production deploy", () => {
    const message = renderDeployTransitionMessage(
      { deliveryId: "dlv-1", state: "succeeded", kind: "production" },
      {
        ...urls,
        acceptance: {
          requirementId: "prob-9",
          stage: "awaiting_release",
          action: "publish",
        },
      },
    );
    expect(message?.blocks ?? []).toHaveLength(0);
  });
});
