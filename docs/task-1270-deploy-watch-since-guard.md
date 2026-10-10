# TASK-1270 测试部署监听：锚在 push 上，用 commit 认领 run

> 现场：2026-10-10 生产库 + GitHub Actions（`dlv-3ee9ed0da9`）。
> 相关：[task-1231](task-1231-deploy-monitoring.md)（watch + sinceMs）、
> [task-1268-deploy-workflow-convention.md](task-1268-deploy-workflow-convention.md)（scoped 端点 + commit 钉扎）、
> [test-environment-deployment-plan.md](test-environment-deployment-plan.md) §5.3。

## 1. 现场

用户收到：

```text
⏳ 测试环境部署超时，仍在进行：dlv-3ee9ed0da9
监听已超时，可以用「部署状态」再查一次。
```

但这次部署其实**早就成功了**：run `38029056640`（`deploy-test.yml` / `push`，
`head_sha=5116fb80…`）`conclusion=success`。是 harness 的监听把自己骗了。

事件流（2026-10-10 UTC）：

| 时间 | 事件 |
| --- | --- |
| 05:53:46.791 | `TestBranchPushed` |
| 05:53:48.184 | `TestPullRequestReady` → 紧接着 `watch()` |
| 05:53:48.504 | 首次轮询 → `TestDeployProgress {state:"none"}` |
| 06:24:13 | `TestDeployStale`（30 分钟 TTL） |

## 2. 根因

`deployTest()` 的顺序是 **推分支 → 建 PR → `watch()`**，而 `watch()` 的
`sinceMs` 默认取"此刻"（watch 调用时间），`statusOn()` 又要求
`run.createdAt >= sinceMs`。

GitHub 的 `createdAt` 只有**秒**精度：这条 run 是 `05:53:48.000`，而 watch 起点
在 `05:53:48.18`（建 PR 花的 1.4 秒之后）。run 看起来"比 watch 还早"，于是
**每一轮轮询都被过滤掉**——监听永远停在 `none`，到 TTL 就报"超时"。

用 harness 自己的客户端复现过滤：

```text
run.createdAt = 2026-10-10T05:53:48Z  headSha=5116fb80…  conclusion=success
since=…48.000Z -> MATCHED
since=…48.185Z -> none      ← 实际 watch 用的就是这个量级
```

历史交付能成功只是竞态赢了：GitHub 排队列比建 PR 慢一点，`createdAt` 落到
watch 之后。TASK-1268 的 commit 钉扎本来已经能唯一认领这次 run，但时间守卫
先跑，把它否掉了。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | `deployTest()` 在 `git.publish()` **之前**取时间戳，作为 `sinceMs` 传给 `watch()`。run 一定在 push 之后创建，不可能再"比 watch 早" | `deploy/application/deployService.ts` |
| D2 | `statusOn()`：两侧都知道 commit 时，**sha 就是身份**，不再看 `createdAt >= sinceMs`；只有 API 没给 `head_sha` 时才退回时间守卫 | 同上 |
| D3 | 回归用例覆盖两条：同一秒里略早于 watch 起点的 run（靠 sha 认领）、push 与 watch 之间创建的 run（靠 push 前的时间锚） | `tests/deployWatch.test.ts` |

生产路径同样受益：`promote()` / `productionStatus()` 现在靠 merge commit 认领
run，`mergedAt` 的秒精度不再是风险点。

## 4. 不做（边界）

- `sinceMs` 不删：没有 `head_sha` 的客户端（或旧响应）仍靠它把"上一次部署的
  结论"挡在门外；
- 不加固定容差（如 `sinceMs - 1s`）：那只是把竞态窗口挪一个位置，不如用
  commit 直接认领；
- 不动 TTL（30 分钟）与轮询间隔（30 秒）。

## 5. 已知残留（另立任务）

`watching` 仍是**内存表**：守护进程重启会静默丢掉在途的监听（生产路径有
`confirmRelease` 兜底，测试路径没有，用户会什么都收不到）。本次事故不是它
造成的（窗口内没有重启），但需要一个持久化或启动时对账的方案。

## 6. 验证

```text
tests/deployWatch.test.ts   同一秒 + 同名 commit → pending；无 commit 的旧 run 仍报 none；
                            push 后、watch 前创建的 run 被认领
npm run typecheck / npm test  全绿
```
