# Phase 10 — Multi Repository Task（设计稿）

> 状态：**已定稿**（2026-09-19）。5 个开放问题已拍板：
> ① `role` 只保留 primary/supporting；② 同一 Task 内禁止同一 Repository 出现两次；
> ③ `required` v1 固定 true；④ 跨仓库关联验证延后到 DAG，v1 只做 Target 独立
> 验证 + Run 聚合；⑤ v1 不做 Workspace 复用，每次 Run/Retry 全新 Workspace。

## 进度（滚动更新）

- TASK-1002 ✅：`migrations/005_task_targets.sql`（task_targets + 回填
  `tgt-<taskId>` + workspaces.task_target_id + executions.mounts）
- TASK-1003 ✅：`src/domain/taskTarget.ts`（primary/supporting、position、
  baseRef、required 恒 true）+ `Task.targets` 兼容映射（`repositoryId` 派生自
  primary）；内存/Postgres store 均支持多 target（事务写入、按 position 读取）
- TASK-1004 ✅：`createTask` 支持 `targets[]`（缺省用 `repositoryId` 生成单个
  primary），`findTask`/`listTasks` 返回 targets；CLI 仍走单仓库路径（零迁移）
- TASK-1005 ✅：`WorkspaceManager.createRunWorkspaces()` ——
  `<base>/<taskId>/<runId>/<targetId>/`，每个 target 独立分支
  `ai/<task>-<run>-t<position>`，按 position 顺序创建，支持 `baseRef`，
  v1 不复用（新 Run = 全新目录），Run 级清理逐个 workspace；
  旧 `createWorkspace()` API 保留（单仓库路径零迁移）
- 回归：单测 122 passed；Postgres 集成 4 passed（含多 target round-trip）；
  真实 codex E2E passed（单仓库零迁移）
- TASK-1006 ✅：Execution 多挂载 —— `ExecutionMount{targetId, source, target,
  readOnly?, primary?}`；Run 层决定 primary→`/workspace`、supporting→
  `/workspaces/<targetId>`，Docker 层只把 `mounts[]` 翻译成 `--mount`（无 role
  业务逻辑）。校验规则：target 必须位于 `/workspace*`、source 必须绝对且在
  允许的 workspace roots 内、container target 不重复、恰好一个 primary、
  `primaryTargetId` 与 primary mount 一致。`ExecutionContext` 增加
  `workdirs`/`primaryTargetId`，`workdir` 保持 = primary（legacy API 不变）；
  mounts 持久化到 `executions.mounts` 供 recovery 使用
- 回归：单测 137 passed；Postgres 集成 4 passed；真实 codex E2E passed；
  **Phase 9 真机 Docker 验收重跑 12 passed / 1 skipped**（单挂载路径无回归）
- 下一步：TASK-1007 Multi-Repository Context →
  TASK-1007 Context → TASK-1008 Target 级 Verification → TASK-1009 Worker →
  TASK-1010 Retry/Recovery → TASK-1011 CLI → TASK-1012 真机多挂载验收
>
> 目标：一个 Task 可以同时操作多个 Repository；**不**引入 Task 之间的依赖
> 调度（那是 Dependency DAG，Phase 11）。

## 0. 一句话边界

```text
Multi Repository  = 一个 Task 横跨多个仓库（本阶段）
Dependency DAG    = 多个 Task 之间互相依赖（下一阶段）
```

本阶段只解决前者。Scheduler 仍是 Task 级调度，不感知依赖。

## 1. 现状与目标

现状：

```text
Task ── repository_id ──> Repository
Run  ── 1 Workspace（git worktree） ──> 1 Container
Verification = 该 Repository 的 verification commands
```

目标：

```text
Task
 └── Targets[]
      ├── Target A (Repository A, role=primary)
      ├── Target B (Repository B)
      └── Target C (Repository C)
                 ↓
Run
 ├── Workspace A + Workspace B + Workspace C   （worktree per target）
 └── Execution（1 Container，多挂载）            （见 §5）
                 ↓
Verification：按 Target 执行，Run 聚合判定
```

## 2. Domain Model

### 2.1 TaskTarget（新）

```ts
interface TaskTarget {
  id: string;              // task-target-<...>
  taskId: string;
  repositoryId: string;
  role: "primary" | "supporting";   // 恰好一个 primary
  position: number;                  // 稳定顺序（0 = primary）
  baseRef?: string;                  // 分支/commit；缺省 = repository.defaultBranch
  required: boolean;                 // v1 恒为 true（保留字段，见 §6.4）
  createdAt: string;
}
```

约定：

- **同一 Task 内 repository 不重复**（重复仓库没有意义，且会导致分支冲突）
- 恰好一个 `role=primary`；单仓库 Task = 一个 primary target
- v1 不允许 Target 覆盖 repository 的 verification/execution profile；
  目标级覆盖（`verification`、`profile`）作为扩展字段预留，不进 v1

### 2.2 Task（增量，兼容）

```ts
interface Task {
  ...existing;
  targets: TaskTarget[];       // 新字段；永远按 position 排序，至少一个
  repositoryId: string;        // 兼容字段 = primary target 的 repositoryId
}
```

`repositoryId` 保留为 **派生的主仓库**（primary target），由写入路径维护，
避免一次性迁移所有调用方；v0.3 再考虑移除。

## 3. State Model

Task / Run 的状态机**不变**（INBOX…DONE；QUEUED…LOST）。

新增的是 **Target 级结果**（只存在于 Run 的 evidence 里，不引入新状态机）：

```ts
interface TargetRunResult {
  targetId: string;
  repositoryId: string;
  role: "primary" | "supporting";
  workspacePath: string;      // host worktree
  containerPath: string;      // 容器内路径
  branch: string;
  agentExitCode: number | null;
  verification: {
    passed: boolean;
    checks: VerificationCheck[];
  };
  changedFiles: string[];     // git status --porcelain 解析
  error?: unknown;
}
```

Run 聚合规则（v1，不引入 PARTIAL 状态）：

```text
Run SUCCEEDED  ⇔  所有 targets: agent exit 0 ∧ verification.passed
否则 Run FAILED（run.result.targets[] 保留每个 target 的细节）
Agent 失败（非 0 退出）与 Verification 失败的区分保留在 target 记录里
```

## 4. Run / Workspace Model

### 4.1 一一对应

```text
Run 1 ── * Workspace     （每个 TaskTarget 一个 worktree）
Run 1 ── 1 Execution     （一个容器挂载所有 workspace，见 §5）
```

`workspaces` 表新增 `task_target_id`，唯一约束 `(run_id, task_target_id)`。

### 4.2 目录与分支

```text
~/ai-workspaces/<taskId>/<runId>/<targetId>/     # host worktree
容器内：/workspaces/<targetId>/                    # 非 primary
        /workspace                                 # primary（保持兼容）
分支：ai/<taskId>-<runId>                          # 每个 repo 一份，互不冲突
       （同一 task 内 repository 不重复，故分支名可复用）
```

primary 挂到 `/workspace` 是为了兼容现有 Verification/Context 的默认路径；
其余 target 挂到 `/workspaces/<targetId>`。

### 4.3 部分失败

v1：任一 required target 失败 → Run FAILED；Task 按现有规则
`attempt < maxAttempts → READY`，否则 `BLOCKED`。
部分成功的信息不丢：保存在 `run.result.targets[]` 与事件 payload 中。

## 5. Execution 模型（多挂载）

一个 Run 只用一个 Execution / 容器，多挂载：

```ts
interface ExecutionRequest {
  runId: string;
  profile: ExecutionProfile;
  mounts: {
    targetId: string;
    hostPath: string;        // worktree
    containerPath: string;   // /workspace 或 /workspaces/<id>
    primary: boolean;
  }[];
}
```

- 容器隔离边界仍是"一个 Run 一个容器"：同一 Run 的 target 共享网络/进程
  边界（它们本来就是同一个任务的协作仓库），但**不**跨 Run
- `ExecutionContext` 增加 `workdirs: Record<targetId, containerPath>` 与
  `primaryTargetId`；`workdir` 保留 = primary 路径（向后兼容）
- `ExecutionDriver.exec()` 不变：调用方用 `options.cwd` 指定目标 workspace

## 6. Context / Verification / Git / Retry

### 6.1 Context 模型

prompt 增加 "Targets" 段落，逐个 target 给出：

```text
- [primary] my-app  (git@github.com:example/my-app.git)  branch ai/TASK-1-RUN-1
  workspace: /workspace   instructions: /workspace/AGENTS.md …
- [supporting] shared-lib  (...)  workspace: /workspaces/<targetId>
```

每个 target 的项目指令文件（AGENTS.md / PROJECT.md / docs/*.md）分别收集，
总量仍受上限约束；跨仓库的"全局约束"来自 Task.constraints。

### 6.2 Verification 模型

```text
Target.verification = Repository.verificationCommands（v1 不做覆盖）
执行位置 = 该 target 的容器内 workspace（cwd = containerPath）
聚合 = 所有 target 的 checks 都 passed → Run 成功
```

跨仓库联动测试（例如 "A 的接口必须被 B 调通"）v1 **不做**：把它挂到 primary
target 的 verification 命令里（脚本内部自行处理）；等 DAG 阶段再引入跨 Task/
跨仓库的编排。

### 6.3 Git 模型

- 每个 target 独立 worktree + 独立分支，基线 = `baseRef ?? defaultBranch`
- v1 仍不自动 commit / push（与现状一致）；evidence 记录每个 target 的
  `git status --porcelain` 与 diff stat
- 分支/提交的后续处理（commit、PR）属于 GitHub Integration 阶段

### 6.4 Retry 模型

- 重试 = 新 Run（attempt+1），所有 target 的 workspace **重新创建**
- v1 不做 workspace 复用；复用需要满足"起点相同 + 无未提交变更 + target 集合
  相同"，作为后续优化
- `required=false` 字段保留但 v1 恒为 true；等有真实用例再定义"可选 target
  失败不阻塞 Run"的语义

## 7. Backward Compatibility（零迁移成本）

1. 迁移 `005_task_targets.sql`：
   - `task_targets(task_id, repository_id, role, position, base_ref, required, created_at)`
   - 从现有 `tasks.repository_id` 回填一条 `role=primary, position=0`
   - `workspaces` 增加 `task_target_id` 列（旧行为 Run 一个 workspace）
2. 领域层：`CreateTaskInput.repositoryId` 继续可用；缺省自动生成单个 primary
   target。`Task.repositoryId` 变为派生字段（primary）
3. 现有 CLI `ai task create --repo <id>` 行为不变；新增 `--repo` 可重复，
   第一个为 primary
4. 现有测试与真机验收（单仓库）必须原样通过，作为 Phase 10 的回归门槛

## 8. API / CLI（v1）

内部 API（TypeScript）：

```ts
createTask({ repositoryId, targets?: [{ repositoryId, baseRef? }], ... })
// targets 缺省 → [primary(repositoryId)]
```

CLI：

```bash
# 单仓库（不变）
ai task create --repo repo-001 --title "..." 

# 多仓库：第一个 --repo 为 primary
ai task create --repo repo-001 --repo repo-002 --title "..." \
  --base-ref repo-002=release/2.1

# 展示
ai task show <id>          # 列出 targets + role + baseRef
ai run <task-id>           # 打印每个 target 的 workspace/verification
```

## 9. Migration

```sql
-- 005_task_targets.sql
CREATE TABLE task_targets (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  role TEXT NOT NULL,
  position INTEGER NOT NULL,
  base_ref TEXT,
  required BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (task_id, repository_id)
);
INSERT INTO task_targets (id, task_id, repository_id, role, position, required, created_at)
SELECT 'tgt-' || id, id, repository_id, 'primary', 0, TRUE, created_at FROM tasks;

ALTER TABLE workspaces ADD COLUMN task_target_id TEXT REFERENCES task_targets(id);
ALTER TABLE executions ADD COLUMN IF NOT EXISTS mounts JSONB;
```

回滚策略：新列/新表只增不删；代码回退时旧路径继续用 `tasks.repository_id`。

## 10. Acceptance Criteria（Phase 10）

1. 单仓库 Task：现有单测 + 真机 Docker 验收 12/12 原样通过（零迁移）
2. 多仓库 Task：2+ 仓库、一个 Run、N 个 worktree、单容器多挂载
3. Agent 能同时修改 primary 与 supporting 仓库（prompt 含 Targets 段）
4. Verification 按 target 执行并按 target 记录结果；全过才算 Run SUCCEEDED
5. 任一 target 失败 → Run FAILED，`run.result.targets[]` 保留全部细节；
   Task 重试语义与现状一致
6. Cleanup：Run 结束/失败/LOST 后，所有 target 的 worktree 与容器都被回收
7. 隔离不回退：不同 Run 的 workspace 互不可见；网络策略按 Run 生效
8. 真机验收新增：多挂载矩阵（成功/单 target 失败/超时清理）

## 11. 任务拆分（TASK-1001…）

```text
TASK-1001  设计稿定稿（本文档）
TASK-1002  migration 005 + 回填脚本（task_targets / workspaces.task_target_id / executions.mounts）
TASK-1003  Domain：TaskTarget + Task.targets + 兼容映射
TASK-1004  Store：内存 + Postgres（含回填读取）+ 单测
TASK-1005  WorkspaceManager：每 target 一个 worktree（目录/分支/清理）
TASK-1006  Execution：多挂载（driver 参数、契约校验、ExecutionContext.workdirs）
TASK-1007  Worker：多 target 编排、per-target verification、聚合与失败语义
TASK-1008  Context Builder：Targets 段 + 每仓库指令文件
TASK-1009  CLI：--repo 可重复、--base-ref、show/run 输出 target 明细
TASK-1010  Events：run/target 维度 payload（targetId、repositoryId）
TASK-1011  单测 + Postgres 集成（单/多仓库回归）
TASK-1012  真机 Docker 多挂载验收（成功 / 部分失败 / 清理）
```

## 12. 待确认（进入编码前需要拍板）

1. `role` 语义 —— **已定**：v1 只保留 `primary / supporting`
2. 同一仓库重复出现 —— **已定**：禁止
3. `required=false` —— **已定**：v1 固定 `true`，不实现 optional target
4. 跨仓库验证 —— **已定**：延后到 DAG；v1 只做 Target 独立验证 + Run 聚合
5. workspace 复用 —— **已定**：v1 不做，每次 Run/Retry 全量重建
