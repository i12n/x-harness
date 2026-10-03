# TASK-1227 命令自举与预览构建隔离

> 来源：TASK-1226 上线后暴露的两件事（用户明确要求修）：
> ① 仓库没声明 `npm ci` 之类的命令时，harness 不该因此失败，应当**自动补上**；
> ② 预览构建写在**保留中的评审 worktree** 里，把它从 7M 撑到 615M。
>
> 说明：此前把"预览主机（live preview）"预留在 TASK-1227，现让位给本任务，
> live 预览改为 **TASK-1228**。

## 1. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 命令从**仓库内容**推导：lockfile → 包管理器 → `install` / `build` / `test`；`test` 同时作为**验证命令**候选 | "没配置"不等于"坏掉"；验证门禁也需要一条真实命令，否则必然 FAIL |
| D2 | **显式配置永远优先**：只补空缺，不覆盖人工设置 | 人工判断高于猜测 |
| D3 | 自举发生在三处：`repository sync`（新拉取的仓库）、`serve` 启动 preflight（存量仓库）、**预览构建前**（保底） | 覆盖"已注册但当时没有命令"的存量 |
| D4 | 预览在 worktree 的**一次性副本**里构建（排除 node_modules/.next/dist/build），构建后删除 | 评审件保持干净；磁盘成本可控 |
| D5 | 截图在删除副本前**另存**到 `_preview-artifacts/<deliveryId>/` | 证据要能活过清理 |
| D6 | 识别不出命令时**不报失败**，只在证据里写明原因 | 与 TASK-1226 "失败不阻塞" 一致 |

## 2. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/repository/application/commandDetection.ts` | `detectCommands` / `detectCommandsFromDirectory` / `mergeDetectedCommands` |
| `src/preview/application/previewService.ts` | 构建前检测并合并命令；`PreviewWorkspaceFs` 端口（默认 tar 复制 + 清理 + 截图另存） |
| `src/cli/index.ts` | `repository sync` 后自动补全；`preview build` CLI 入口（TASK-1226 漏的） |
| `src/server/index.ts` | 启动 preflight 给存量仓库补全并打印补了什么 |

## 3. 验收（可执行）

1. `package.json` + `package-lock.json` → `npm ci` / `npm run build` / `npm test`，
   且 `verify = npm test`。
2. pnpm / yarn / bun 的 lockfile → 对应的 `install --frozen-lockfile`。
3. 没有 build/test 脚本 → 只给 install，并写明原因。
4. 不是 Node 工程 → 明确说明"需要人工配置"，**不报错**。
5. 已配置的命令不被覆盖（`mergeDetectedCommands`）。
6. 预览构建使用副本目录，构建后副本被删除，截图被另存。

## 4. 回滚

检测是纯函数并由 port 注入；去掉调用点即回到"必须人工声明命令"的行为。
