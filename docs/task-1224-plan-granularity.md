# TASK-1224 拆分收敛（requirement ↔ acceptance ↔ checks）

> 上级设计：[autonomy-redesign.md](autonomy-redesign.md) §4.1 / §4.3。
> 本文是落地设计，先定契约与判定规则，再写代码。

## 1. 现状：为什么一个改动会变成三个任务

| 环节 | 事实 |
| --- | --- |
| derive 产出 | 让模型给 `requirements[]` + `acceptance[]`（`src/server/specificationBootstrap.ts`） |
| planner 消费 | **一条 requirement = 一个任务**（`src/specification/application/planner.ts`） |
| 任务验收 | 整份 spec 的 acceptance 原样复制给每个任务（`planning.ts` materializeTasks） |
| 结果 | 实测 `spec-eaf44ab493`：真正要改的只有 1 处，却产出 3 个任务 |

三条 requirement 分别是「改间距」（交付物）、「只作用于移动端」（约束）、
「不同宽度稳定」（验收标准）。后两条不是独立交付物，但 planner 不判断这个。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **planner 不再从 requirement 拆任务，改用 spec 里的 `workItems`**；没有 `workItems` 时才回退到旧的 1:1 | 拆分是语义判断，只有模型能做；但判定权必须留在 harness |
| D2 | 每个 work item 必须**带至少一条可执行 check**；没有 check 的 work item **不能成为独立任务**，合并进上一条 | 「独立可验收」的可判定代理：证明不了的东西不是交付物。x-music 的"只作用于移动端"就是这种 |
| D3 | 验收集完全相同的两个 work item **必须合并**（近重复规则）；acceptance 必须被覆盖，未被覆盖的并入最后一条 work item | 机械可判定的收敛规则，不依赖模型自觉 |
| D4 | 任务只继承**自己那部分** acceptance（work item 子集），不再复制整份 spec 的 | 为 TASK-1220（acceptance→checks）铺路：每个任务知道自己要证明什么 |
| D5 | `workItems` 存在 `specifications.constraints`（现有 JSONB）里，**不加迁移** | 结构已在，改动最小 |
| D6 | 没有 workItems 的旧 spec 行为不变 | 兼容已 PLANNED 的历史数据 |

## 3. 新契约

derive 返回：

```json
{
  "title": "...", "summary": "...",
  "requirements": ["..."],
  "acceptance": ["可观察、可检查的验收标准", "..."],
  "workItems": [
    {
      "title": "交付物标题",
      "description": "做什么",
      "acceptance": [0, 1],
      "checks": ["可执行命令或断言：例如 node scripts/check-docs.mjs / 间距 >= 12px"]
    }
  ],
  "targets": [{ "repositoryId": "repo-x", "role": "primary" }]
}
```

harness 侧的**确定性修复**（不信任模型的拆分质量）：

```text
1. 丢掉 acceptance 索引全部越界的 work item
2. 丢掉没写 checks 的 work item —— 其 acceptance 并入前一条（没有前一条就并入后一条）
3. 完全相同的 acceptance 集合 → 合并成一条
4. acceptance 未被任何 work item 覆盖 → 并入最后一条 work item
5. 一条 work item 都不剩 → 整份 spec 变成 1 个任务（而不是 N 条 requirement 各一个）
```

## 4. 落点

| 文件 | 改动 |
| --- | --- |
| `src/domain/specification.ts` | 新增 `SpecificationWorkItem`、读写 `constraints.workItems` 的纯函数 |
| `src/store/{inMemory,postgres}SpecificationStore.ts` | 持久化/读取 workItems（走 constraints，无迁移） |
| `src/specification/application/workItems.ts`（新） | 修复规则（§3 的 1–5），纯函数、可单测 |
| `src/server/specificationBootstrap.ts` | derive prompt 增加 workItems 契约；normalize 后调修复 |
| `src/specification/application/planner.ts` | 有 workItems → 一条一个任务；否则回退旧行为 |
| `src/specification/application/planning.ts` | 任务的 acceptance 取 work item 子集；checks 存入任务 constraints |
| `src/channel/rendering/*` + `server/session.ts` | 拆解文案显示 work item（可选） |

## 5. 验收（可执行）

1. **x-music 形状回归**：给定「1 条带 check 的交付物 + 2 条无 check 的约束型 work item」
   → 修复后得到 **1 个任务**（不是 3 个），且任务的 acceptance 是全部 5 条。
2. 两个 acceptance 集相同的 work item → 合并成 1 条。
3. acceptance 索引越界 → 丢弃；全越界 → 不产生任务。
4. acceptance 未被覆盖 → 并入最后一条 work item。
5. 没有 workItems 的 spec → planner 行为与今天完全一致（回归保护）。
6. 任务 acceptance = work item 子集（不再是整份 spec 的复制）。

## 6. 回滚

derive 契约与修复规则都在 harness 侧，去掉 `workItems` 即回退旧行为；
不需要迁移，不影响已 PLANNED 的 spec。
