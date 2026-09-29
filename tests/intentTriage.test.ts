import { describe, expect, it } from "vitest";
import type { IntentEngine, IntentInput, IntentResult } from "../src/command/types.js";
import {
  createIntentTriage,
  decideFromIntentResult,
  type IntentKind,
} from "../src/server/intentTriage.js";

class StubEngine implements IntentEngine {
  calls = 0;
  constructor(private readonly result: IntentResult) {}
  async parse(_input: IntentInput): Promise<IntentResult> {
    this.calls += 1;
    return this.result;
  }
}

const input = (text: string): IntentInput => ({
  channel: "feishu",
  conversationId: "conv-1",
  messageId: "om-1",
  senderId: "ou_admin",
  text,
});

/** The demo 判定矩阵 from docs/intent-triage.md §4. */
const MATRIX: { text: string; kind: IntentKind; engine?: IntentResult }[] = [
  // Queries: read-only, never create work.
  { text: "当前有哪些仓库", kind: "query", engine: cmd("repository.list", {}, "query", 0.95) },
  { text: "现在有几个任务", kind: "query", engine: cmd("task.list", {}, "query", 0.95) },
  {
    text: "有哪些在做的任务",
    kind: "query",
    engine: cmd("task.list", { status: "RUNNING" }, "query", 0.9),
  },
  {
    text: "看看 repo-demo 的配置",
    kind: "query",
    engine: cmd("repository.show", { repositoryId: "repo-demo" }, "query", 0.9),
  },
  { text: "查看配置", kind: "query", engine: cmd("config.show", {}, "query", 0.95) },
  { text: "聊天记录", kind: "query", engine: cmd("conversation.show", {}, "query", 0.9) },
  {
    text: "task-3 为什么失败了",
    kind: "query",
    engine: cmd("run.list", { taskId: "task-3" }, "query", 0.85),
  },
  {
    text: "昨天那个任务跑到哪了",
    kind: "query",
    engine: cmd("task.show", { taskId: "task-3" }, "query", 0.7),
  },
  {
    text: "谁有权限用这个机器人",
    kind: "query",
    engine: cmd("config.show", { key: "FEISHU_ALLOWED_OPEN_IDS" }, "query", 0.85),
  },
  // Actions on existing work.
  { text: "运行 task-3", kind: "act" },
  { text: "取消 run-9", kind: "act" },
  { text: "通过 task-3", kind: "act" },
  {
    text: "打回 task-3，验收没覆盖空数据",
    kind: "act",
    engine: cmd("review.request_changes", { taskId: "task-3" }, "act", 0.9),
  },
  {
    text: "把并发改成 1",
    kind: "act",
    engine: cmd("config.set", { key: "AI_MAX_CONCURRENCY", value: "1" }, "act", 0.9),
  },
  {
    text: "授权 ou_abc12345 为 developer",
    kind: "act",
    engine: cmd("access.grant", { openId: "ou_abc12345", role: "developer" }, "act", 0.9),
  },
  { text: "重启服务", kind: "act", engine: cmd("config.apply", {}, "act", 0.9) },
  { text: "推送 task-3", kind: "act" },
  { text: "拉取 git@github.com:i12n/x-music.git 仓库", kind: "act" },
  // New work.
  {
    text: "首页在没有数据时没有任何提示",
    kind: "work",
    engine: cmd(
      "problem.create",
      { title: "空状态", statement: "首页在没有数据时没有任何提示" },
      "work",
      0.9,
    ),
  },
  {
    text: "登录偶尔 500，帮我看下",
    kind: "work",
    engine: cmd("problem.create", { title: "登录 500", statement: "登录偶尔 500" }, "work", 0.85),
  },
  {
    text: "能不能支持深色模式",
    kind: "work",
    engine: cmd("problem.create", { title: "深色模式", statement: "支持深色模式" }, "work", 0.75),
  },
  // Chat.
  { text: "你好", kind: "chat", engine: { command: undefined, kind: "chat", confidence: 0.9 } },
  { text: "你是谁", kind: "chat", engine: { command: undefined, kind: "chat", confidence: 0.9 } },
];

function cmd(
  type: string,
  payload: Record<string, unknown>,
  kind: IntentKind,
  confidence: number,
): IntentResult {
  return { command: { type, payload }, kind, confidence, reason: "stub" };
}

describe("intent triage matrix (docs/intent-triage.md §4)", () => {
  for (const row of MATRIX) {
    it(`classifies 「${row.text}」 as ${row.kind}`, async () => {
      const engine = new StubEngine(row.engine ?? { command: undefined });
      const triage = createIntentTriage({ engine });

      const decision = await triage.classify(input(row.text));

      expect(decision.kind).toBe(row.kind);
      expect(decision.needsConfirmation).toBe(false);
    });
  }
});

describe("deterministic rules", () => {
  it("routes 「动作 + 具名对象」 without calling the model", async () => {
    const engine = new StubEngine({ command: undefined });
    const triage = createIntentTriage({ engine });

    const decision = await triage.classify(input("运行 task-abc123"));

    expect(decision.stage).toBe("rule");
    expect(decision.kind).toBe("act");
    expect(decision.command).toMatchObject({ type: "task.run", payload: { taskId: "task-abc123" } });
    expect(engine.calls).toBe(0);
  });

  it("routes 「拉取 <url> 仓库」 to repository.create without the model", async () => {
    const engine = new StubEngine({ command: undefined });
    const triage = createIntentTriage({ engine });

    const scp = await triage.classify(input("拉取 git@github.com:i12n/x-music.git 仓库"));
    expect(scp.stage).toBe("rule");
    expect(scp.kind).toBe("act");
    expect(scp.command).toMatchObject({
      type: "repository.create",
      payload: { url: "git@github.com:i12n/x-music.git" },
    });

    const https = await triage.classify(input("注册 https://github.com/i12n/x-login.git"));
    expect(https.command).toMatchObject({
      type: "repository.create",
      payload: { url: "https://github.com/i12n/x-login.git" },
    });
    expect(engine.calls).toBe(0);
  });

  it("leaves anything without a concrete id to the model", async () => {
    const engine = new StubEngine(cmd("problem.create", { title: "t", statement: "s" }, "work", 0.8));
    const triage = createIntentTriage({ engine });

    await triage.classify(input("把这个跑起来"));

    expect(engine.calls).toBe(1);
  });
});

describe("confidence policy", () => {
  it("asks before acting on a low-confidence work verdict", async () => {
    const engine = new StubEngine(
      cmd("problem.create", { title: "优化", statement: "优化一下首页" }, "work", 0.4),
    );
    const triage = createIntentTriage({ engine });

    const decision = await triage.classify(input("优化一下首页"));

    expect(decision.kind).toBe("work");
    expect(decision.needsConfirmation).toBe(true);
  });

  it("asks when the model says work but produced no command", () => {
    const decision = decideFromIntentResult({
      command: undefined,
      kind: "work",
      confidence: 0.9,
      reason: "看起来像需求，但没给出命令",
    });
    expect(decision.needsConfirmation).toBe(true);
    // Confidence is capped: an unusable verdict must never act.
    expect(decision.confidence).toBeLessThanOrEqual(0.5);
  });

  it("never asks for confirmation on a query", async () => {
    const engine = new StubEngine(cmd("task.list", {}, "query", 0.3));
    const triage = createIntentTriage({ engine });
    const decision = await triage.classify(input("有哪些任务"));
    expect(decision.kind).toBe("query");
    expect(decision.needsConfirmation).toBe(false);
  });
});

describe("robustness when the model omits kind", () => {
  it("infers the class from the command type", () => {
    expect(decideFromIntentResult({ command: { type: "task.list", payload: {} } }).kind).toBe("query");
    expect(decideFromIntentResult({ command: { type: "task.run", payload: {} } }).kind).toBe("act");
    expect(
      decideFromIntentResult({ command: { type: "problem.create", payload: {} } }).kind,
    ).toBe("work");
  });

  it("falls back to chat for an unusable engine result", () => {
    const decision = decideFromIntentResult({ command: undefined });
    expect(decision.kind).toBe("chat");
    expect(decision.command).toBeUndefined();
  });
});
