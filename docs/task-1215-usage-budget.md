# TASK-1215 成本与用量控制（本期落地 ①③）

> backlog 原条目见 [v0.2-milestone-review.md](v0.2-milestone-review.md) §7 的
> TASK-1215（六项）。自动开始（TASK-1219）之后这条从"将来做"变成"必须做"：
> 没人盯着，失败重试和评审都会花掉真金白银。

## 1. 本期范围（拍板）

| 子项 | 状态 |
| --- | --- |
| ① usage 采集：解析 codex `--json` 的 usage → run.result + 事件 | **本期做** |
| ② 默认执行超时：`AI_RUN_TIMEOUT_MS` 默认非 0 | **已由 TASK-1219 完成**（30 分钟） |
| ③ 预算与熔断：按日 token 预算 → 超限不再派发新工作 + 事件审计 | **本期做** |
| ④ 本地执行进程组回收 | 仍待做（只影响 local 驱动；生产用 docker） |
| ⑤ 取消粒度（cancel by task / delivery） | 仍待做 |
| ⑥ Provider 限流/退避与重试预算 | 仍待做 |

## 2. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 用量从 **agent stdout** 解析（`turn.completed.usage` / OpenAI 风格字段），容忍 JSONL 里混入任何内容 | 不改 codex 调用方式；解析失败只是没有用量，不影响执行 |
| D2 | 用量写进 `run.result.usage` 并发 `RunUsage` 事件 | 事后可算账；也是预算的数据源 |
| D3 | 预算是**按 UTC 日**的 token 上限，`AI_TOKEN_BUDGET_PER_DAY`，**0 = 关闭** | 默认不改变现有行为，上线时显式开启 |
| D4 | 熔断发生在**调度环节**：超限时 Scheduler 不派发新 Run（在跑的 Run 不打断） | 打断正在跑的 Run 会浪费已经花掉的钱 |
| D5 | 状态**变化时**才发事件（`TokenBudgetExhausted` / `TokenBudgetRestored`） | 每 2 秒一跳，逐跳写事件会刷爆表 |

## 3. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/agent/usage.ts` | `parseAgentUsage(stdout)` 纯函数 |
| **新增** `src/loop/budget.ts` | `TokenBudget`：当日花费、`canStart()`、状态迁移事件 |
| `src/scheduler/scheduler.ts` | 可选 `budget`：预算耗尽时 `schedule()` 直接返回空 |
| `src/worker/worker.ts` | 解析用量 → `run.result.usage` + `RunUsage` 事件 |
| `src/server/config.ts` + env 示例 | `AI_TOKEN_BUDGET_PER_DAY`（默认 0） |

## 4. 验收（可执行）

1. JSONL 里两次 `turn.completed` → 用量求和；无 usage → undefined；OpenAI 字段名同样识别。
2. 当日花费只统计今天完成的 Run。
3. 超限 → `canStart()` 为 false，且**只发一次** `TokenBudgetExhausted`。
4. 预算为 0 → 永远允许（默认行为不变）。
5. 预算耗尽时 Scheduler 不创建任何 Run。

## 5. 回滚

`AI_TOKEN_BUDGET_PER_DAY=0`（默认）即关闭熔断；用量采集是附加字段，不影响执行。
