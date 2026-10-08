# Phase 9 — Remote Execution & Isolation（服务器化与隔离）

> 来源：2026-09-16 讨论。状态：路线已确定，按 TASK-901..910 分步实现。
> 原则：**服务器负责调度，容器负责执行，Workspace 负责代码隔离，
> Policy 负责权限隔离。**

## 1. 两条边界：Control Plane / Execution Plane

```text
Control Plane（长期运行，持有权威状态）
  API / PostgreSQL / Scheduler / Loop / Worker Manager

Execution Plane（一次 Run 一个，用完销毁）
  Container(Codex CLI, Git, Node/pnpm, Gradle, 测试, 构建) + Workspace
```

不要混在一起：control plane 不执行用户代码，execution plane 不持有业务状态。

## 2. 部署形态（v0.1/v0.2 不上 Kubernetes）

单台 Linux 服务器 + Docker + Docker Compose 足够：

```text
/srv/ai-harness/
  compose.yaml           # api / scheduler / loop / worker / postgres
  .env                   # 只放控制面配置，不放任务密钥
  app/                   # 控制面服务
  postgres/
  repositories/          # 每个 repository 的本地 clone
  runs/                  # 每个 Run 的 worktree
```

Execution Container 不进 compose.yaml，由 Worker 动态 `docker run` 创建。
满足以下条件前不考虑 Kubernetes：几十/几百并发 Run、多执行节点、跨地区
Worker、GPU Worker、Control Plane 高可用。

## 3. 隔离单位是 Run，不是 Task

```text
Task
 ├── Run #1 → Container + Worktree
 ├── Run #2 → Container + Worktree
 └── Run #3 → Container + Worktree
```

一个 Run = 一次独立执行环境；默认不共享文件系统、进程、环境变量、工作目录、
Git 状态、临时文件。

## 4. Git Worktree 仍要保留

容器隔离不能代替 Git 隔离：

```text
/srv/harness/repositories/repo-001/worktrees/RUN-001  --mount-->  /workspace
```

Codex 只看到 `/workspace`（当前 Run 的 worktree），看不到整个服务器。

## 5. 安全边界（Docker 不是绝对安全）

本质上是让 AI 自动执行任意代码，必须假设它会执行恶意命令：

- **绝对禁止** 挂载 `/var/run/docker.sock`（等于交出宿主机控制权）
- **绝对禁止** 挂载宿主 `/`、`/etc`、`/root`、`/home`、`/srv/harness`
- 只允许：`/workspace`（当前 Run worktree，读写）+ `/tmp`（tmpfs）
  + `AI_CACHE_DIR` 下**该仓库自己的**缓存目录（TASK-1238，读写；见下）
- 不允许访问：其他 Run 的 workspace、PostgreSQL、生产环境
- 建议默认：`--cap-drop ALL`、`no-new-privileges`、非 root 用户、
  只读根文件系统 + tmpfs

### 5.1 验证缓存（TASK-1238）

运行容器的 `HOME` 是 tmpfs，所以每次 Run 都要重新 `npm ci` 并从头构建前端——
实测验证阶段占一次 Run 的 114~152 秒。执行层因此额外挂两处：

```text
<AI_CACHE_DIR>/<repositoryId>/npm   ->  /ai-cache/npm        （npm 包缓存）
<AI_CACHE_DIR>/<repositoryId>/next  ->  <每个 target 的 workdir>/.next/cache
```

边界：只挂**该仓库**的缓存目录（不是整个缓存根）；目录由 harness 创建并 chown 给容器
用户（uid 1000），宿主机其它路径照旧不可见；缓存内容 harness 自己从不读取。
`AI_CACHE_DIR` 默认 `/var/cache/ai-harness`。

## 6. 网络隔离

默认 restricted：允许 Git server / npm registry / 必要 API，而不是全开放。
依赖源因技术栈而异（npm/PyPI/Maven/Gradle/Cargo/私有 GitLab），
所以 **白名单属于 Repository / Execution Profile 配置，不写死在 Harness 核心**。

## 7. Secrets 不进 Repository，也不进任务数据

- 不写进 `.env`（仓库内）、`AGENTS.md`、`PROJECT.md`、Task、Run、Event
- 流向：Secret Store → Worker → 只注入当前 Run 的 Execution Container
- Run 结束即销毁；日志与轨迹中不得出现明文

## 8. Worker 生命周期（与现有 lease/heartbeat 对齐）

```text
Run
 ↓ create worktree      (WorkspaceManager)
 ↓ create container     (ExecutionManager)
 ↓ start
 ↓ agent (Codex)
 ↓ verification
 ↓ collect evidence
 ↓ destroy container
 ↓ cleanup worktree
 ↓ Run result -> PostgreSQL
```

Worker 无业务状态；权威状态在 PostgreSQL。Worker 崩溃时 Loop 依据
`lease_until < now()` 将 Run 标记 LOST 并重试——这与已实现的 lease 机制一致。

## 9. Execution Profile（按 Repository 选择运行环境）

```yaml
# frontend-node
name: frontend-node
image: harness/node:22
workspace: /workspace
commands: { install: pnpm install, test: pnpm test, build: pnpm build }

# backend-java
name: backend-java
image: harness/java:21
workspace: /workspace
commands: { test: ./gradlew test, build: ./gradlew build }
```

Repository → Execution Profile → Container Image，而不是所有项目共用一个镜像。

## 10. Policy（Agent 能做什么）

```yaml
policy:
  filesystem: { workspace: read_write, host: deny }
  git:        { status: allow, diff: allow, commit: allow, push: deny }
  network:    { outbound: restricted }
  docker:     { access: deny }
  production: { access: deny }
```

Codex 可以改代码/跑测试/commit；不能 push、不能用 docker、不能碰生产与宿主
文件系统。Policy 是 Harness 的组成部分，不是容器的副产品。

## 11. 目标架构（服务器部署后）

```text
Internet → Reverse Proxy → Harness API
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
   PostgreSQL          Scheduler / Loop        Worker Manager
                              │
                 ┌────────────┼────────────┐
                 ▼            ▼            ▼
              Worker-1     Worker-2     Worker-3
                 ▼            ▼            ▼
              Container    Container    Container
                 ▼            ▼            ▼
              RUN-001      RUN-002      RUN-003（各自 worktree + Codex + verify）
```

## 12. Phase 9 任务拆分

```text
TASK-901  Execution Container（镜像与入口约定）
TASK-902  Run → Container lifecycle（Worker 接入 ExecutionManager）
TASK-903  Worktree → Container mount（只挂当前 Run）
TASK-904  Container filesystem isolation（cap-drop / no-new-privileges / 非 root）
TASK-905  Container network policy（per-profile allow-list）
TASK-906  Secret injection（SecretStore → 仅当前 Run）
TASK-907  Resource limits（cpus / memory / pids）
TASK-908  Container cleanup / recovery（异常退出也能回收）
TASK-909  Worker crash recovery（lease + LOST + retry，已具备基础）
TASK-910  Real server E2E
```

关键验收链：

```text
Task → Run → Worktree → Container → Codex → Verification
     → Container destroyed → Run SUCCEEDED
```

隔离测试（必须在真 Docker 环境跑）：

```text
RUN-001 不能读取 RUN-002 / Host / Docker Socket / PostgreSQL
RUN-001 超 CPU/Memory 限制会被终止
RUN-001 超时会被 Harness 回收
Worker 崩溃后 Run 能恢复
```

## 13. 本仓库进展（滚动更新）

- 已实现（代码级、单元测试覆盖）：`ExecutionProfile` / `Policy` 域模型、
  `SecretStore`（环境变量实现，仅按名注入）、`ExecutionManager` +
  `LocalExecutionDriver` + `DockerExecutionDriver`、Docker 运行参数隔离规则
  （只挂载当前 workspace、`--cap-drop ALL`、`no-new-privileges`、非 root、
  tmpfs、资源限制、network 模式、run 标签）
- TASK-902 已完成：Repository 绑定 `executionProfile`（含 Postgres JSONB
  持久化与 CLI 参数：`--exec-image/--network/--allow/--secret/--cpus/...`）；
  Worker 统一经 `ExecutionManager.prepare()` 进入执行环境，Agent/Verifier
  只接收 `ExecutionContext`（`workdir` 语义），Run 结束 best-effort 清理并
  记录 `execution.prepared/cleaned` 事件；用 fake driver 覆盖了
  Worker → ExecutionManager → Agent → Verification → cleanup 全链路
- TASK-901 已完成：Execution 生命周期状态机
  `CREATING → CREATED → STARTING → RUNNING → <terminal> → CLEANING →
  CLEANED`（失败可落 `FAILED/TIMED_OUT/CANCELLED/LOST/CLEANUP_FAILED`），
  并持久化到 `executions` 表（`migrations/004_executions.sql`）
- TASK-908 已完成（本地语义层）：
  - **Cleanup obligation**：`create()` 成功即产生最终清理责任；`start()`
    失败也会清理
  - **cleanup 失败不隐藏**：记录 `CLEANUP_FAILED` + `execution.cleanup_failed`
    事件，Loop 每 tick 重试直到 `CLEANED`
  - **timeout / cancel 同一路径**：stop → finish(TIMED_OUT/CANCELLED) →
    Run 终态 → cleanup（`AI_RUN_TIMEOUT_MS` 超时；`executeRun(runId, {signal})`
    取消）
  - **Worker 崩溃恢复**：lease 过期 → Run LOST → 依据持久化的 execution
    记录 finish(LOST) + cleanup（Execution Recovery），不依赖 Worker 的 finally
- TASK-911 已完成：Execution Image / Entry Contract —— `src/execution/contract.ts`
  （硬约束：workspace 必须在 `/workspace` 之下、secret 名必须是合法环境变量；
  镜像命名 `harness/execution:<runtime>` 作为 advisory）、
  [docker/execution/Dockerfile](docker/execution/Dockerfile) 模板与
  [docker/execution/README.md](docker/execution/README.md) 契约文档；
  `DockerExecutionDriver.start()` 在起容器前强制校验硬约束
- TASK-912 已完成：`ExecutionDriver.exec()` —— Local 用本地 spawn，Docker 用
  `docker exec`（`buildDockerExecArgs`，纯函数可测）；统一
  `ExecResult`（exitCode/stdout/stderr/duration/timedOut，支持 stdin、
  timeout、AbortSignal）
- TASK-913 已完成：Codex/Verifier 容器内执行通路 —— `ExecutionContext.exec`
  由 Worker 绑定到 ExecutionManager；`CodexEngine` 优先走
  `execution.exec`（不再自行 spawn），`Verifier` 的每个 check 也走
  `sh -lc <command>` 经同一 driver；Agent 与 Verification 一定在同一执行
  环境（不会再出现 Codex 在容器、Verifier 在宿主）
- 待做：TASK-910 真 Docker E2E（矩阵验收 + 隔离测试：跨 Run 读取、宿主文件、
  docker.sock、网络 none/白名单、资源限制）、TASK-905 网络白名单的真实强制
  （依赖 Linux + Docker 环境；本机无 Docker）

### TASK-905 实现（方案 A：per-run internal network + allow-list proxy）

不做宿主防火墙改动，保证与服务器上其他服务（如 xmusic）互不影响：

```text
Worker → ExecutionManager
           ├── docker network create --internal ai-net-<run>
           ├── proxy container: ai-proxy-<run>（bridge + 该 internal 网络）
           └── run container: 只接入 ai-net-<run>，注入 HTTP(S)_PROXY
                          ↓
                  allow-list proxy（HTTP + CONNECT，白名单外一律 403）
```

- 容器无公网路由：直连 IP、绕过代理、外部 DNS 解析都会失败
- 白名单由 `ExecutionProfile.network.allow` 生成，代理镜像
  `harness/execution-proxy:latest`（`docker build -f docker/proxy/Dockerfile .`）
- 代理容器与网络按 runId 命名，Worker 崩溃后 Loop 仍可回收（deterministic）

**真机验收（2026-09-17，<验收主机>）**

- TASK-910：生命周期矩阵 8/8 + 隔离 2/2
- TASK-905：`network:none` 断网、allow-list 放行/拦截、IP 直连拦截、
  代理绕过拦截、DNS 绕过拦截 —— 全部通过
- 宿主回归：xmusic 等既有容器不受影响；无遗留容器/网络/代理
- 结论：**Phase 9 DONE**（不再扩展 Phase 9 功能）
