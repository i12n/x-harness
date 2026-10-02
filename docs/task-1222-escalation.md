# TASK-1222 升级策略（什么时候找人）

> 上级设计：[autonomy-redesign.md](autonomy-redesign.md) §5。前置：TASK-1221 的
> `decideReviewAction` 已经处理"评审说判不了 / 验收标准不可验证"，本任务补上
> **改动本身的风险**这一维度。

## 1. 缺口

TASK-1221 的自动通过只看「评审 verdict + 验收证据」。但有一类改动即使被评审 agent 认可，
也不该无人放行：迁移、配置、密钥、部署脚本、CI 定义。这些一旦出错，影响面在生产，
而不是在这次改动里。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 用**文件路径**做确定性风险分级，不交给模型 | 风险判定必须可复现、可审阅，不能取决于一次采样的措辞 |
| D2 | 命中高危路径（迁移/部署/配置/密钥/CI/容器）→ `high`；改动文件数超阈值 → `high`（大改动） | 两类风险都能从证据直接看出来 |
| D3 | `high` 风险**强制人评审**，无论评审 agent 说什么 | 与"不可逆动作留给人"一致 |
| D4 | 风险分级写入事件与 run 结果 | 事后能回答"这次为什么找人" |

## 3. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/reviewer/domain/risk.ts` | `assessChangeRisk(files)` 纯函数 |
| `src/reviewer/domain/verdict.ts` | `decideReviewAction(..., risk)`：high → `human_review` |
| `src/worker/worker.ts` | 由 diff.files 计算风险，传给策略，写进结果与事件 |

## 4. 验收（可执行）

1. 改到 `migrations/013_x.sql` → `high`，自动通过被拒（走 `human_review`）。
2. 只改业务代码且文件数在阈值内 → `low`，`decideReviewAction` 仍可 `auto_approve`。
3. 文件数超阈值 → `high`，理由写明。
4. 风险与理由出现在 `ReviewerVerdict`/`TaskReview` 事件里。

## 5. 回滚

阈值与规则集中在 `risk.ts`；把 `assessChangeRisk` 恒返回 `low` 即回到 TASK-1221 的行为。
