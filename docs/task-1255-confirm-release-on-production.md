# TASK-1255 交付在"生产部署成功"时才 RELEASED

> 现场证据：§1（2026-10-09 生产库，`dlv-134afd79f5`）。
> 相关：TASK-1230（部署交给仓库的 GitHub Actions）、TASK-1231（部署监听）、TASK-1205（交付聚合与 release 记录）。

## 1. 现场

`dlv-134afd79f5` 的代码已经上线，但库里还停在「待发布」：

```text
08:25:29  TestBranchPushed / TestPullRequestReady  test/dlv-134afd79f5 → PR #4
08:26:33  TestDeploySucceeded                      测试环境部署成功
08:27:05  delivery.ready_for_release
08:35:21  TestMerged                               PR #4 被合并（deploy.promote）
08:35:54  TestDeploySucceeded                      生产 workflow 成功
之后      —— 没有任何事件

deliveries: dlv-134afd79f5 = READY_FOR_RELEASE     releases: 0 行
```

同时：`/srv/x-music` 已 checkout 到合并提交，生产容器重建，构建产物里确实带着这次改动。也就是
「代码上线了」和「harness 认为上线了」是两件事——卡片会一直显示「待发布」并继续提供「发布」。

## 2. 根因

聊天面「发布」映射到 `deploy.promote`（`requirement/application/actions.ts`），而它的实现只做
「合并 PR + 监听生产 workflow」；**唯一把交付写成 RELEASED、写入 release 记录的是
`delivery.release`**，从未被调用。于是上线结果只推了一条「🚀 已上线」消息，库里没有任何落账。

两条次要缺口：

1. `mergePullRequest` 对已合并的 PR 返回 405——重复「发布」会直接报错，服务重启后也没法补做；
2. 监听状态是内存里的 Map，重启或 `AI_DEPLOY_WATCH=off` 时，生产成功这件事永远不会被观察到。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | **生产部署确认成功**写 release（监听 transition `production + succeeded`） | `deploy/application/deployService.ts` `poll()` |
| D2 | `promote` 幂等：PR 已合并就跳过 merge；并在同一次调用里按需确认发布 | 同上 `promote()` |
| D3 | 新增 `productionStatus()`：PR 是否已合并 + 合并之后（`mergedAt` 之后）默认分支上那条 run 的结论 | 同上；`GitHubPullRequest.mergedAt` |
| D4 | `confirmRelease()` 作为唯一入口，`release()` 上游本就幂等且只接受 READY_FOR_RELEASE | 同上 |
| D5 | release 的 `created_by` 记触发合并的人（聊天 actor）；监听触发时记 `system:deploy-watch` | `command/handlers/deploy.ts` |

**不采用**「合并即 release」：合并成功不等于上线成功，而 RELEASED 是冻结点——部署失败会变成
「只能开新需求」，无法带意见打回。留在 READY_FOR_RELEASE 才能打回重来。

## 4. 不做（边界）

- 不新增常驻轮询：兜底走「再次发布时按需核对」，避免每个 tick 打 GitHub API。
- 不猜 run 的归属：拿不到 `mergedAt` 时不认任何 run（宁可等人再点一次「发布」），
  避免把上一次部署的 success 记成这次的发布。
- 不改 `delivery.release` 的守卫语义（只有 READY_FOR_RELEASE 能发布、幂等、RELEASED 冻结）。

## 5. 验证

```text
tests/deployWatch.test.ts    生产 succeeded → 记 release；测试部署成功 / 生产失败 → 不记
tests/deployService.test.ts  已合并 PR 不重复 merge；生产成功才 release；
                             mergedAt 缺失不认 run；未合并不 release
npm run typecheck / npm test 全绿
```

运维侧：历史上卡住的交付可用 CLI 补记（只记录，无发布副作用）：

```bash
node dist/cli/index.js delivery release dlv-134afd79f5 --role admin
```
