# TASK-1235 reviewer 的 diff 改在宿主侧采集

> 现场证据：§1（2026-10-08 生产库，`run-aa7a46f758`）。
> 相关：TASK-1221（评审 agent）、TASK-1225（测试证据元检查）、TASK-1222（风险分级）。

## 1. 现场

面包屑任务第 5 次 Run：agent `exitCode=0`、**验证全部通过**（`node scripts/check-docs.mjs`
与 `npm ci && npx prisma generate && npm run build`），`RunSucceeded`。紧接着评审给：

```text
verdict=request_changes
notes: 任务要求为面包屑 sep 元素增加左右各 16px 间距，但 harness 采集到的 diff 为空，
       没有任何代码或样式改动，三条验收标准均无证据支持。
```

而改动确实存在——留在磁盘上的 worktree 里：

```text
$ git -c safe.directory=* diff --stat      # （宿主上，带 safe.directory）
 package.json                        |  1 +
 tests/seo.spec.ts                   | 16 ++++++++++++++++
 ... app/globals.css                 | +.breadcrumbs .sep { margin-left:16px; margin-right:16px }
 10 files changed, 81 insertions(+), 9 deletions(-)
```

但在执行容器里：

```text
$ docker run --entrypoint sh -v <worktree>:/workspace -w /workspace harness/execution:node22 \
    -c "git diff --stat"
fatal: not a git repository: /srv/repos/x-music/.git/worktrees/task-spec-e13a0f2517-0-target-0
```

## 2. 根因

`collectGitDiff()` 通过**执行驱动**在容器里跑 `git diff`。worktree 的 `.git` 只是一个
指针文件，指向宿主上的 `<repo>/.git/worktrees/<id>`——这个路径**从不挂进容器**
（`src/git/gitService.ts` 的类注释早就写明："inside a Run container git cannot even read
the worktree's gitdir"）。于是容器里的 git 必然失败，而 `collectGitDiff` 的设计是
"采集失败不能影响 Run"，异常被吞成空 diff。

后果不是漏报而是**误报**：评审 agent 看到的是一份"什么都没改"的证据，于是把真实改动
判成返工/空 diff。历史上每一次 `empty diff / no changed files` 都是这个原因
（含 `task-spec-eaf44ab493-1` 的三次返工）。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | diff 改在**宿主侧**采集：`collectGitDiff(workdir)` 直接 `execFile(git …)`，路径用 `ExecutionContext.workspacePath`（宿主 worktree 路径） | `src/verification/diff.ts`、`src/worker/worker.ts` |
| D2 | 与 `GitService` 同样的 `-c safe.directory=<cwd>`：容器以 uid 1000 写工作区、harness 以 root 读，不加会触发 git "dubious ownership" | 同上 |
| D3 | 保留"采集失败不影响 Run"的语义（git 异常 → 空 diff），但不再把**必然失败**的调用当成正常路径 | 同上 |
| D4 | 不加容器挂载（不把 `.git` 暴露给执行容器），也不改容器权限 | 边界 |

为什么不在容器里挂 `.git`：那等于把仓库元数据与对象库交给执行容器，而容器按设计
不持有仓库凭证、只应看到工作区；宿主本来就是 fetch/commit/publish 的执行方。

## 4. 验证

```text
tests/reviewerAgent.test.ts  · 三个采集用例（runGit 注入：files/stat/truncated patch）
                             · 真实仓库里未提交改动可见
                             · **真实 linked worktree 里未提交改动可见**（本次回归的形态）
```

`npm run typecheck` / `npm test` 全绿（809 passed）。
