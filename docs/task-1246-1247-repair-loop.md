# TASK-1246/1247 验证失败后的修复：同会话续跑 + 失败证据回灌

> 现场证据：§1（2026-10-08/09 生产）。
> 相关：[task-1233](task-1233-spec-derivation-output-budget.md)（评测/失败语义）、[task-1242](requirement-interaction-redesign.md)（打回意见进提示词）。

## 1. 现场：失败之后是"盲目重试"

面包屑那条任务三次验证失败（`playwright: not found`、`tsc: not found`、中文人工步骤被当命令），
链路是：

```text
验证失败 → Run FAILED → task READY（attempts 未用尽） → 调度器起新 Run（全新 worktree、同一份任务描述）
         attempts 用尽（默认 3） → BLOCKED，等人
```

`worker.recoverTask()` 当时只有：

```ts
const next = attempt >= task.maxAttempts ? "BLOCKED" : "READY";
await this.taskStore.updateTaskStatus(task.id, next);
```

**不写任何失败信息到任务上**——实测该任务三次失败后 `constraints` 仍是 `{}`。于是下一次尝试
看不到上次哪条命令挂了、挂在哪一行，只能重跑一遍碰运气；而且每次都是新会话，把仓库重读一遍。

## 2. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **验证失败先在同一个 codex 会话里修**（`codex exec resume --last`），同一工作区、同一上下文 | 会话连续 = 不用重读仓库；实测续话仅 8.6k 输入 token，其中 7.7k 命中 provider 缓存 |
| D2 | 修复轮次有上限（`AI_REPAIR_ROUNDS`，默认 2）+ 仍受 Run 超时约束 | 防"越修越贵"的死循环 |
| D3 | 修复提示词**只带失败命令 + 输出尾部（截断 1.2 KB/条，最多 5 条）** | 续话会重发整个上下文，提示词必须短 |
| D4 | **环境类失败不修**：`command not found` / `EACCES` / `ENOENT` 等 → 直接 FAILED + `RepairSkipped` | 缺浏览器/缺数据库不是 agent 能改的；实测白烧三次尝试就栽在这上面 |
| D5 | 修复轮次用尽仍失败 → 走原路径（READY / BLOCKED），但**这次把失败证据写到任务上**（TASK-1246）：`VERIFICATION FAILED (attempt n/m)` + 失败命令与输出尾部 | 跨 Run 的新尝试也能带着错误信息开工（复用 TASK-1242 的"最近意见进提示词"） |
| D6 | usage 按轮累加（`RunUsage` 记总和），`run.result.repairs[]` 记录每轮 | 成本可算、每轮可审 |

## 3. 落点

```text
src/agent/types.ts        AgentResult.sessionId；AgentEngine.continue?()；looksEnvironmental()
src/agent/codexEngine.ts  continue() → `codex exec … --json resume [<id>|--last] -`；sessionIdOf()
src/worker/worker.ts      验证失败 → 修复轮次循环（RepairStarted/Finished/Skipped、repairs[]）
                          recoverTask() 写 `VERIFICATION FAILED …` 到任务；collectUsage() 累加
src/server/config.ts      AI_REPAIR_ROUNDS（0 关闭，默认 2）
src/domain/event.ts       RepairStarted / RepairFinished / RepairSkipped
```

## 4. 验证

```text
tests/codexEngine.test.ts  · sessionIdOf 从 JSONL 取 thread_id
                           · continue() 生成 `exec … --json resume --last -`（沙箱配置不变）
tests/worker.test.ts       · 第一次验证失败 → 同会话修复 → 通过（记录 repairs[] 与 RepairStarted）
                           · 环境类失败（命令不存在）→ 不修复、FAILED、RepairSkipped
                           · 失败写进任务：下一次尝试的提示词能看到 `VERIFICATION FAILED`
```

全量 848 passed。

## 5. 边界与不做

- **不跨 Run 续会话**：会话文件在容器 HOME（tmpfs）里，容器销毁即消失；跨 Run 续话需要持久化
  `~/.codex` 并保留失败工作区，与"每个 Run 一个全新 worktree、失败即清理"的隔离设计冲突。
  TASK-1246 的失败证据回灌就是它的等价替代（新会话 + 带着错误信息）。
- 不改 Run/Task 状态机：修复仍然发生在**一个 Run 内**，跨 Run 的 attempts 上限继续兜底。
- 不修"验证命令本身写错"（例如把人工步骤当命令）——那是 TASK-1234 的领域。
