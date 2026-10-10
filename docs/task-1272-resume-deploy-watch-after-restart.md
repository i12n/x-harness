# TASK-1272 重启后恢复在途的部署监听

> 相关：[task-1231](task-1231-deploy-monitoring.md)（轮询 + watch）、
> [task-1255](task-1255-confirm-release-on-production.md)（生产侧的 confirmRelease 兜底）、
> [task-1270-deploy-watch-since-guard.md](task-1270-deploy-watch-since-guard.md) §5（本残留风险）。

## 1. 问题

`DeployService.watching` 是**内存表**：守护进程一重启，所有在途的部署监听
静默消失。用户看到的最后一条是「🔄 测试环境部署中」，之后**永远没有下文**——
既没有「就绪」，也没有「失败」。

生产侧还有 `confirmRelease` 兜底（`发布` 那次调用会当场确认），测试侧什么都没有。
`deploy.sh` 每次发布都会重启服务，所以这个窗口是真实存在的。

## 2. 修复：启动时从事件日志重建

watch 的状态本来就都写进了事件（`TestBranchPushed` / `TestMerged` 开一条，
`TestDeploySucceeded` / `TestDeployFailed` / `TestDeployStale` / `ReleaseConfirmed`
结一条），所以"谁还在途"是可以从 append-only 日志推出来的：

```text
启动 → 对每个交付取最新的"开始事件"
        └─ 之后有终结事件？→ 已完成，不恢复
        └─ 没有？          → 重新 watch（带上那次的 branch / commit / 时间锚）
                              → 第一跳轮询就把 GitHub 现在的结果报出来
```

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | `TestBranchPushed` 记录本次 push 的 `headSha`；`TestMerged` 记录 `mergedAt` / `mergeCommitSha`——恢复时用得上，也顺手补全审计 | `deploy/application/deployService.ts` |
| D2 | 新增 `restore()`：按交付聚合开始/终结事件，恢复未完成的那批并写 `DeployWatchResumed` | 同上 |
| D3 | 服务启动、`daemon.start()` 之前调用一次；失败只记日志，不影响其余功能 | `server/index.ts` |

恢复出来的 watch 与正常 watch 走**同一条**轮询与通知链路，因此 TASK-1270 的
commit 认领语义自动生效（`headSha` 就是身份），不会因为事件时间戳的秒精度
再出现"恢复后又超时"。

## 3. 边界

- `TestDeployUnconfigured` **不算终结**：那条 watch 还在等仓库把工作流按约定
  命名，恢复后继续等；
- 恢复不重放已经终结的部署（终结事件晚于开始事件即跳过），所以不会因为重启
  把历史部署重新播报一遍；
- 不持久化 watch 本身：事件日志已经是事实来源，再造一份可变的持久状态只会
  多一处不一致。

## 4. 验证

```text
tests/deployWatch.test.ts  push 后未终结 → restore 恢复并报出 succeeded；
                           已终结 → 不恢复；TestMerged → 恢复生产监听并确认 release
npm run typecheck / npm test  全绿
```

真机验证：`deploy.sh` 重启后查看日志中的「已恢复 N 个在途部署监听」；若重启
期间有测试部署完成，群里会补发对应的「测试环境就绪 / 失败」卡。
