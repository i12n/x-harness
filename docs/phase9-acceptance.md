# Phase 9 Acceptance（TASK-910 / TASK-905 runbook）

> 代码层已完成（TASK-901/902/908/911/912/913）。本文件是真机验收的操作手册：
> 在 **Linux + Docker** 上跑完 TASK-910 与 TASK-905，通过后 Phase 9 方可封版。

## 0. 前置条件

- Linux 服务器，已装 Docker（Engine ≥ 24）
- Node ≥ 18、npm；仓库已 `npm install && npm run build`
- 宿主上有一个可以驱动的最小仓库（也可用测试自动生成的临时 git 仓库）
- Secret 只通过环境变量注入，**不要**写进 Repository/Task/Run/Event

构建执行镜像（契约见 `docker/execution/README.md`）：

```bash
docker build -f docker/execution/Dockerfile \
  --build-arg BASE_IMAGE=node:22-bookworm-slim \
  --build-arg RUNTIME=node22 \
  -t harness/execution:node22 .

# allow-list 代理（TASK-905，方案 A）
docker build -f docker/proxy/Dockerfile -t harness/execution-proxy:latest .
```

## 1. TASK-910 生命周期矩阵

```bash
AI_TEST_DOCKER=1 AI_EXECUTION_IMAGE=harness/execution:node22 npm run test:docker
```

覆盖（`tests/dockerAcceptance.integration.test.ts`）：

| 场景 | 期望 |
| --- | --- |
| 正常执行 | Run SUCCEEDED → Execution CLEANED → 容器不存在 |
| Agent 失败 | Run FAILED → CLEANED → 容器不存在 |
| Verification 失败 | Run FAILED → CLEANED → 容器不存在 |
| Container start 失败 | 无泄漏容器（label 过滤为空），Execution 终态可追踪 |
| Timeout | Run TIMED_OUT → CLEANED → 容器不存在 |
| Cancel | Run CANCELLED → CLEANED → 容器不存在 |
| Worker crash | Run LOST → Loop 回收 Execution → CLEANED → 容器不存在 |
| Cleanup failure | Execution CLEANUP_FAILED → 下一 tick 重试 → CLEANED |

判定口径：**数据库状态与真实资源状态必须一致**（`docker inspect` 必须失败、
`docker ps -a --filter label=ai-harness.run-id=<run>` 必须为空）。

## 2. Filesystem / Privilege Isolation

同一套测试里包含：

- 容器内执行 [scripts/isolation-probe.sh](../scripts/isolation-probe.sh)：非 root、
  无 docker.sock、rootfs 只读、`/etc/shadow` 不可读、CapEff 为 0、
  `/workspace`·`/tmp`·`/home/agent` 可写、宿主 `/srv/harness` 不存在
- 两个 Run 各自 workspace 互不可见（Run B 容器内不存在 Run A 的宿主路径）

## 3. TASK-905 网络强制规范

```bash
AI_TEST_DOCKER=1 AI_NETWORK_ENFORCEMENT=1 AI_EXECUTION_IMAGE=harness/execution:node22 \
  AI_NETWORK_ALLOWED_HOST=registry.npmjs.org AI_NETWORK_FORBIDDEN_HOST=example.com \
  npm run test:docker:network
```

验收对象是**真实数据包行为**，不是配置存在：

| 用例 | 期望 |
| --- | --- |
| `network:none` | 任意出网失败 |
| allow-list 命中 | 允许目标可达 |
| allow-list 未命中 | 被拦截 |
| IP 直连 | 被拦截（不能绕过 DNS 白名单） |
| DNS 重绑定/域名解析到内网 | 被拦截（建议在防火墙/代理层实现后再补用例） |

> 注意：当前 `network.mode=restricted` 只落到 Docker bridge，**尚无真实强制**。
> TASK-905 需要在宿主侧实现出网策略（nftables/iptables 或代理），
> 然后这组用例必须全绿才算完成。

## 4. 真实 Codex（容器内）

```bash
AI_TEST_DOCKER=1 AI_TEST_CODEX=1 AI_EXECUTION_IMAGE=harness/execution:node22 \
  AI_SECRET_OPENAI_API_KEY=... npm run test:docker
```

该用例让容器内的真实 Codex 完成“写 `solution.txt`”任务，Verification 在
同一容器执行，最后断言 `SUCCEEDED + CLEANED + 容器不存在`。

## 5. Phase 9 封版清单

全部满足才标记 `Phase 9 DONE`：

1. Execution 生命周期可靠（状态机 + 持久化）
2. Agent 在隔离环境执行
3. Verification 在**同一**隔离环境执行
4. Run 之间 filesystem 隔离
5. Host filesystem 隔离
6. Docker socket 隔离
7. Resource limits 生效（cpus / memory / pids）
8. Timeout / Cancel 可回收
9. Worker crash 可恢复（lease → LOST → cleanup）
10. Cleanup failure 可重试
11. Network policy 实际生效（TASK-905）
12. Secrets 不进入持久化状态（只经 `AI_SECRET_*` 注入）

## 6. 出现失败时请回传

- `npm run test:docker` 的完整输出（哪个矩阵行失败）
- `docker ps -a --filter label=ai-harness.run-id=<run>` 的结果
- 失败 Execution 的 `executions` 行与相关 `events`
