# TASK-1229 统一预览（一套设置、一条流程，适用所有仓库）

> ⚠️ **范围已收窄（2026-10-08）**：部署改由 GitHub Actions 负责
> （[test-environment-deployment-plan.md](test-environment-deployment-plan.md)）。
> TASK-1229 里"harness 自己把产物送到预览主机并起容器"的部分（D4/D7/D8/D9、§4.1/§4.2、
> `preview.serve`/`preview.stop`、预览主机设置）**已移除**。保留下来的是 D1/D3/D6：
> 预览只有**一份构建设置**、仓库差异只来自命令发现、失败不阻塞验收——也就是
> TASK-1226 的证据式构建。下面的内容按新范围阅读。

> 上级设计：[preview-environment-design.md](preview-environment-design.md)。
> 合并 TASK-1226（证据式预览）与 TASK-1228（live 预览）的分叉：预览只有
> **一份设置**、**一条流程**，仓库之间不产生分支。

## 1. 要解决的问题

预览能力目前散在三处，各有各的入口与配置面：

| 出处 | 现状 |
| --- | --- |
| TASK-1226 | `preview.build`（CLI + 聊天 `预览 <dlv>`）——只出证据 |
| TASK-1227 | 仓库没声明命令时从 lockfile 推导（`commandDetection`） |
| TASK-1228 | `PreviewHostClient` / `LivePreviewService` —— 代码就位但**没有接线**，没有配置项，没有命令 |

如果继续按能力各自加一套开关，很快就会出现"这个仓库走 A 路径、那个仓库走 B 路径"。
本任务把预览收敛成**一个子系统**。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | **一套全局设置**：所有 `AI_PREVIEW_*` 在部署配置里只有一份（`preview` 组），**没有任何 per-repo 预览字段** | 仓库之间只应差"怎么构建"，不该差"预览怎么跑" |
| D2 | **一条流程**：`预览 <dlv> [--live]` 都走"取交付 → 构建 → 收集证据 →（live）传输并起容器 → URL → TTL 回收" | 证据与 live 是同一条链的两个终点，不是两条链 |
| D3 | 仓库差异**只来自命令发现**：`executionProfile.commands` 优先，缺失则从 lockfile 推导 | 复用 TASK-1227；不新增 per-repo 开关 |
| D4 | live 的机器 / 端口 / TTL / token / 资源上限由 harness 统一拥有 | 一机（预览专用）、一段端口（18080-18082）、一次一个、随机 token、TTL 强制回收 |
| D5 | 数据：预览**从不连生产库**；需要真实数据时用**生产快照副本**恢复到一次性库，随预览销毁 | 保住 D4 约束，同时拿到真实数据；脱敏与否由快照来源决定 |
| D6 | 失败不阻塞验收：证据照出、原因写清 | 沿用 TASK-1226 D6 |
| D7 | **传输不用 registry**：基础镜像一次性 `docker save \| ssh docker load`；每次预览只把构建产物打成 tar `scp` 过去，主机上解开后用基础镜像挂载运行 | TASK-1228 D2 已排除私有 registry；对 1.6G、连不上 Docker Hub 的主机，传几十 MB 产物比传 1.2G 镜像、或在主机上 `docker build` 都轻 |
| D8 | **运行镜像 = 该仓库自己的执行镜像**（`executionProfile.image`），不是全局固定的一个 | 一条规则适用任何语言（Node/Python/Go…）；仓库本来就有执行镜像，预览复用它，不新增 per-repo 预览字段 |
| D9 | **端口契约统一为 `PORT`**：主机端口映射到容器 3000，并注入 `PORT=3000` | 应用只要遵守 `PORT` 就能被任何仓库同一套流程服务，不需要 per-repo 端口配置 |

## 3. 唯一的一份设置

| key | 默认 | 说明 |
| --- | --- | --- |
| `AI_PREVIEW_MODE` | `live` | `off` / `evidence`（只出证据）/ `live`（证据 + 可点开地址） |
| `AI_PREVIEW_HOST` | —— | 预览主机（`47.100.5.48`）；仅 ssh，不装 harness |
| `AI_PREVIEW_SSH_KEY` | 部署密钥 | 连预览主机的私钥 |
| `AI_PREVIEW_PORTS` | `18080,18081,18082` | 允许占用的端口，按顺序分配 |
| `AI_PREVIEW_TTL_MINUTES` | `120` | 到期由 harness 强制回收 |
| `AI_PREVIEW_MEMORY_MB` | `768` | 每个预览容器上限 |
| `AI_PREVIEW_CPUS` | `1` | 每个预览容器上限 |
| `AI_PREVIEW_ALLOW` | `registry.npmjs.org` | 预览构建放行的包源 |

这些键**只在这里定义一次**（`src/server/deployment/schema.ts` 的 `preview` 组驱动
`config.show/set`、校验与 env 文件写入），`ServerConfig.preview` 只读同一份。

## 4. 唯一的一条流程

```text
预览 dlv-x            → 证据：构建结论 + 截图（今天已有）
预览 dlv-x --live     → 证据 + 一个可点开的 URL（TTL 到点自动回收）
预览停止 dlv-x        → 立即回收容器与端口
```

对**任何**仓库都是这条流程：

1. 取交付里第一个必需任务的成功 Run → 其 worktree；
2. 在一次性副本里构建（同一执行镜像、同一资源上限、同一网络放行）；
3. 收集证据（命令结果、产物大小、截图）；
4. `--live` 时：把构建副本打包 → `ssh` 送到预览主机 → 起一个容器
   （`-p <port>:3000`、一次性 token、TTL、内存/CPU 上限）；
5. 写事件（`PreviewBuilt` / `PreviewServing` / `PreviewStopped`），返回 URL；
6. TTL 到点或 `预览停止` → 停容器、释放端口。

### 4.1 传输机制（不是 docker push）

预览**不经过任何 registry**，只有两条通道：

| 通道 | 命令 | 频率 |
| --- | --- | --- |
| 运行用的基础镜像 | `docker save harness/execution:node22 \| ssh <host> 'docker load'` | 一次性 / 镜像更新时 |
| 本次预览的构建产物 | 本地 `tar` → `scp` → 主机上 `tar -xf` | 每次 `预览 <dlv> --live` |

对端起容器时**不重新构建镜像**：`docker run -v <产物目录>:/app <基础镜像> sh -lc <启动命令>`。
这样预览主机不需要网络、不需要 Dockerfile，也只要几十 MB 的传输量。
（TASK-1228 D2/§4 曾写"打标签 + docker save | ssh docker load"传镜像；这里按主机现实收敛到"共享基础镜像 + 送产物"。）

### 4.2 别的仓库怎么接（同一个流程，零 per-repo 预览配置）

| 步骤 | 每个仓库都做同样的事 |
| --- | --- |
| 注册 | 照常注册仓库，不填任何预览字段 |
| 命令 | `commands.install/build/start` 有声明就用；没有就从 `package.json` 推导 |
| 运行镜像 | 用该仓库的 `executionProfile.image`（D8）——预览主机上需先 `docker save <该镜像> \| ssh <host> docker load`，**每个镜像一次** |
| 起预览 | `预览 <dlv> --live`，与其它仓库完全同一条链 |
| 端口 | 应用监听 `$PORT`（=3000），主机映射到分配的端口（D9） |

前置条件只有两个，且对所有仓库相同：预览主机上存在该仓库的执行镜像；应用遵守 `PORT`。

## 5. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/preview/application/previewSettings.ts` | 唯一的一份设置解析（`previewSettingsFromEnv` 的继任者） |
| **新增** `src/preview/application/previewOrchestrator.ts` | 把"构建证据"与"起 live 预览"合成一条流程 |
| `src/preview/application/previewHostClient.ts` | `deploy()` 负责把 bundle 送到对端（今天缺这一步） |
| `src/command/{types,schema}.ts` | `preview.serve` / `preview.stop` |
| `src/command/handlers/preview.ts` | 两个新命令的 handler |
| `src/channel/rendering/preview.ts` | live 预览卡（URL / TTL / 停止入口） |
| `src/server/{config,deployment/schema,index}.ts`、`src/cli/index.ts` | 装配：设置、命令、loop 回收 |
| `src/loop/loop.ts` | 每跳回收过期预览 |

## 6. 验收（可执行）

1. 新增仓库不需要任何预览配置即可 `预览 <dlv>`；`--live` 走同一条路径。
2. `AI_PREVIEW_MODE=off` 时 `预览` 命令明确拒绝并说明原因。
3. 两次 `--live` 使用不同端口；端口用尽时拒绝并提示 `预览停止`。
4. TTL 到点后 loop 回收，`PreviewStopped` 事件被写入。
5. 对端不可达时事件写明原因，验收流程不受影响（仍可用证据与截图）。
6. 配置只有一份：`config.show` 的预览项不出现在任何 repository 档案里。

## 7. 回滚

`AI_PREVIEW_MODE=evidence` 回到 TASK-1226 行为（只出证据，不起容器）；
`off` 完全关闭。两者都不需要改代码。
