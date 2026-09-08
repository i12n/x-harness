# AI Coding Harness v0.1

可以。前面的方案有些“架构设计味道”太重了。**如果目标是现在就开始 coding，我建议重新收敛成一个可落地的 MVP，并且先把“多仓库 + Codex CLI + Task/Run/Loop”跑通。**

下面这版可以直接作为项目实施方案。

## 一、先确定目标

第一版只解决一个完整闭环：

```text
接收 Task
   ↓
判断 Task 是否可以执行
   ↓
选择 Repository
   ↓
创建独立 Workspace
   ↓
启动 Codex CLI
   ↓
Codex 修改代码
   ↓
运行 Verification
   ↓
生成 Result / Evidence
   ↓
进入 Review
```

然后由 Loop 持续负责：

```text
发现任务
→ 调度
→ 执行
→ 恢复
→ 重试
→ 推进状态
```

**暂时不做：**

* 多模型路由
* 多 Agent 协作
* Kafka / RabbitMQ
* Kubernetes
* RAG
* 向量数据库
* 自动部署
* 自动 Merge
* Web UI
* 复杂 DAG

---

## 二、整体架构

最终只保留 7 个核心模块：

```text
                    ┌──────────────┐
                    │ Task Intake  │
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │    Task      │
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │  Scheduler   │
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │     Run      │
                    └──────┬───────┘
                           ↓
                    ┌──────────────┐
                    │    Worker    │
                    └──────┬───────┘
                           ↓
              ┌────────────────────────┐
              │     Agent Adapter      │
              │                        │
              │       Codex CLI        │
              └───────────┬────────────┘
                          ↓
                    ┌──────────────┐
                    │ Verification │
                    └──────┬───────┘
                           ↓
                         Event
                           ↓
                          Loop
```

其中：

| 模块            | 职责           |
| ------------- | ------------ |
| Task          | 描述要做什么       |
| Scheduler     | 决定现在做哪个 Task |
| Run           | 记录一次执行       |
| Worker        | 实际执行 Run     |
| Agent Adapter | 对接 Codex CLI |
| Verification  | 判断代码是否真的完成   |
| Loop          | 让整个系统持续运行    |

---

## 三、多仓库模型重新收敛

不要一开始引入 `Project`、`TaskTarget`、复杂资源模型。

MVP 只需要：

```text
Repository
Task
Run
Workspace
```

关系：

```text
Repository
    │
    └── Task
          │
          └── Run
                │
                └── Workspace
```

### Repository

```yaml
id: repo-001

name: my-app

url: git@github.com:example/my-app.git

default_branch: main

local_path: ~/ai-repos/my-app

verification:
  - npm run lint
  - npm run typecheck
  - npm test
  - npm run build
```

另一个仓库完全独立：

```yaml
id: repo-002

name: payment-service

url: git@github.com:example/payment-service.git

default_branch: main

local_path: ~/ai-repos/payment-service

verification:
  - ./gradlew test
  - ./gradlew build
```

这样 Harness 可以管理：

```text
repo-001 → React
repo-002 → Java
repo-003 → Python
repo-004 → Go
```

**Repository 自己描述如何构建和验证。**

---

## 四、项目目录

Harness 本身：

```text
ai-harness/
│
├── src/
│   ├── task/
│   ├── repository/
│   ├── run/
│   ├── scheduler/
│   ├── worker/
│   ├── agent/
│   ├── workspace/
│   ├── verification/
│   ├── loop/
│   └── db/
│
├── config/
│   └── config.yaml
│
├── migrations/
│
├── tests/
│
├── scripts/
│
├── package.json
├── tsconfig.json
└── docker-compose.yml
```

第一版甚至**不需要拆成多个 npm package**。

先做成一个 Modular Monolith：

```text
ai-harness
     │
     ├── API
     ├── Scheduler
     ├── Worker
     ├── Agent
     └── CLI
```

等系统稳定以后再拆。

---

## 五、数据库

MVP 使用：

> **PostgreSQL**

只有 5 张核心表。

```text
repositories
tasks
runs
workspaces
events
```

### 1. repositories

```sql
CREATE TABLE repositories (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    url             TEXT NOT NULL,
    default_branch  TEXT NOT NULL DEFAULT 'main',
    local_path      TEXT NOT NULL,
    config          JSONB NOT NULL DEFAULT '{}',

    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);
```

### 2. tasks

```sql
CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,

    repository_id   TEXT NOT NULL
                    REFERENCES repositories(id),

    title           TEXT NOT NULL,
    description     TEXT NOT NULL,

    status          TEXT NOT NULL,

    priority        INTEGER NOT NULL DEFAULT 50,

    acceptance      JSONB NOT NULL DEFAULT '[]',
    constraints     JSONB NOT NULL DEFAULT '{}',

    max_attempts    INTEGER NOT NULL DEFAULT 3,

    created_at      TIMESTAMPTZ NOT NULL,
    updated_at      TIMESTAMPTZ NOT NULL
);
```

### 3. runs

```sql
CREATE TABLE runs (
    id              TEXT PRIMARY KEY,

    task_id         TEXT NOT NULL
                    REFERENCES tasks(id),

    status          TEXT NOT NULL,

    attempt         INTEGER NOT NULL,

    agent           TEXT NOT NULL,
    engine          TEXT NOT NULL,

    worker_id       TEXT,

    lease_until     TIMESTAMPTZ,

    started_at      TIMESTAMPTZ,
    finished_at     TIMESTAMPTZ,

    exit_code       INTEGER,

    result          JSONB,
    error           JSONB,

    created_at      TIMESTAMPTZ NOT NULL
);
```

### 4. workspaces

```sql
CREATE TABLE workspaces (
    id              TEXT PRIMARY KEY,

    run_id          TEXT NOT NULL
                    REFERENCES runs(id),

    repository_id   TEXT NOT NULL
                    REFERENCES repositories(id),

    path            TEXT NOT NULL,

    branch          TEXT NOT NULL,

    status          TEXT NOT NULL,

    created_at      TIMESTAMPTZ NOT NULL,
    removed_at      TIMESTAMPTZ
);
```

### 5. events

```sql
CREATE TABLE events (
    id          BIGSERIAL PRIMARY KEY,

    type        TEXT NOT NULL,

    task_id     TEXT,
    run_id      TEXT,

    payload     JSONB NOT NULL,

    created_at  TIMESTAMPTZ NOT NULL
);
```

---

## 六、Task 状态先简单一点

不要一开始搞十几个状态。

MVP：

```text
INBOX
  ↓
READY
  ↓
RUNNING
  ↓
VERIFYING
  ↓
REVIEW
  ↓
DONE
```

异常：

```text
READY
  ↓
RUNNING
  ↓
FAILED
  ↓
READY
```

阻塞：

```text
RUNNING
   ↓
BLOCKED
```

因此：

```text
INBOX
READY
RUNNING
VERIFYING
REVIEW
BLOCKED
FAILED
DONE
```

足够。

---

## 七、Run 状态

Run 和 Task 分开。

```text
QUEUED
  ↓
STARTING
  ↓
RUNNING
  ↓
VERIFYING
  ↓
SUCCEEDED
```

异常：

```text
FAILED
TIMED_OUT
CANCELLED
LOST
```

例如：

```text
TASK-001
│
├── RUN-001 FAILED
├── RUN-002 FAILED
└── RUN-003 SUCCEEDED
```

Task 最终：

```text
TASK-001 → REVIEW
```

---

## 八、Task 创建

先做 CLI。

```bash
ai task create \
  --repo repo-001 \
  --title "Add user avatar"
```

或者交互式：

```bash
ai task create
```

输入：

```text
Title:
Add user avatar

Description:
Allow users to upload avatars.

Acceptance:
- JPG supported
- PNG supported
- Maximum 5MB
- Tests pass
```

数据库：

```text
TASK-001
repository = repo-001
status = INBOX
```

---

## 九、Task Intake

创建 Task 后不要直接执行。

执行：

```text
INBOX
  ↓
Validate
```

检查：

```text
Repository 是否存在
Task 是否有 Description
Acceptance 是否存在
Repository 是否可访问
Git 是否正常
Workspace 是否可创建
```

成功：

```text
INBOX → READY
```

失败：

```text
INBOX → BLOCKED
```

---

## 十、Scheduler

Scheduler 是 MVP 的核心。

它只做：

```text
找 READY Task
→ 检查是否有可用 Worker
→ 创建 Run
→ 将 Run 放入执行状态
```

例如：

```typescript
async function schedule() {
    const tasks = await taskRepository.findRunnable();

    for (const task of tasks) {

        if (!capacityAvailable()) {
            break;
        }

        await createRun(task);
    }
}
```

---

## 十一、并发控制

MVP：

```yaml
scheduler:
  max_concurrency: 2
```

意味着：

```text
Worker-1 → TASK-001
Worker-2 → TASK-002

TASK-003 → READY
TASK-004 → READY
```

不要一开始做复杂资源调度。

---

## 十二、Run Lease

这是必须实现的。

创建 Run：

```text
worker_id = worker-001
lease_until = now + 30s
```

Worker 每 10 秒：

```text
heartbeat
```

如果 Worker 崩溃：

```text
lease expired
       ↓
RUN = LOST
       ↓
Loop
       ↓
retry
```

这样 Harness 才能真正恢复。

---

## 十三、Worker

Worker 是一个简单进程：

```text
Worker
  ↓
claim Run
  ↓
create Workspace
  ↓
build Context
  ↓
start Codex
  ↓
collect Result
  ↓
Verification
  ↓
save Result
```

伪代码：

```typescript
async function execute(run: Run) {

    const workspace =
        await workspaceManager.create(run);

    const context =
        await contextBuilder.build(run, workspace);

    const result =
        await codex.execute(context);

    const verification =
        await verifier.run(run, workspace);

    await runRepository.complete(
        run,
        result,
        verification
    );
}
```

---

## 十四、Workspace

一个 Run 一个 Worktree：

```text
~/ai-workspaces/
└── TASK-001/
    └── RUN-003/
```

执行：

```bash
git worktree add \
  ~/ai-workspaces/TASK-001/RUN-003 \
  -b ai/TASK-001-RUN-003
```

Codex：

```text
cwd =
~/ai-workspaces/TASK-001/RUN-003
```

这样：

```text
RUN-001 → workspace A
RUN-002 → workspace B
RUN-003 → workspace C
```

互不污染。

---

## 十五、Codex Adapter

这里严格隔离 Codex。

```typescript
interface AgentEngine {

    execute(
        context: AgentContext
    ): Promise<AgentResult>;

    cancel(
        runId: string
    ): Promise<void>;
}
```

实现：

```text
AgentEngine
    │
    └── CodexEngine
```

以后：

```text
AgentEngine
├── CodexEngine
├── ClaudeEngine
└── GeminiEngine
```

Harness 其他代码完全不需要修改。

---

## 十六、Codex 执行

第一版只需要一个入口。

```bash
codex exec
```

由 Harness：

```typescript
spawn(
    "codex",
    args,
    {
        cwd: workspace.path
    }
)
```

关键点：

> **不要让 Codex 决定 Harness 的状态。**

Codex 结束：

```text
process exited
```

只意味着：

```text
Agent execution finished
```

不意味着：

```text
Task completed
```

---

## 十七、Context Builder

Harness 给 Codex 的输入由四部分组成：

```text
Task
+
Repository Context
+
Project Instructions
+
Acceptance Criteria
```

例如：

```text
AGENTS.md
PROJECT.md
Task description
Acceptance criteria
Repository configuration
```

最终：

```text
ContextBuilder
      ↓
AgentContext
      ↓
Codex
```

Repository 自己负责：

```text
AGENTS.md
PROJECT.md
docs/
```

Harness 负责把相关内容组装进去。

---

## 十八、Verification

Repository 配置：

```yaml
verification:
  commands:
    - npm run lint
    - npm run typecheck
    - npm test
    - npm run build
```

Worker 执行：

```text
Codex
 ↓
Verification
 ├── lint
 ├── typecheck
 ├── test
 └── build
```

结果：

```json
{
  "passed": true,
  "checks": [
    {
      "name": "lint",
      "status": "passed"
    },
    {
      "name": "test",
      "status": "passed"
    },
    {
      "name": "build",
      "status": "passed"
    }
  ]
}
```

---

## 十九、失败处理

如果测试失败：

```text
RUN-001
   ↓
Verification Failed
   ↓
RUN-001 = FAILED
   ↓
attempt < max_attempts?
```

如果：

```text
attempt = 1
max = 3
```

那么：

```text
RUN-001 FAILED
       ↓
RUN-002
       ↓
Codex
       ↓
Verification
```

第三次失败：

```text
RUN-003 FAILED
       ↓
Task = BLOCKED
```

而不是无限循环。

---

## 二十、Loop

Loop 只有四件事：

```text
Observe
Reconcile
Schedule
Recover
```

具体：

```typescript
async function tick() {

    await reconcileTasks();

    await reconcileRuns();

    await recoverLostRuns();

    await scheduler.schedule();
}
```

然后：

```typescript
while (true) {

    await tick();

    await sleep(1000);
}
```

---

## 二十一、Reconcile

这是 Loop 最重要的能力。

例如：

```text
Task = READY
没有 Active Run
```

则：

```text
→ 创建 Run
```

例如：

```text
Run = RUNNING
Lease 已过期
```

则：

```text
→ LOST
```

例如：

```text
Run = SUCCEEDED
Verification = PASSED
```

则：

```text
→ Task = REVIEW
```

例如：

```text
Run = FAILED
attempt < max
```

则：

```text
→ Task = READY
```

---

## 二十二、Event

所有状态变化写 Event：

```text
TaskCreated
TaskReady
RunCreated
RunStarted
AgentStarted
AgentFinished
VerificationStarted
VerificationPassed
VerificationFailed
RunSucceeded
RunFailed
RunLost
TaskReview
TaskDone
```

例如：

```json
{
  "type": "VerificationFailed",
  "task_id": "TASK-001",
  "run_id": "RUN-002",
  "payload": {
    "command": "npm test",
    "exit_code": 1
  }
}
```

Loop 可以通过 Event 被唤醒。

但即使 Event 丢了：

```text
Periodic Reconcile
```

也可以恢复。

所以：

```text
Event-driven
+
Periodic reconciliation
```

---

## 二十三、整个执行流程

最终：

```text
                    User
                     │
                     ▼
               ai task create
                     │
                     ▼
                   Task
                     │
                     ▼
                  INBOX
                     │
                  Validate
                     │
                     ▼
                   READY
                     │
                     ▼
                 Scheduler
                     │
                     ▼
                   Run
                     │
                     ▼
                  Worker
                     │
                     ▼
                Workspace
                     │
                     ▼
                Context Builder
                     │
                     ▼
                 Codex CLI
                     │
                     ▼
                 Code Change
                     │
                     ▼
                Verification
                  │        │
                PASS      FAIL
                  │        │
                  ▼        ▼
              REVIEW     Retry
                  │
                  ▼
                Human
                  │
                  ▼
                 DONE
```

---

## 二十四、实施顺序

不要同时开发所有模块。

按下面顺序做。

### Phase 1：Repository

实现：

```text
repository create
repository list
repository show
```

验收：

```text
能够注册多个不同 Repository。
```

---

### Phase 2：Task

实现：

```text
task create
task list
task show
```

验收：

```text
Task 能绑定 Repository。
```

---

### Phase 3：Workspace

实现：

```text
createWorktree()
removeWorktree()
```

验收：

```text
每一个 Run 都有独立 Git Worktree。
```

---

### Phase 4：Codex Adapter

实现：

```text
CodexEngine.execute()
```

先不要 Scheduler。

手动：

```bash
ai run TASK-001
```

验收：

```text
Harness
→ Workspace
→ Codex
→ 修改代码
→ 返回结果
```

---

### Phase 5：Verification

加入：

```text
lint
test
build
```

验收：

```text
Codex 完成 ≠ Run 成功

只有 Verification 全部通过
Run 才能 SUCCEEDED。
```

---

### Phase 6：Worker

把：

```text
ai run
```

变成：

```text
Worker
```

实现：

```text
claim
execute
heartbeat
complete
```

---

### Phase 7：Scheduler

实现：

```text
READY Task
     ↓
Scheduler
     ↓
Run
```

加入：

```text
max_concurrency
```

---

### Phase 8：Loop

实现：

```text
Observe
Reconcile
Schedule
Recover
```

至此：

> **第一个真正的 AI Coding Harness MVP 完成。**

---

## 二十五、第二阶段再增加

MVP 跑通以后，再增加：

```text
          v0.1
           │
           ▼
       Single Agent
           │
           ▼
      Codex CLI
           │
           ▼
     Single Repository
```

然后：

```text
          v0.2
           │
           ├── Multi Repository Task
           ├── Dependency DAG
           ├── Reviewer Agent
           ├── Human Approval
           └── GitHub Integration
```

再以后：

```text
          v0.3
           │
           ├── Multiple Agent Engines
           ├── Agent Profiles
           ├── Policy Engine
           ├── Resource Scheduling
           ├── Remote Workers
           └── Web UI
```

最后才考虑：

```text
          v1.0
           │
           ├── Multi Project
           ├── Distributed Workers
           ├── Advanced Context
           ├── Long-term Memory
           ├── Self-improvement
           └── Governance
```

---

## 二十六、最终的技术边界

这套方案最重要的是把几个容易混淆的概念彻底分开：

```text
┌──────────────────────────────────────┐
│              Harness                 │
│                                      │
│  Task       → 工作                   │
│  Scheduler  → 调度                   │
│  Run        → 一次尝试               │
│  Worker     → 执行                   │
│  Workspace  → 隔离                   │
│  Agent      → AI 行为                │
│  Codex      → Agent Engine           │
│  Verify     → 证明                   │
│  Loop       → 状态收敛               │
│  Event      → 历史                   │
└──────────────────────────────────────┘
```

而多仓库只是：

```text
Harness
   │
   ├── Repository A
   │      ├── Task
   │      └── Run
   │
   ├── Repository B
   │      ├── Task
   │      └── Run
   │
   └── Repository C
          ├── Task
          └── Run
```

**因此第一版不要试图解决“所有 AI Agent 问题”。**

先完成这条可验证链：

> **Repository → Task → Run → Workspace → Codex CLI → Verification → Review**

然后再用 Loop 把它自动化：

> **Observe → Reconcile → Schedule → Execute → Verify → Recover**

这才是最适合直接进入 coding 阶段的版本。
