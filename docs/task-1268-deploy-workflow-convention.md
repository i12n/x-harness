# TASK-1268 部署工作流约定 + 接入强制校验

> 现场证据：§1（2026-10-10 生产库 `events` 799/804 + 测试主机容器事实）。
> 相关：TASK-1230（GitHub App 只读观测）、TASK-1231（部署监控）、TASK-1255（生产部署确认后才 RELEASED）、TASK-1256（已合并不重推测试环境）。

## 1. 现场

用户收到「测试环境就绪：dlv-9121521df0 / http://47.100.5.48:18080/」，
刷新页面却没有任何变化。

事实（2026-10-10，CST）：

- 12:26:22 harness 推 `test/dlv-9121521df0` 并开 PR #6；此刻该分支上并发产生
  三条 run（同一 head_sha `99f0f6fb`）：
  - `38024066961` Deploy app to test environment（push）→ 12:30:25 完成 ✓
  - `38024069038` Application checks（pull_request）
  - `38024069099` Documentation checks（pull_request）→ 12:26:37 完成 ✓（11 秒）
- 12:26:53 harness 记录 `TestDeploySucceeded`，`run` 指向 **38024069099
  （Documentation checks）**，飞书卡片因此说"测试环境就绪"。
- 测试主机 12:30:01 才构建出新镜像、12:30:11 才重建容器。用户在 12:26~12:30
  之间刷新，看到的仍是 11:15:48 的旧镜像。

生产路径是同一个根因：`ReleaseConfirmed`（09:15:42）记录的 run `38012128825`
同样是 Documentation checks，而不是同一秒创建的 `Deploy app to VPS`
（`38012128844`）。这次 VPS 部署碰巧也成功，所以没暴露——**只要文档检查通过，
即使线上部署失败，交付也会被标记为已上线**。

## 2. 根因

`DeployService.statusOn()` / `productionStatus()` 调
`github.listWorkflowRuns({repo, branch})`，也就是
`/repos/{repo}/actions/runs?branch=…`——**该分支上所有工作流**——再按
`createdAt >= sinceMs` 取第一条。选择里没有"工作流"这一维，一次 push 触发的
多条 run 谁先完成谁就可能被当成部署结果。

## 3. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 部署工作流按**约定命名**：`deploy-test.yml` / `deploy-prod.yml` | 这个约定早就写在 `docs/test-environment-deployment-plan.md` §3，只是从未被执行 |
| D2 | 约定是**接入 harness 的硬性前提**，不符合不让接入 | 让"仓库怎么部署"在接入时就说清楚，而不是等到部署阶段靠猜 |
| D3 | harness 只按约定名取 run，不退回"最新一条" | 猜错比找不到更危险：猜中一条非部署工作流就会误报 |
| D4 | 约定工作流不存在 → 显式 `unconfigured`，不产出成功、不写 release | 失败必须可见，不能静默停摆 |

## 4. 约定

| 文件 | 触发 | harness 用途 |
| --- | --- | --- |
| `.github/workflows/deploy-test.yml` | push 到 `test/**`（建议同时支持 `workflow_dispatch`） | 测试环境部署结论 + 测试环境 URL |
| `.github/workflows/deploy-prod.yml` | push 到默认分支（建议同时支持 `workflow_dispatch`） | 上线结论；成功才写 RELEASED |

工作流内部做什么（部署到哪台机、用什么凭证）仍完全属于仓库自己，harness 只看
结论与链接。

## 5. 接入检查（硬性）

落点：`ai repository create` 与 `ai repository update` 共用
`gateRepositoryDeployWorkflows`（形状参考现有 `gateRepositoryProfile`）。聊天侧没有
仓库注册命令（只有 list/show），所以入口只有 CLI 这两个。**不放进
`createRepositoryCommand`（Node API）本身**，否则 demo 脚本与单测都要联网。
本机没配 GitHub 凭据时打印提示并跳过——那种情况下部署本来也观测不了。

检查步骤（仅对 GitHub 远程有意义；`file://` 等非 GitHub 远程跳过并记一条提示）：

1. `GET /repos/{owner}/{name}/actions/workflows` 可读（读不到 = 凭据/权限/仓库
   不可达 → 拒绝）。
2. 存在 `path = .github/workflows/deploy-test.yml` 且 `state = active`。
3. 存在 `path = .github/workflows/deploy-prod.yml` 且 `state = active`。
4. 用 Contents API 读这两个文件并解析：`deploy-test.yml` 的
   `on.push.branches` 覆盖 `test/**`；`deploy-prod.yml` 覆盖默认分支。
5. 缺失 `workflow_dispatch` 只警告（方便人工重跑），不阻断。

拒绝时的输出必须能直接行动：列出该仓库实际存在的工作流（名称 + 文件路径），
并说明"改名或新建后重新接入"。

### 实现落点

| 文件 | 改动 |
| --- | --- |
| `src/deploy/domain/deployWorkflow.ts` | 约定常量 + `on.push.branches` 触发校验（`*` 不跨 `/`，`**` 跨） |
| `src/deploy/application/deployWorkflowGate.ts` | `collectDeployWorkflowIssues` / `gateRepositoryDeployWorkflows`；非 GitHub 远程跳过 |
| `src/cli/index.ts` | `--skip-deploy-check`；create/update 调门禁；无凭据时提示并跳过 |
| `src/github/githubClient.ts` / `httpGithubClient.ts` | `listWorkflowRuns({workflow,event})`、`listWorkflows`、`readFile`；run 补 `path/event/headSha`；PR 补 `mergeCommitSha`；失败抛带 status 的 `GitHubRequestError` |
| `src/deploy/application/deployService.ts` | 按 `kind` 选约定工作流 + `event=push` + `headSha`；工作流 404 → `unconfigured`；推测试分支前先确认工作流存在 |
| `src/deploy/infrastructure/gitBranchPublisher.ts` | 推送结果带上 commit sha（供监听钉住 run） |
| `src/channel/rendering/deploy.ts` | `unconfigured` 文案：明确说无法确认，不当作成功 |

## 6. 运行时选 run

| 场景 | 工作流 | 分支 | 事件 | 锚定 |
| --- | --- | --- | --- | --- |
| 测试 | `deploy-test.yml` | `test/<deliveryId>` | push | 本次 push 的 commit sha |
| 生产 | `deploy-prod.yml` | 默认分支 | push | PR 的 merge commit sha |

客户端改为 `/repos/{repo}/actions/workflows/{file}/runs?branch=…&event=push`；
`GitHubWorkflowRun` 补 `path` / `event` / `headSha` 用于校验与卡片展示；
`gitBranchPublisher.publish` 返回值补 `sha`。事件维度是第二道保险（能顺带排掉
PR 触发的 checks，但单独不够用：`main` 上三条 run 全是 push），commit sha
是第三道（防止同分支上一次 push 的 run 混进来）。

找不到 run → `none`（Actions 还没排队）；工作流 404 → `unconfigured`，卡片给
可行动文案，且**绝不写成成功**。

## 7. x-music 对齐（改名）

现状：测试工作流已叫 `deploy-test.yml`；生产叫 `deploy-vps.yml`
（`Deploy app to VPS`），不符合约定。

改法：`git mv .github/workflows/deploy-vps.yml .github/workflows/deploy-prod.yml`，
并同步引用它的 12 个文件：`.env.example`、`Dockerfile`、
`docs/02-design/cloudflare-static.md`、`docs/02-design/ui-architecture.md`、
`docs/03-engineering/automation.md`、`docs/03-engineering/deployment.md`、
`docs/04-delivery/{active-sprint,changelog,next-task-review}.md`、
`docs/06-context/{current-focus,handoff,project-state}.md`。按 x-music 的
`AGENTS.md` 需要带任务 ID（`MUS-xxx`）并更新上下文文档。

注意：

- GitHub 把改名视为"删一个 workflow + 新建一个"：workflow id 会变，历史 run
  留在旧条目下。harness 不绑 id，所以无损。
- 若 main 的分支保护 / required checks 引用的是工作流**名**（"Deploy app to
  VPS"），改名会让合并卡住。App 权限读不到分支保护，需要人工确认一次。
- 改名提交本身会触发一次生产部署（`deploy-vps.yml` 自身在触发路径里），属于预期。

## 8. 测试与验收

1. 假客户端返回三条 run（部署 in_progress、app checks、docs success）→ 断言
   **永不出现 `succeeded`**（复现本次事故）。
2. 部署 run pending → success 时才 `succeeded`，且卡片 run 链接指向部署那条。
3. 生产：默认分支上 docs run 成功 → `released === false`。
4. 约定工作流 404 → `unconfigured`，无 success、无 release。
5. 接入检查：缺 `deploy-prod.yml` 的仓库被拒绝，报错列出实际工作流；`file://`
   仓库跳过检查。
6. `npm run typecheck`、`npm test` 通过。

## 9. 不做（边界）

- 不做"名字不像就猜一个"的兜底：找不到宁可 `unconfigured`。
- 不按工作流 `name`（自由文本、中英混杂）匹配。
- 不引入 GitHub Deployments / environments：可作为后续更强的接入检查项，但
  不是本次。
- 不让 harness 参与部署本身：部署仍归各仓库的 Actions。
