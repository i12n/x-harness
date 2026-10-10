# 测试环境 / 线上环境部署方案（GitHub 驱动）

> 状态：方案（取代 [preview-environment-design.md](preview-environment-design.md) 与
> [task-1228-preview-host.md](task-1228-preview-host.md) 里"harness 直接部署"的部分）。
> 核心变化：**部署不再由 harness 执行**——测试环境与线上环境都由 GitHub Actions 构建与部署，
> harness 只负责推送分支、监控部署结果、把结果反馈给人。

## 1. 要求（来自需求）

1. 需要测试验收时，把对应项目的代码推送到**特定的测试分支**。
2. 所有项目托管在 GitHub，**由 GitHub 做测试环境部署**。
3. 验收通过后，测试分支代码进入**主分支**，并触发**线上发布**；线上部署同样由 GitHub 触发管理。
4. 具体部署不再由 harness 控制；**harness 只负责监控部署是否成功并给出反馈**。

## 2. 角色划分

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| **harness** | 推送测试分支、开 PR、**监控部署状态**、把状态反馈到飞书、验收通过后合并 PR | 不构建部署产物、不连测试/线上环境、不持有部署凭证 |
| **GitHub Actions（每个项目仓库）** | 测试环境部署、主分支线上发布、部署回滚 | 不判断验收是否通过 |
| **人** | 在飞书上做验收确认（唯一的放行点） | 不再手动跑部署命令 |

一句话：**harness 变成"调度 + 观察者"，GitHub 变成"执行者"**。

## 3. 分支与流水线模型

每个项目仓库约定三条线：

```text
main                    线上分支；只有通过验收的代码才进来
test/<deliveryId>       测试分支；harness 在需要验收时推送
<repo 自己的 workflow>   GitHub Actions 负责部署
```

每个项目的 GitHub Actions 至少两个 workflow：

| workflow | 触发 | 做什么 | harness 关心什么 |
| --- | --- | --- | --- |
| `.github/workflows/deploy-test.yml` | push 到 `test/**` | 部署到测试环境 | 这次 run 的结论 + 测试环境 URL |
| `.github/workflows/deploy-prod.yml` | push/merge 到 `main` | 部署到线上 | 这次 run 的结论 |

**这两个文件名是接入 harness 的硬性前提**（TASK-1268）：harness 只能观测它认得的
工作流——按分支取"最新一条 run"会把同一 push 触发的其它工作流（如文档检查，
11 秒就跑完）当成部署结果。`ai repository create` / `update` 会读一次仓库的
workflow 列表并解析这两个文件的触发条件，缺一个、被禁用或触发分支对不上都直接
拒绝注册（`--skip-deploy-check` 可跳过，但该仓库的部署结果就不再可见）。
不是 GitHub 远程（如 `file://` 演示仓库）的跳过这项检查。

workflow 自身与目标环境（部署到哪台机、用什么凭证）完全属于**项目仓库**，
harness 不参与、也不需要知道细节——它只看 run 的状态与输出。

## 4. 端到端流转

```text
1. 需要验收        harness 把交付的代码推到 test/<deliveryId>，开一个 PR（base=main）
        │
        ▼
2. GitHub 部署     deploy-test workflow 触发 → 部署测试环境
        │
        ▼
3. harness 监控    轮询这次 workflow run：
                    ├─ 成功 → 飞书卡片：测试环境就绪 + URL + 本次 run 的链接
                    └─ 失败 → 飞书卡片：部署失败 + 失败步骤 + 链接（不进入验收）
        │
        ▼
4. 人验收          在飞书上确认（通过 / 打回）
        │
        ├─ 打回 → harness 不改主分支；回到第 1 步（重新推测试分支）
        └─ 通过
              ▼
5. 合并 + 发布     harness 合并 PR 到 main → deploy-prod workflow 触发线上发布
        │
        ▼
6. harness 监控    同样轮询 deploy-prod run：
                    ├─ 成功 → 反馈"已上线"
                    └─ 失败 → 反馈失败 + 链接（必要时提示回滚）
```

## 5. harness 侧需要什么（新增能力）

### 5.1 GitHub 访问

harness 现在**没有任何 GitHub 凭证**（全仓无 `GITHUB_TOKEN`/App 配置），这一步是硬前置。
两种选型：

| 方案 | 权限来源 | 取舍 |
| --- | --- | --- |
| **GitHub App（推荐）** | 安装到选定仓库 | 权限可细粒度（contents/pull_requests/actions: read+write）、可随时卸载、不绑个人账号 |
| Personal Access Token | 个人账号 | 简单，但权限粗、绑个人、轮换麻烦 |

需要的权限最小集：`contents: write`（推分支）、`pull_requests: write`（开/合并 PR）、
`actions: read`（读 workflow run 状态）。**不需要** environments / secrets 的任何权限
——部署凭证留在 GitHub 仓库自己的 Secrets 里，harness 从不接触。

配置：`AI_GITHUB_APP_ID` / `AI_GITHUB_APP_INSTALLATION_ID` /
`AI_GITHUB_APP_PRIVATE_KEY_PATH`（私钥文件 600，不进仓库）。没配 App 时回退
`AI_GITHUB_TOKEN`（fine-grained PAT），仅作过渡。

### 5.1.1 推送守卫必须放行测试分支

git 层原本只允许推送 `AI_GIT_PUSH_PREFIX`（默认 `ai/`）下的分支，且永不推送默认分支。
测试分支是 `test/<deliveryId>`，**默认会被这条守卫拒绝**（`branch_prefix_not_allowed`）。
因此该前缀现在接受逗号分隔的多个值（例如 `ai/,test/`）；部署时必须包含 `test/`。

### 5.2 新增命令

| 命令 | 语义 |
| --- | --- |
| `测试部署 <deliveryId>` | 推 `test/<deliveryId>` + 开 PR + 开始监控 |
| `部署状态 <deliveryId>` | 查当前测试/线上部署的结论 |
| `通过 <deliveryId>` | 验收通过 → 合并 PR → 触发线上发布 → 监控 |
| `打回 <deliveryId>` | 验收不通过，不改主分支 |

命令目录（`COMMAND_TYPES`）保持显式：新增的每一条都进 catalog、schema 与意图提示词。

### 5.3 监控方式：轮询，不引入入站入口

harness 服务用飞书长连接，**没有 HTTP server、没有公网回调**（这是有意的）。
因此监控走**轮询**：loop 每跳查一次 GitHub API 的 workflow run 状态
（TASK-1268 起是 scoped 端点
`GET /repos/{owner}/{repo}/actions/workflows/deploy-test.yml/runs?branch=test/<deliveryId>&event=push`，
线上同理换成 `deploy-prod.yml` 与默认分支），
状态变化才写事件、才更新飞书卡片。这样不需要新增公网入口，也不需反向代理。

**一次 watch 怎么认领 run（TASK-1270）**：watch 锚在**这一次 push** 上——
`sinceMs` 取 push 之前的时间戳（不是 watch 调用时间），并用这次 push 的 commit
`head_sha` 认领 run。两条一起用，是因为 GitHub 的 `createdAt` 只有秒精度：
push 与建 PR 之间创建的 run 可能"看起来比 watch 还早"，只靠时间比较会被永久
过滤，监听停在 `none`，直到 30 分钟 TTL 才误报"部署超时"。只有 API 没给
`head_sha` 时才退回时间守卫。详见
[task-1270-deploy-watch-since-guard.md](task-1270-deploy-watch-since-guard.md)。

**重启不丢监听（TASK-1272）**：watch 是内存态，服务启动时从事件日志
（`TestBranchPushed` / `TestMerged` 开着、终结事件结着）重建尚未完成的那些，
再交给同一条轮询链路——重启期间完成的部署仍会补发「测试环境就绪 / 失败」。
详见 [task-1272-resume-deploy-watch-after-restart.md](task-1272-resume-deploy-watch-after-restart.md)。

（未来若要做 PR 打开即预览，再考虑 GitHub webhook；那需要一个新的受保护入站入口，
属于额外工作。）

### 5.4 事件与反馈

| 事件 | 何时写 | 反馈 |
| --- | --- | --- |
| `TestBranchPushed` | 推测试分支成功 | 卡片：已推送 + PR 链接 |
| `TestDeployStarted` | 监控到 deploy-test 开始 | 卡片：测试环境部署中 |
| `TestDeploySucceeded` | run 成功 | 卡片：测试环境就绪 + URL + **验收完成 / 验收结果反馈**（决策点才有，见 5.5） |
| `TestDeployFailed` | run 失败 | 卡片：失败 + 失败步骤 + 链接 |
| `MergeStarted` / `Merged` | 合并 PR | 卡片：已合并到 main |
| `ProdDeploySucceeded` / `ProdDeployFailed` | deploy-prod 结论 | 卡片：上线结果 |

### 5.5 测试环境就绪卡上的验收（TASK-1269）

部署成功后，harness 解析「交付 → 规格 → 需求」；**当需求正处在决策点**
（待验收 / 待发布）时，这条就绪消息带上两个控件：

```text
[ 要调整的地方写在这里（不用改可以不填） ] [ 提交验收意见 ]   ← 输入框，验收后调整
[ 验收完成 ]                                                ← 一键走后续流程
```

- **验收完成**：`awaiting_release` → `publish`（合并 PR、触发线上发布）；
  `awaiting_acceptance` → `approve`（先接受这轮工作）。动作按渲染时的实际阶段决定。
- **提交验收意见**：把输入框原文作为 `feedback` 交给 `reject`，即一次交付修订
  （TASK-1267），旧任务不动、同一个 PR 更新。
- 控件携带 `prob-…` 句柄，点击/提交后仍走与打字相同的动作管线（角色门禁、
  过期阶段判定一致），用户不必再报任何 id。
- 需求不在决策点（还在开发中）时不附控件，消息保持纯播报；线上部署卡也永远不加
  控件（已上线是冻结点）。详见 [task-1269-test-env-acceptance-controls.md](task-1269-test-env-acceptance-controls.md)。

## 6. 对现有设计的影响

| 既有内容 | 影响 |
| --- | --- |
| TASK-1228/1229 预览主机（`SshPreviewHostClient`、`scp` 传产物、`docker run`、`47.100.5.48`、端口/TTL） | **部署部分退役**：harness 不再连测试环境，也不需要预览主机私钥。相关代码与配置保留为"可选证据通道"，不再是默认路径 |
| TASK-1226 证据式预览（构建 + 截图） | **保留**：验收仍然需要截图/构建结论，这部分不涉及部署 |
| `git.publish`（推 `ai/…` 分支） | 语义收敛为"推测试分支"；不再推 `ai/…` 作为部署来源 |
| 不可逆动作留给人 | 不变：合并到 main 由**验收通过**触发，人仍然是唯一放行点 |
| GitHub Integration（v0.2 计划 ⑤） | 从"只覆盖分支/PR"扩展为"分支/PR + 部署监控"，本方案即它的落地设计 |

## 7. 失败与回滚

- **测试部署失败**：不进验收；卡片给出失败步骤与链接；人可让 harness 重推（`测试部署` 幂等）。
- **线上发布失败**：卡片告警 + 链接；回滚按各项目自己的约定（通常是 revert main 或重跑上一个成功的 workflow），harness 只负责把结果反馈出来。
- **harness 离线**：不影响 GitHub 的部署（部署由 push/merge 事件触发，不依赖 harness 在线）；恢复后补上状态与卡片。

## 8. 安全

- 部署凭证（测试/线上环境）只存在于**各项目仓库的 GitHub Secrets**；harness 不持有、不传输。
- harness 的 GitHub 凭证按第 5.1 节最小权限，且应可随时撤销（App 卸载即失效）。
- harness 现有原则不变：agent 容器不持有任何仓库凭证；推送/合并都在宿主机、由 harness 自己执行。

## 9. 验收（可执行）

1. 推 `test/<deliveryId>` 后，对应仓库的 `deploy-test` workflow 被触发；harness 卡片在一跳内变成"部署中"。
2. workflow 成功 → 卡片给出测试环境 URL 与 run 链接；失败 → 卡片给出失败步骤与链接，且不进入验收。
3. 验收通过 → PR 被合并到 main，`deploy-prod` 被触发，卡片反馈上线结果。
4. 验收不通过 → main 不变。
5. harness 全程不接触任何部署凭证（检查 harness 的环境变量与 Secrets）。

## 10. 开关与回滚

- 每个仓库可单独关闭"测试分支自动推送"（回到纯人工）。
- 关闭 GitHub 驱动部署即回到旧行为：`AI_PREVIEW_MODE` 与预览主机路径仍在，可临时作为证据通道。

## 11. 适用范围：x-harness 自身除外（直接部署）

本方案适用于**被 harness 驱动的项目仓库**（例如 x-music）：推测试分支 → GitHub Actions
部署测试环境 → 验收后合并 main 触发上线。

**x-harness 自己不走这条路**，直接部署：

```bash
AI_DEPLOY_HOST=root@<部署主机> deploy/deploy.sh
```

理由：harness 是自己的控制面，没有"再经一层 GitHub App 推分支 + 等 workflow"的必要；
它也不在 App 的安装范围内（`repository_selection: selected`）。直接部署链路
（typecheck + 测试 → build → rsync → npm ci → migrate → 重启）已经是它自己的发布流程。

因此：

- **不要**把 `i12n/x-harness` 加进 GitHub App 的安装范围；
- x-harness 不需要 `test/**` 分支，也不需要 `TEST_*` secrets；
- harness 内部的 `DeployService` 只对**已注册并被驱动的项目仓库**生效，控制面自身不注册为被驱动仓库。
