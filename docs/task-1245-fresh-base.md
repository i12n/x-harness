# TASK-1245 Run 必须从最新代码开始

> 现场证据：§1（2026-10-09 生产）。
> 相关：TASK-1241（交付差异按 fork point 计算）、[remote-execution-isolation.md](remote-execution-isolation.md)。

## 1. 现场

排查"测试分支把 main 的新提交当成要删的"时发现：`/srv/repos/x-music` 的 HEAD 停在
`beecba7`，而 `origin/main` 已经在 `aebca08`（`git status -sb` 显示 `behind 1`，
后来又落后更多）。也就是说：

```text
Run worktree 的 baseRef = "main"  ← 本地分支名
git worktree add ... main         ← 解析到本地这个旧提交
```

`GitService.syncRepository()`（fetch + `merge --ff-only`）**只被 CLI 的
`ai repository sync` 调用**，Run 路径里没有任何 fetch。结果：每个任务都在旧代码上开发，
改动落到 main 时就会冲突、甚至把 main 的新提交"回退"掉（TASK-1241 那次就是这么暴露的）。

## 2. 设计

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | Run 创建 worktree 前**先 fetch**（best-effort） | 本地检出可能几周没同步；远端才是事实 |
| D2 | 基线**优先用 `origin/<branch>`**，而不是本地分支名 | 即使基仓有未提交改动、停在别的分支、或正在被人使用，也能从远端 tip 开工；不需要动本地分支（也不用 merge） |
| D3 | fetch 失败**不阻塞**：回退到本地 ref，并把原因写进事件 | 网络抖动不该让任务无法执行；但要可见 |
| D4 | 每次 Run 记录 `WorkspaceBaseResolved { ref, sha, fetched, note? }` 事件 | 事后能回答"这次跑在哪个提交上"，也让"又跑旧代码"这类问题一眼可查 |
| D5 | 不改 `syncRepository` 的语义（那是运维手动同步整仓的入口）；worker 通过窄接口 `BaseRefResolver` 依赖它 | 分层不变，worker 不碰 git 细节 |

## 3. 落点

```text
src/git/gitService.ts        prepareBaseRef(repository, baseRef?) → { ref, sha, fetched, note? }
src/worker/worker.ts         Run 创建 worktree 前解析每个 target 的基线，并 emit 事件
src/server/index.ts          Worker 注入 gitService
src/cli/index.ts             ai run / ai loop 同样注入
src/domain/event.ts          WorkspaceBaseResolved / WorkspaceBaseUnresolved
```

## 4. 验证

```text
tests/gitService.test.ts  · 远端领先本地时：fetch 后取 origin/main，本地分支不动（sha 对齐远端 tip）
                          · 没有远端时：回退本地分支 + note 说明 fetch 失败
tests/worker.test.ts      · 解析出的 ref 真的传给了 worktree 创建，并记录 WorkspaceBaseResolved
```

全量测试 843 passed。

## 5. 运维影响

- 每次 Run 多一次 `git fetch --prune origin`（秒级；并发=1，不会打爆远端）。
- `ai repository sync` 仍然有用：它把**基仓本身**快进到最新（人在这台机器上看代码时用）。
- 想临时回到旧行为（例如远端不可达），把 Worker 的 `baseRefs` 摘掉即可——但生产不该这么做。

## 6. TASK-1248：基仓也自动保持最新

TASK-1245 只保证 **Run** 的代码新鲜（从 `origin/<branch>` 切），基仓本身仍要手动
`ai repository sync`——实测又落后了两个提交（`beecba7` vs `aebca08`）。现在 Run 的那次
fetch **顺带**做一次快进：

```text
fetch 成功 && baseRef 是默认分支 && 基仓干净 && 基仓在默认分支
   → git merge --ff-only origin/<default>      （绝不产生 merge commit）
否则 → 保持不动（人在里面改东西时不该被动他的分支）
```

结果记进 `WorkspaceBaseResolved.baseAdvanced = { branch, from, to }`，事后可查"这次 Run
顺带把基仓从 X 推到了 Y"。快进失败（分叉、无上游）不影响 Run：worktree 照旧从远端 tip 切。

```text
tests/gitService.test.ts  · 远端领先且基仓干净 → 基仓被快进（from/to 记录在案）
                          · 基仓有未提交改动     → 不快进，但 Run 仍从 origin/main 开始
```
