# TASK-1256 已合并/已上线的交付不再推测试分支

> 现场证据：§1（2026-10-09 生产库 + 飞书会话）。
> 相关：TASK-1241（测试分支从交付 delta 构建）、TASK-1255（生产部署确认后才 RELEASED）。

## 1. 现场

用户在新需求（`spec-9d0df14cad`，专辑页间距）跑完后说「部署到测试环境」，收到的却是：

```text
❌ deploy.test failed: handler_error —
测试分支未推送（无法在 test/dlv-134afd79f5 上提交改动：
Command failed: git apply --binary …/delivery.patch
error: patch failed: app/globals.css:273
error: app/globals.css: patch does not apply）：repo-x-music
```

两条线索：

1. 报错里的分支是 `test/dlv-134afd79f5`——**面包屑那条已经上线的交付**，不是用户当时看着的新需求（新交付是 `dlv-9128847051`，任务还停在 REVIEW）。这条消息被发在了面包屑的话题里（`conv-bb97f8e963`），解析层按"当前话题"绑定是对的。
2. 失败发生在重建测试分支时：`GitBranchPublisher` 取"这次 Run 相对 fork 点的 delta"，再把它 `git apply` 到**当前**默认分支的临时 worktree 上。而这份 delta 早就随 PR #4 合并进 main 了，补丁自然打不上。

## 2. 根因

`deployTest` 没有任何"这份交付还值不值得部署"的判断：交付已 RELEASED（必然已合并）时，delta → 默认分支的重建必然失败，用户看到的是 git 的原始错误，而不是一句能行动的话。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 交付 `RELEASED` → 直接拒绝，不再碰 git：「已经上线…要再改请开新需求」 | `deploy/application/deployService.ts` `deployTest()` |
| D2 | 交付的 PR 已合并（合并了但还没确认上线）→ 同样拒绝，说明"改动已合并进 main" | 同上（复用已有的 `findPullRequest`，不额外增加调用） |
| D3 | 动作层先拦：已 RELEASED 时「测试部署」回一句解释，不产出 `deploy.test` 命令 | `requirement/application/actions.ts` `deploy` |

不改 `GitBranchPublisher` 的 delta 语义：它按 merge-base 取 delta 是对的，问题在于不该对已合并的交付发起这次重建。

## 4. 不做（边界）

- 不把"patch 打不上"当成"分支已是最新"而静默成功——那会把真正的冲突伪装成成功。
- 不放宽"已上线不可重推测试环境"：已上线交付要再改就是新需求（RELEASED 是冻结点）。

## 5. 验证

```text
tests/deployService.test.ts      RELEASED → 拒绝且不推送；PR 已合并 → 拒绝且不推送
tests/requirementActions.test.ts 已上线时「测试部署」返回解释、不产命令
npm run typecheck / npm test     全绿
```
