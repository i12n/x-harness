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
});
