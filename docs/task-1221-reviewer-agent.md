# TASK-1221 评审 agent（结构化 verdict + 证据）

> 上级设计：[autonomy-redesign.md](autonomy-redesign.md) §4.2。
> 前置：TASK-1220 已产出验收证据（每条标准的 verified / unverifiable）。

## 1. 现状

`review.approve` / `review.request_changes` 的 actor 永远是人（reviewer/admin）；
计划里 §25 早已列出的 Reviewer Agent 从未实现。每个通过的 Run 都要人点一次通过。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 评审 agent 看到的是**证据**而不是原始对话：任务标题/描述/验收标准、验收证据、本次 diff、验证结果 | 让模型做它擅长的判断，别让它去猜执行细节 |
| D2 | verdict 固定三态：`approve` / `request_changes` / `needs_human`；逐条验收标准给出 `met/not_met/unverifiable` | 结构化才能被策略消费（TASK-1222），自由文本不能 |
| D3 | **自动通过三重条件**：`AI_REVIEWER=on` **且** verdict=approve **且** 没有 `unverifiable` 验收标准 | 机器判不了的必须留给人；这是"自动通过"的安全边界 |
| D4 | 自动通过**不触发 publish** | 合并/推送是不可逆动作，仍然由人做（`review.approve` 才发布） |
| D5 | `request_changes` → 任务回 READY 自动返工（attempts 内），超过上限 → BLOCKED | 与执行失败的重试策略一致 |
| D6 | `needs_human` → 任务停在 REVIEW，卡片写明评审 agent 的理由 | 升级而不是静默 |
| D7 | 默认 `AI_REVIEWER=on`；`shadow`（只记录不改状态）/`off` 是逃生口 | 用户要减少人工；先前的验证门禁 + D3 已构成安全网 |
| D8 | diff 由 harness 自己采集（`git diff`），不依赖 agent 的自我描述 | agent 说"我改了 X"不算证据 |

## 3. 流转

```text
VerificationPassed
      │  采集 diff（git diff --stat / patch，截断）
      ▼
 ReviewerAgent（LLM，结构化 JSON）
      │
      ├─ approve + 无 unverifiable + AI_REVIEWER=on → Task DONE（无人）
      ├─ approve 但有 unverifiable / mode!=on    → Task REVIEW（人验收）
      ├─ request_changes → Task READY（自动返工）或 BLOCKED（超 attempts）
      └─ needs_human     → Task REVIEW（带评审意见）
```

## 4. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/verification/diff.ts` | `collectGitDiff(workdir)`：`git diff --stat` + 截断 patch。**TASK-1235 起在宿主侧采集**——原先经执行容器跑 `git diff`，而容器读不到 worktree 的 gitdir（指向宿主路径），必然失败后被吞成空 diff，评审因此把真实改动判成"empty diff" |
| **新增** `src/reviewer/domain/verdict.ts` | verdict 类型、解析、`decideReviewAction(verdict, acceptance, mode)` 纯函数 |
| **新增** `src/reviewer/application/reviewerAgent.ts` | `LlmReviewerAgent`（复用 ChatClient + JSON 契约） |
| `src/worker/worker.ts` | 采集 diff；调评审；按 `decideReviewAction` 决定 DONE / READY / REVIEW |
| `src/server/config.ts` + env 示例 | `AI_REVIEWER=off|shadow|on`（默认 on） |
| `src/channel/rendering/run.ts` | run 卡展示评审结论与理由 |

## 5. 验收（可执行）

1. `decideReviewAction` 真值表：approve×无 unverifiable×on → auto_approve；
   approve×有 unverifiable → review（人）；request_changes → retry；
   needs_human → review；shadow/off → 永远 review。
2. verdict 解析对畸形 JSON 返回 `undefined`（不猜）。
3. diff 采集在 git 不可用时返回空而不抛异常（证据缺失不等于执行失败）。
4. run 卡出现评审结论。
5. 自动通过时**没有** git.published 事件（D4）。

## 6. 回滚

`AI_REVIEWER=off` 立即回到"全部人工评审"；`shadow` 只观察不改状态。
