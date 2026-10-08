# TASK-1231 部署监控与反馈（loop 轮询）

> 上级设计：[test-environment-deployment-plan.md](test-environment-deployment-plan.md)。
> 前置：TASK-1230 的命令与装配已上线，`deploy.status` 可查状态——**但没人替你去查**。

## 1. 缺口

`测试部署` 推完分支就结束了；部署成功还是失败，要靠人主动发 `部署状态 <dlv>`。
方案要求的"harness 监控部署并给出反馈"目前只做了一半。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **轮询**，不做 webhook | harness 只有飞书长连接、没有 HTTP 入口；轮询不需要新开公网面 |
| D2 | 只轮询**有活跃部署**的交付，**默认 30s 一次** | GitHub API 配额 5000/h；2s 一跳全查会撞限流，空闲时不查 |
| D3 | **状态变化才**写事件、才推消息 | 避免每 30s 重复刷屏 |
| D4 | 结束态（succeeded / failed）后**停止轮询**；超过 TTL（默认 30min）未结束则报"仍在进行中"并停止 | 不能让 watch 列表无限增长 |
| D5 | watch 列表**内存 + 事件**：`deploy.test` 成功即登记；启动时从最近的 `TestDeployWatching` 事件恢复 | 复用 events 表，不新增表；重启不丢在跟的部署 |
| D6 | 监控在 loop 的**独立阶段**里跑（沿用 `runPhase` 隔离） | 一个交付查失败不能影响调度与执行 |
| D7 | 开关 `AI_DEPLOY_WATCH=on|off`（默认 on） | 一键回滚到"只能用 `部署状态` 手动查" |
| D8 | 反馈**沿用现有 notifier**：发到该交付绑定的会话；没有绑定时发 `FEISHU_DEFAULT_CHAT_ID` | 与交付通知同一条路，不新增通知配置，也不新增"往哪发"的规则 |

## 3. 流转

```text
deploy.test 成功
   │  登记 deliveryId（写 TestDeployWatching 事件）
   ▼
loop 每跳（≥30s 才真正查一次）
   ├─ none/pending      → 不动作（首见 pending 可推一条"部署中"）
   ├─ succeeded         → 写 TestDeploySucceeded + 推卡片 → 停止跟踪
   ├─ failed            → 写 TestDeployFailed + 推卡片（含失败 run 链接）→ 停止跟踪
   └─ 超时(>AI_DEPLOY_WATCH_TTL_MINUTES) → 写 TestDeployStale + 推一条 → 停止跟踪
```

## 4. 落点

| 文件 | 改动 |
| --- | --- |
| `src/deploy/application/deployService.ts` | `watch(deliveryId)` / `watched()` / `poll()`：查状态、对比上次结论、产出变化 |
| `src/loop/loop.ts` | 新阶段 `deploy_watch`（`deployWatcher?: { poll(): Promise<DeployTransition[]> }`），与 `preview_reap` 同样是可选端口 |
| `src/server/index.ts` | 装配 watcher；把变化交给通知层（沿用 `notifier`，与交付通知同一条路） |
| `src/channel/rendering/deploy.ts` | 变更卡片复用 `renderDeployStatusMessage` |
| `src/server/config.ts` + env 示例 | `AI_DEPLOY_WATCH`、`AI_DEPLOY_WATCH_INTERVAL_SECONDS`(30)、`AI_DEPLOY_WATCH_TTL_MINUTES`(30) |

## 5. 验收（可执行）

1. 假 host：登记一次 → poll 返回 pending → 再 poll 返回 succeeded，且**只产出一次**变化。
2. 间隔未到不查（`now` 注入验证），空闲时 GitHub 调用次数为 0。
3. 结束态之后不再查询该交付；超时产出 stale 并停止。
4. 某次查询抛错只记 `LoopError`，其它阶段照常。
5. `AI_DEPLOY_WATCH=off` 时行为与今天一致。

## 6. 回滚

`AI_DEPLOY_WATCH=off`；`poll()` 是纯查询，不产生任何写操作（除了事件与通知）。
