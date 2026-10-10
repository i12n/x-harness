import { describe, expect, it } from "vitest";
import {
  DELIVERY_STATUS_LABELS,
  PROBLEM_STATUS_LABELS,
  RUN_STATUS_LABELS,
  SPECIFICATION_STATUS_LABELS,
  TASK_STATUS_LABELS,
  deliveryStatusLabel,
  problemStatusLabel,
  runStatusLabel,
  specificationStatusLabel,
  taskStatusLabel,
} from "../src/channel/rendering/copy.js";
import { renderDeliveryMessage } from "../src/channel/rendering/delivery.js";
import { renderProblemMessage } from "../src/channel/rendering/problem.js";
import { renderRunMessage } from "../src/channel/rendering/run.js";
import { renderSpecificationMessage } from "../src/channel/rendering/specification.js";
import { renderTaskMessage } from "../src/channel/rendering/task.js";
import { buildDelivery } from "../src/domain/delivery.js";
import { buildProblem } from "../src/domain/problem.js";
import { buildRun } from "../src/domain/run.js";
import { buildSpecification } from "../src/domain/specification.js";
import { buildTask } from "../src/domain/task.js";

/**
 * TASK-1263: every status a user can read is Chinese, and no renderer leaks the
 * raw enum. Each map is checked exhaustively, so adding a status without a
 * label fails here instead of shipping English to Feishu.
 */
function assertAllChinese(labels: Record<string, string>): void {
  for (const [status, label] of Object.entries(labels)) {
    expect(label, `${status} 缺少中文文案`).toMatch(/[\u4e00-\u9fff]/);
    expect(label, `${status} 不该直接回显枚举值`).not.toBe(status);
  }
}

describe("Feishu copy is Chinese (TASK-1263)", () => {
  it("covers every status value with a Chinese label", () => {
    assertAllChinese(RUN_STATUS_LABELS);
    assertAllChinese(TASK_STATUS_LABELS);
    assertAllChinese(SPECIFICATION_STATUS_LABELS);
    assertAllChinese(DELIVERY_STATUS_LABELS);
    assertAllChinese(PROBLEM_STATUS_LABELS);
  });

  it("falls back to the raw value instead of printing nothing", () => {
    expect(runStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(taskStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(specificationStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(deliveryStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
    expect(problemStatusLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });

  it("renders no English status label on any card", () => {
    const run = buildRun({
      id: "run-1",
      taskId: "task-1",
      status: "SUCCEEDED",
      attempt: 1,
      agent: "codex",
      engine: "codex",
    });
    const task = buildTask({
      id: "task-1",
      repositoryId: "repo-1",
      title: "下载按钮",
      description: "d",
      acceptance: ["每行一个下载按钮"],
    });
    const specification = buildSpecification({
      id: "spec-1",
      problemId: "prob-1",
      title: "下载功能",
      summary: "s",
    });
    const delivery = buildDelivery({ id: "dlv-1", specificationId: "spec-1" });
    const problem = buildProblem({ id: "n1", title: "下载", statement: "s" });

    const rendered = [
      renderRunMessage(run).blocks,
      renderTaskMessage(task).blocks,
      renderSpecificationMessage(specification).blocks,
      renderDeliveryMessage({ delivery, tasks: [task] }).blocks,
      renderProblemMessage(problem).blocks,
    ]
      .map((blocks) => JSON.stringify(blocks))
      .join("\n");

    for (const leaked of [
      "Status:",
      "**Reviewer**",
      "**Acceptance**",
      "**Workspaces**",
      "**Tasks**",
      "**Targets**",
      "**Plan**",
      "**Requirements**",
      "**Dependencies**",
      "**Blocking chain**",
      "**Latest failure**",
      "(not released)",
      "(no targets)",
      "Ready for Review",
    ]) {
      expect(rendered, `卡片里不应该再出现 ${leaked}`).not.toContain(leaked);
    }
  });
});
