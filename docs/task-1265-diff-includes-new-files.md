# TASK-1265 评审必须看到新增文件

> 状态：**已实现**（`src/verification/diff.ts`、`src/workspace/manager.ts` + 单测）。

## 1. 问题

Run 期间 agent **不会** `git add`（提交发生在发布阶段）。新增文件因此一直是
untracked，而 `git diff` / `git diff <base>` 都只报告已跟踪文件——
于是 agent 写的东西在评审眼里根本不存在。

2026-10-10 的真实代价：需求 `prob-e99be828e2` 的第一个任务，
三轮 Run 全部被打回，理由每次都是"测试缺失、统一下载方法不在 diff 里"，
而这三样东西其实第一轮就已经写在磁盘上了：

```text
run-2877ce4260 (attempt 1) → request_changes
run-9a70657e35 (attempt 2) → request_changes
run-6e85d50e1d (attempt 3) → request_changes → Task BLOCKED
```

被漏掉的文件（`?? ` = untracked）：

```text
?? components/download-button.tsx
?? lib/download.ts
?? unit-tests/download.test.ts
?? app/api/tracks/[trackId]/download/
```

同时被带偏的还有 harness 自己的确定性检查：`assessTestEvidence(diff.files)`
数出"改了 N 个生产文件、0 个测试"→ 风险抬成 high，和 reviewer agent 的
结论互相印证。两者吃的是同一份残缺输入，所以看起来格外可信。

## 2. 修法

采集前先把未跟踪文件标记为 intent-to-add：

```bash
git ls-files --others --exclude-standard      # 只列未被 .gitignore 忽略的新文件
git add --intent-to-add -- <那些文件>          # 只记路径，不暂存内容
git diff --name-only / --stat /               # 现在包含新文件
```

要点：

- `--intent-to-add` 只写索引里的路径，**不暂存内容**，不改变 agent 的工作树；
- 幂等：第二次跑时这些路径已经不是 "others"，`git diff` 依旧会显示它们；
- 发布阶段本来就 `git add -A`（`GitService.publish`），行为不变；
- 故意不用 `git add -A -N`：`-A` 会把"删除"也记进索引，反而让删除从
  `git diff` 里消失。

同一处逻辑也补进了 `WorkspaceManager.showDiff()`（CLI `ai review` 手工评审
走这条路），它此前有一样的坑。

## 3. 影响面

| 消费方 | 修复前 | 修复后 |
| :-- | :-- | :-- |
| reviewer agent 的 prompt | 看不到新增文件 | 看到完整改动 |
| `assessTestEvidence` / `assessChangeRisk` | 误判"没有测试变更" | 按真实文件统计 |
| 卡片上的 diff/stat | 缺新文件 | 完整 |
| `ai review`（CLI） | 缺新文件 | 完整 |

## 4. 测试

- `tests/reviewerAgent.test.ts`
  - `sees files the agent created but never committed`：真实仓库里新建两个文件，
    必须出现在 `files` / `patch` / `stat` 里；
  - 原有 stub 用例断言了 git 调用的顺序，已同步加入 `ls-files`。
- `tests/workspaceManager.test.ts` > `shows files the agent created but never added`。

```bash
npm run typecheck
npm test
```

## 5. 关联

- [task-1235-diff-collected-on-host.md](task-1235-diff-collected-on-host.md)：
  上一次同类事故（容器读不到 worktree 的 gitdir，diff 恒为空）。两次都是
  "证据采集丢内容 → reviewer 拒绝真实改动"，这次的缺口是 untracked 文件。
