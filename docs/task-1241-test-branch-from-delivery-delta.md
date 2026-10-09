# TASK-1241 测试分支按"交付差异"构建，而不是按未提交改动

> 现场证据：§1（2026-10-09 生产，`dlv-c2eaf5d883`）。
> 相关：[task-1230](task-1231-deploy-monitoring.md)（测试分支推送）、TASK-1239/1240（审批后发布与默认放开）。

## 1. 现场

审批 → 发布（`ai/task-…-run-e16e472974-t0` = `b09f6266`）→ 群里点 `测试部署 dlv-c2eaf5d883`：

```text
❌ deploy.test failed: handler_error — 测试分支未推送（工作区没有改动，没有可测试的内容）：repo-x-music
```

可改动明明在：worktree 里就是那个 commit。

## 2. 根因

`GitBranchPublisher.publish()` 用 `git status --porcelain` 判断"有没有东西要发"：

```text
dirty 为空 → 远端没有 test/<dlv> → 直接返回"工作区没有改动，没有可测试的内容"
```

它假设交付的改动**还没提交**（原设计：git stash → 从默认分支切 test 分支 → pop）。
但 TASK-1239 之后审批会先把这个改动 **commit 出去**（推 `ai/…` 分支），于是：

**"先发布、再测试部署"这条完全正常的顺序，必然撞上"工作区干净"**——改动在 HEAD 上，
却不在工作区里。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 交付差异 = `git add -A` 之后 `git diff --cached origin/<default> --binary`，**同时覆盖已提交、未提交与未跟踪**的改动 | `src/deploy/infrastructure/gitBranchPublisher.ts` |
| D2 | test 分支仍然从**当前默认分支**切（部署 workflow 在那里），差异以 patch 形式应用上去 | 同上 |
| D3 | 组装在**一次性 worktree**（`git worktree add --detach`）里完成，推送后 `worktree remove` + 删除临时目录 | 不再改写 Run 自己的工作区，也不再需要 stash/pop |
| D4 | 幂等语义不变：差异为空且远端已有该 test 分支 → `pushed: true`（no-op） | 同上 |
| D5 | 护栏不变：前缀白名单、永不推默认分支、App token 走 HTTPS 环境变量 | 同上 |

顺带的收益：不再有 `stash push -u` / `stash pop` 这一对容易被 `set -e` 和脏工作区
影响的步骤；Run 的 `ai/…` 提交也不会被 checkout 冲掉。

## 4. 验证

```text
tests/gitBranchPublisher.test.ts  · 从 origin/main 切一次性 worktree、apply patch、commit、push
                                  · 已发布交付仍是 no-op
                                  · 默认分支 / 非白名单前缀仍被拒（0 次 git 调用）
                                  · push 失败如实上报
```
