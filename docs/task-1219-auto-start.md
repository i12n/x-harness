# TASK-1219 自动开始（auto intake + auto run）

> 上级设计：[autonomy-redesign.md](autonomy-redesign.md) §4.4 / §5。
> 本文是落地设计，先定决策与验收，再写代码。

## 1. 现状：Ready 之后为什么不会自动开始

| 环节 | 事实 |
| --- | --- |
| planning 产出 | `PLANNED_TASK_STATUS = "INBOX"`（`src/specification/application/planning.ts`） |
| scheduler 只认 | `listTasks({ status: "READY" })`（`src/scheduler/scheduler.ts`） |
| INBOX→READY 的唯一入口 | 人工执行 Task Intake：`ai task validate <id>`（`src/cli/commands/taskCommands.ts`） |
| 结果 | 每跑一条都要人来一次：x-music 那轮 = 3 个任务 = 3 次人工启动 + 3 次人工审批 |

桥本来就是设计好的（Task Intake，plan section 九），只是**没有人把它接上**。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **授权点 = 人的一次确认**（chat `problem.confirm` / CLI `spec.ready`）。之后不再需要 `运行 task-x` | 授权已经发生；再让人逐条按继续，是把人当调度器 |
| D2 | planning 产出 INBOX 后**自动过 intake**：合格 → READY，不合格 → BLOCKED 并把 issues 报给人 | 复用已有、有测试的 Task Intake 规则，不新造判断 |
| D3 | 开关 `AI_AUTO_START`，默认 `on`；`off` 时完全保持今天的人工 intake + 人工运行 | 一键回滚 |
| D4 | **成本护栏同批落地**：Run 默认超时 30min（`AI_RUN_TIMEOUT_MS` 默认 0 → 1800000）；并发沿用 `AI_MAX_CONCURRENCY`；重试沿用 `maxAttempts=3` | 自动开始会放大失败重试的代价，没有超时就不能开 |
| D5 | **不可逆动作不变**：自动流程只到 REVIEW；push / merge / release 仍然由人 —— 仓库策略当时默认 `gitPush: deny`，**TASK-1240 起改为默认 `allow`**（审批仍必须由人触发；护栏是前缀白名单 + 永不推默认分支） | 自动化的收益在"开发+验证"，不在"上线" |
| D6 | `task.run` 保留，定位从"启动"改为"重跑" | 人仍要能干预 |

依赖阻塞（TASK-1204 DAG）不受影响：调度器本来就只派发 `isRunnable` 的任务。

## 3. 目标流转

```text
spec.ready / problem.confirm        ← 唯一的人工「开始」授权
        │
        ▼
   planning（自动） → plan items → Tasks(INBOX)
        │                                  │
        │                        intake（自动，新）
        │                    ┌─────────────┴─────────────┐
        │                    ▼                           ▼
        │                 READY                      BLOCKED
        │                    │                     （issues 报给人）
        │                    ▼
        │        Scheduler（下一跳）→ Run → Verify → REVIEW
        ▼
   人只处理：BLOCKED 的原因、REVIEW 的验收
```

## 4. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/task/application/intakeService.ts` | `TaskIntakeService`：把 Task Intake 规则从 CLI 命令里抽出来，port 化（tasks / repositories / events） |
| `src/cli/commands/taskCommands.ts` | `validateTaskCommand` 改为薄封装，调用同一个服务（规则只有一份） |
| `src/specification/application/planning.ts` | 新增 `intake` 端口；`materializeTasks` 之后对**新建**任务逐个 intake |
| `src/server/index.ts` + `src/cli/index.ts` | 装配 intake（受 `AI_AUTO_START` 控制） |
| `src/server/config.ts` + `deploy/ai-harness.env.example` | 新增 `AI_AUTO_START`；文档化 `AI_RUN_TIMEOUT_MS` 默认值 |
| `src/worker/worker.ts` | `AI_RUN_TIMEOUT_MS` 默认 `0` → `1800000`（30min） |
| `src/server/session.ts` | 拆解后的文案：从「回复 `运行 task-x` 开始开发」改为「已自动排队开始 / N 个被拦下及原因」 |

## 5. 验收（可执行）

1. planning 之后，该 spec 的每个任务都**不再是 INBOX**（READY 或 BLOCKED）——单测直接断言。
2. 一次 loop tick 之内，READY 的任务会被创建 Run（沿用调度器，端到端断言）。
3. 不合格任务（缺 description / 缺 acceptance / 仓库不存在）落到 BLOCKED，并且 issues 出现在事件里与聊天文案里。
4. `AI_AUTO_START=off` 时行为与今天一致：任务停在 INBOX，不被自动派发。
5. `AI_RUN_TIMEOUT_MS` 未设置时，Worker 的超时是 30 分钟（默认值断言）。

## 6. 回滚

`AI_AUTO_START=off` 一键回到"人工 intake + 人工运行"。超时默认值可单独用 `AI_RUN_TIMEOUT_MS=0` 关掉。
