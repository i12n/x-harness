# 真机部署 + 飞书机器人控制开发（runbook）

> 目标：把 Harness 作为常驻服务部署到真机，用飞书群/私聊驱动
> Problem → Specification → Task → Run → Verification → Review → Delivery。

## 1. 部署形态

```text
飞书（长连接，无需公网回调）
        │  im.message.receive_v1
        ▼
   FeishuLongConnection ──► ChatSession ──► Intent(LLM) ──► Command
        ▲                                                   │
        │                                                   ▼
   FeishuAdapter ◄── Renderer ◄── CommandResult ◄── Application Services
        │                                                   │
        │                                        LoopDaemon (tick)
        │                                                   │
        └──── RunChatNotifier ◄── Events ◄── Scheduler / Worker / Docker
```

进程只有一个：`ai serve`。它同时是**控制面**（飞书 + 命令 + 调度）和
**执行面**（Worker → per-Run 容器 → Codex → 验证）。

主机清单（本次部署的目标机器）：

| 项目 | 值 |
| --- | --- |
| 主机 | `root@<部署主机>`（Linux 6.8 / 2 vCPU / 1.9 GB 的 VPS） |
| 部署目录 | `/srv/ai-harness`（rsync 发布，无 `.git`） |
| 控制面数据库 | 容器 `ai-harness-db`，`127.0.0.1:55432`，volume `ai_harness_pg` |
| 执行面 | Docker，镜像 `harness/execution:node22` + `harness/execution-proxy:latest` |
| 代理 | `/root/.codex/config.toml`（provider=deepseek，`env_key=DEEPSEEK_API_KEY`） |
| 服务单元 | `/etc/systemd/system/ai-harness.service` |

> **关于占位符**：本文只写 `<部署主机>` / `<验收主机>` 这类占位符。真实主机地址、
> 账号 open_id、App ID 等集中记录在 **`docs/private/deployment-local.md`**——
> 那个目录被 `.gitignore` 忽略，不会进版本库。判断标准：能唯一指向一台真实
> 机器或一个真实账号的值放本地文档，协议、路径形状、配置项名字放这里。

**不影响同一台机器上的其它服务**：不新增对外端口、不改 Caddy、不共用
xmusic 的数据库与 volume。飞书事件走 WebSocket 长连接，出站即可。

## 2. 飞书应用配置（只需做一次）

1. 打开 <https://open.feishu.cn/app>，**创建企业自建应用**。
2. 应用能力 → 添加 **机器人**。
3. 权限管理，开通并发布以下权限：
   - `im:message`（读取用户发给机器人的消息）
   - `im:message:send_as_bot`（以应用身份发消息）
4. 事件与回调 → 事件订阅 → **使用长连接接收事件**（不要选“将事件发送至
   开发者服务器”，那样才需要公网 HTTPS 回调）→ 添加事件
   **接收消息 `im.message.receive_v1`**。
5. 事件与回调 → **回调订阅** → 同样选**使用长连接接收回调** → 添加回调
   **卡片回传交互 `card.action.trigger`**。没有它，机器人发出的可交互卡片
   （问题澄清的多选、评审卡的按钮）点了不会有任何反应，客户端还会报
   `200672`。
6. 版本管理与发布 → 创建版本 → 申请发布（企业自建应用通常需管理员审批）。
7. 凭证与基础信息 → 复制 **App ID / App Secret**。
8. 把这台机器上线后，把机器人拉进目标群或直接私聊它。

> 长连接模式由应用主动出站连到飞书，因此**不需要**公网 IP、域名、
> 证书或反向代理；服务器上已有 Caddy/域名也不用动。

## 3. 主机部署

```bash
# 本机（开发机）
deploy/deploy.sh                 # typecheck + test + build + rsync + migrate

# 真机（首次）
ssh root@<部署主机>
cd /srv/ai-harness
cp deploy/ai-harness.env.example deploy/ai-harness.env
vi deploy/ai-harness.env         # 填 FEISHU_APP_ID/SECRET、AI_LLM_API_KEY、DEEPSEEK_API_KEY
deploy/install.sh                # 建库 + 迁移 + 构建执行镜像 + 安装并启动 systemd 单元
```

`deploy.sh` 之后每次发布都会自动重启服务；`install.sh` 是幂等的，可重复执行。

**执行镜像**（TASK-1217）：`install.sh` 会构建 `harness/execution:node22`
（可用 `AI_EXECUTION_RUNTIME` / `AI_EXECUTION_BASE_IMAGE` 覆盖）和
`harness/execution-proxy:latest`，已存在则跳过；并把默认回退名
`harness/execution:base` 指向构建出来的镜像。职责固定为
**部署构建 → 注册校验 → Run 启动**：`ai repository create` 会在注册前用
`docker image inspect` 校验镜像，缺了直接拒绝（`--skip-image-check` 可跳过）；
`ai serve` 启动时也会逐仓库点名缺失的镜像。其它运行时（如 Java）用
`--exec-image harness/execution:<runtime>` 指定，并自行构建对应镜像。

### 必备环境变量

| 变量 | 说明 |
| --- | --- |
| `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 飞书自建应用凭证 |
| `AI_LLM_API_KEY` | 意图解析 + 问题分析用的 OpenAI 兼容 key |
| `DEEPSEEK_API_KEY` | Codex CLI 的 provider key（通常与上面同一个） |
| `AI_CODEX_CONFIG` | 容器内 `codex exec -c` 覆盖项（provider/base_url/model），见模板 |
| `DATABASE_URL` | 默认 `postgres://ai:ai@127.0.0.1:55432/ai_harness` |
| `FEISHU_ALLOWED_OPEN_IDS` | 白名单；**留空 = 拒绝所有人**（见下一节） |
| `AI_EXECUTION_DRIVER` | `docker`（真机隔离执行）或 `local` |
| `AI_DEFAULT_REPOSITORY_ID` | 用户没点名仓库时默认开发哪个 |

完整清单见 `deploy/ai-harness.env.example`。

## 3.1 配置只在聊天里做（没有 Web 控制台）

服务不再监听任何管理端口。全部配置项通过飞书机器人读写，落盘到 systemd 读的
同一个 `EnvironmentFile`（默认 `deploy/ai-harness.env`，0600，原子写入）。

| 你说 | 命令 | 说明 |
| --- | --- | --- |
| `查看配置` / `谁有权限` | `config.show` | 列出已设置项；密钥只显示「已设置」 |
| `有哪些仓库` / `看看 repo-demo 的配置` | `repository.list` / `repository.show` | 仓库与执行档案 |
| `现在有几个任务` / `有哪些在做的任务` | `task.list` | 按状态分组的任务 |
| `最近跑了什么` / `为什么失败了` | `run.list` | 最近运行与失败摘要 |
| `有哪些问题` | `problem.list` | 问题与待回答数 |
| `交付到哪一步了` | `delivery.list` | 交付聚合状态 |
| `把最大并发改成 1` | `config.set` | 任意非密钥项，模型翻译成命令 |
| `设置 FEISHU_APP_SECRET hydU…` | `config.setDirect` | **确定性格式**，见下 |
| `授权 ou_xxx 为 developer` / `移除 ou_xxx` | `access.grant` / `access.revoke` | 白名单合并式修改 |
| `重启服务` | `config.apply` | 先回话再重启，新配置生效 |

机器人会先判断这条消息是**查询 / 操作 / 新需求 / 闲聊**（判定规则与矩阵见
[intent-triage.md](intent-triage.md)）。含糊到无法判断时它会先问一句：

```text
这是要我开工，还是只想了解情况？
  开工     → 按你原话建问题并开始澄清
  只是问问 → 我不动手
```

#### 密钥：确定性路径，不经过模型、不入库

格式固定为 **`设置 <KEY> <值>`**（也接受 `设定`/`set`、`KEY=值`）。

```text
你：设置 FEISHU_APP_SECRET <你的-app-secret>
机器人：✅ 已保存 FEISHU_APP_SECRET —— (已设置) → 已更新（值不回显）
        回复「重启服务」使配置生效
```

这条路径有三重隔离，全部由会话层在调用模型之前完成：

1. **不发给模型**：命中格式（或看起来是在贴密钥）的消息**根本不会**调用意图模型，
   所以密钥不会进入 DeepSeek 的请求；
2. **不写会话表**：入库的是 `设置 <KEY> [已隐去]`，`conversation_messages.content`
   里没有明文（有单测覆盖）；
3. **审计不含值**：`events` 里只记 `config.secret_changed {key, hadPrevious, actor}`。

⚠️ **唯一挡不住的地方是飞书自己**：消息历史由飞书保留，而我们（或机器人）无法
删除用户发出的消息。所以设置完密钥后，**请立刻在飞书里撤回那条消息**。
密钥类的写入同样只允许 `admin`，且所有改动都需要 `重启服务` 才生效。

模型路径（`config.set`）遇到密钥字段会直接拒绝并回一段格式提示——即使模型把
一条密钥消息误判成普通配置，也写不进去。

### 全部配置项清单

| 分组 | 变量 | 类型 | 说明 |
| --- | --- | --- | --- |
| 飞书 | `FEISHU_APP_ID` / `FEISHU_APP_SECRET` | 字符串 / 密钥 | 自建应用凭证，长连接认证用 |
| 飞书 | `FEISHU_ALLOWED_OPEN_IDS` | 列表 | 白名单；留空 = 拒绝所有人 |
| 飞书 | `FEISHU_ROLE_MAP` | 映射 | `ou_x=admin, ou_y=reviewer` 或 JSON |
| 飞书 | `FEISHU_DEFAULT_ROLE` | 枚举 | `guest` / `developer` / `reviewer` / `admin` |
| 飞书 | `FEISHU_DEFAULT_CHAT_ID` | 字符串 | Delivery 通知目标群 |
| 模型 | `AI_LLM_BASE_URL` / `AI_LLM_MODEL` / `AI_LLM_API_KEY` | 字符串 / 密钥 | 意图解析、问题分析、规格推导 |
| 代理 | `AI_CODEX_CONFIG` | JSON | 以 `codex exec -c k=v` 注入容器内的 provider 配置 |
| 代理 | `DEEPSEEK_API_KEY`（名字由 env_key 决定） | 密钥 | 容器内模型密钥，仓库需 `--secret` 声明 |
| 代理 | `AI_CODEX_BIN` / `AI_CODEX_SANDBOX` | 字符串 | 可执行文件与沙箱模式（留空按驱动自动） |
| 代理 | `AI_RUN_TIMEOUT_MS` / `AI_VERIFY_TIMEOUT_MS` | 整数 | 单次 Run / 单条验证超时 |
| 执行 | `AI_EXECUTION_DRIVER` | 枚举 | `docker`（容器隔离）/ `local` |
| 执行 | `AI_WORKSPACES_DIR` | 路径 | 每 Run 一个 git worktree |
| 执行 | `AI_MAX_CONCURRENCY` | 整数 | 并发 Run 上限 |
| 执行 | `AI_DOCKER_BIN` / `AI_PROXY_IMAGE` | 字符串 | docker 客户端与 allow-list 代理镜像 |
| 存储 | `DATABASE_URL` / `AI_STORAGE` | 连接串 / 枚举 | `postgres` 或 `memory` |
| 存储 | `AI_LOOP_INTERVAL_MS` / `AI_WORKER_ID` / `AI_CONFIG_PATH` | 整数 / 字符串 | 调度循环与进程标识 |
| 行为 | `AI_DEFAULT_REPOSITORY_ID` | 字符串 | 用户没点名仓库时的默认目标 |
| 行为 | `AI_AUTO_BOOTSTRAP_SPECIFICATION` | 布尔 | 问题确认后自动推导规格 + 拆任务 |
| 行为 | `AI_INTENT_NOTES` | 文本 | 追加给意图模型的部署说明 |
| 机器人 | `AI_ENV_FILE` | 路径 | 机器人写配置时落盘的文件（默认 `deploy/ai-harness.env`） |

> 未列入的变量只用于测试/发布门禁（`AI_TEST_*`、`AI_GATE_COMMIT` 等），
> 生产部署不需要。`tests/configSchema.test.ts` 会校验这张表覆盖了代码里读到
> 的每一个运行时变量——漏加一个就会红。

### 仓库注册（属于数据，不是配置）

每个被开发的仓库有自己的一份「执行档案」：镜像、网络模式与白名单、注入的
密钥、CPU/内存/pids。它随仓库记录存在数据库里，用 CLI 注册
（见 §5），不进环境变量。

### 3.3 对话记录（谁说了什么）

机器人把对话原文存在控制面库里，它既是"谁提了什么需求"的唯一记录，也是意图
模型看到的多轮上下文来源：

| 表 | 内容 |
| --- | --- |
| `conversations` | 渠道、`external_chat_id`/`external_thread_id`、subject 绑定（当前在谈哪个 problem/task/run）、状态 |
| `conversation_messages` | 方向（INBOUND/OUTBOUND）、发送者、正文、metadata（chatId/threadId/eventId）、外部 message_id、时间 |

```bash
node dist/cli/index.js conversation list [--channel feishu] [--limit N]
node dist/cli/index.js conversation show <会话id 或 oc_ 聊天id> [--limit N]
node dist/cli/index.js conversation export <id> > chat.md
node dist/cli/index.js conversation prune --keep-days 90 [--execute]
```

聊天里也可以：`聊天记录`（admin，渲染最近 20 条并说明截断了多少）。

约定与边界：

- **密钥不会出现在记录里**：`设置 <KEY> <值>` 确定性路径入库的是
  `设置 KEY [已隐去]`，外发的密钥回执也只显示「已设置」。
- `prune` **默认是 dry-run**，必须显式 `--execute` 才删；转录是唯一记录，
  所以删除永远是人工决定。
- 记录的是**机器人收到的**消息：群里未被 @ 的消息、以及加机器人之前的历史
  都不在其中。卡片在落库时被拍平成文本（按钮结构丢失）。
- 飞书侧的撤回/编辑不会同步过来。
- Delivery 通知（READY_FOR_RELEASE / BLOCKED）也会落进对应会话。

### 3.2 用聊天改配置（admin）

同样的配置也能在群里/私聊里改，命令同样走 Command 层（显式目录 + 校验 +
授权 + 幂等 + 审计事件）：

| 你说 | 效果 |
| --- | --- |
| `查看配置` / `谁有权限` | 列出已设置的项（密钥只显示「已设置」）与未设置项 |
| `把最大并发改成 1` | `config.set`：写文件，回显「旧值 → 新值」 |
| `授权 ou_xxx 为 developer` | `access.grant`：**合并**进白名单与角色表 |
| `移除 ou_xxx` | `access.revoke`（拒绝移除最后一个人） |
| `重启服务` | `config.apply`：先回话，再重启，新配置生效 |

三条不可绕过的规则：

1. **只有 admin 能用**，其它角色一律 `unauthorized`。
2. **密钥永不接受聊天输入**——飞书会留档，我们也会把消息原文写进
   `conversation_messages`。请求设置密钥时机器人会回一段配置页入口
   （SSH 隧道 + 令牌链接），只能在那里填。
3. **列表只增不减**：`config.set` 写 `FEISHU_ALLOWED_OPEN_IDS` /
   `FEISHU_ROLE_MAP` 时若会移除已有条目，直接拒绝并提示改用
   `移除 ou_xxx` 或配置页——避免一句「授权新人」把自己锁在门外。
   角色映射的 `ou_x:role`（模型爱用的写法）会被规范化成 `ou_x=role`。

写入不等于生效：`config.set` 只改文件，回复里明确提示还需 `重启服务`；
`config.apply` 会先发回复再重启（重启打断的是它自己，不影响会话记录）。
所有改动都会写 `config.changed` / `access.granted` / `access.revoked` /
`config.apply_requested` 事件，可用 `ai event list` 审计。

## 4. 授权：拿到你的 open_id

白名单默认是空的，任何人发消息都会被拒绝——但机器人会把**对方自己的
open_id 回给聊天**：

```text
⛔ 未授权：ou_xxxxxxxxxxxxxxxxxxxxxxxx 不在 FEISHU_ALLOWED_OPEN_IDS 白名单内
```

把该 id 填进 `FEISHU_ALLOWED_OPEN_IDS`（逗号分隔），然后
`systemctl restart ai-harness`。想区分权限时再加 `FEISHU_ROLE_MAP`：

- `guest`：查询类命令
- `developer`：`task.run`、`problem.confirm`、`spec.plan` 等执行类
- `reviewer` / `admin`：`review.approve`、`delivery.release`

## 5. 注册要被开发的项目

Harness 只对“已注册仓库”开工：本地 git 检出 + 验证命令 + 执行镜像。

```bash
cd /srv/ai-harness
set -a; . deploy/ai-harness.env; set +a

# 1) 在真机上准备一份可跑的检出（worktree 从它派生）
git clone <repo-url> /srv/repos/xmusic

# 2) 注册
node dist/cli/index.js repository create \
  --id repo-xmusic \
  --name xmusic \
  --url <repo-url> \
  --local-path /srv/repos/xmusic \
  --verify "npm test" \
  --exec-image harness/execution:node22 \
  --network restricted --allow registry.npmjs.org --allow api.deepseek.com \
  --secret DEEPSEEK_API_KEY

# 3) 确认
node dist/cli/index.js repository show repo-xmusic
```

`AI_DEFAULT_REPOSITORY_ID` 指向它之后，群里说“首页太空了”就会自动落到该仓库。

### 5.1 GitHub：取代码与推送

**认证（在宿主机，harness 不参与）**。二选一：

```bash
# A) 复用宿主机已有的 GitHub 身份（本机已可用：ssh -T git@github.com → Hi <你的 GitHub 账号>!）
#    注意这是「用户 key」：能读它的进程就能以该账号操作其全部仓库。

# B) 每仓一个 deploy key（推荐：最小权限、可单独吊销）
ssh-keygen -t ed25519 -f /root/.ssh/github_<name> -N '' -C 'ai-harness@<host>'
cat /root/.ssh/github_<name>.pub   # → GitHub: repo → Settings → Deploy keys
                                   #   需要推送时才勾 Allow write access
printf 'Host github.com\n  HostName github.com\n  IdentityFile /root/.ssh/github_<name>\n  IdentitiesOnly yes\n' \
  >> /root/.ssh/config
git clone git@github.com:org/repo.git /srv/repos/<name>
```

**取代码**（任务分支从*本地* ref 派生，不同步就会一直从旧代码开工）：

```bash
node dist/cli/index.js repository sync <id>
#   repo-demo [main] 5854c0fa → a0aed0f0
# 脏工作区会拒绝同步：… 有未提交改动，已跳过（避免覆盖）
```

**推送**：默认 `deny`，必须显式开：

```bash
node dist/cli/index.js repository create ... --git-push allow
```

开启后，**人工审批 = 推送时机**（与现有 `review.approve → DONE` 边界重合）：

```text
群里：通过 task-x      →  审批通过，并自动 commit + push
群里：推送 task-x      →  重试（网络/保护规则导致上次没推成功时）
CLI ：ai task approve <id> / ai task publish <id>
```

三条硬约束（都在 `GitService` 里，与模型和 Task 指令无关）：

1. `executionProfile.policy.gitPush` 不是 `allow` → 不提交、不推送；
2. 只推 `AI_GIT_PUSH_PREFIX`（默认 `ai/`）前缀的分支；
3. 永不推送默认分支 / `main` / `master`。

**agent 容器不持有任何 GitHub 凭证**，也读不到 worktree 的 gitdir——fetch/commit/push
全部由 Harness 在宿主机完成（容器内 git 实测为 `fatal: not a git repository`）。
因此一次 Run 里 Codex 只能改文件，能不能进远端完全由审批这一步决定。

> 真机实测（2026-09-28，用本地裸仓模拟远端）：基线 `5854c0f` → 容器内 Codex 实现
> `greet` → 容器内验证 PASS → Run SUCCEEDED → Task REVIEW → 审批 → 推送
> `ai/task-demo-git-run-46d034f954-t0`（`e8b9e37`，作者 `AI Harness <ai-harness@localhost>`），
> 远端 `main` 保持 `5854c0f` 未被触碰；`repository sync` 把基仓从 `5854c0f` 快进到 `a0aed0f`。

> **两个必填细节**：① `--secret DEEPSEEK_API_KEY` 让每个 Run 容器拿到模型
> key（值来自服务进程环境变量，不落库、不进日志）；② allow-list 必须包含
> `api.deepseek.com`，否则容器内的 Codex 无法调用模型。执行镜像本身是通用的，
> provider 配置由 `AI_CODEX_CONFIG` 以 `-c` 覆盖注入。

## 6. 在飞书里驱动开发

### 群聊礼仪

- **只回应 @**：群消息里没有 @ 到机器人时，机器人**不回复、也不记录**（私聊没有
  @ 的概念，照常响应）。判断依据是 `mentions[].open_id` 与机器人自身的 open_id
  比对——启动时自动向飞书查询并打印：`bot identity: AI Coding ou_78fd…`；也可以用
  `FEISHU_BOT_OPEN_ID` 显式指定。查不到身份时退化为"任何 @ 都算叫我"，并在日志里说明。
- **一律用话题回复**：回复走 `POST /im/v1/messages/:message_id/reply` 且
  `reply_in_thread=true`，整段对话落在触发消息的话题里，不刷屏。**单聊同样如此**
  （实测飞书单聊支持 `reply_in_thread`）。用 `FEISHU_THREAD_REPLIES` 调整：
  `always`（默认，群 + 单聊）/ `group`（只有群）/ `never`（都直接发到会话）。
  若某个会话类型拒绝话题回复，会自动降级成普通发送并在日志里说明，绝不丢回复。
- **话题里的后续消息是独立会话**：飞书会给话题内消息带 `thread_id`，因此每个话题
  有自己的上下文；新话题的第一个会话会**继承该群当前的主题绑定**（problem/task），
  这样话题里的「确认」「运行它」仍然指向正确的问题。

```text
你：Rehelu 首页在没有数据时没有任何提示，加个空状态
机器人：prob-xxxx 已创建 … 还需要确认：范围只改移动端吗？(all/mobile)
你：移动端就行
机器人：规格已就绪 spec-xxxx + 已拆解 2 个任务 task-…/task-…
你：运行 task-xxxx
机器人：🚀 run-xxxx queued for task task-xxxx
        …（Run 结束时自动推送执行/验证结果卡片）
你：通过 task-xxxx          # reviewer/admin
机器人：✅ Approved task-xxxx (status: DONE)
        …（Delivery 进入 READY_FOR_RELEASE 时推送通知，release 仍需人工）
```

命令与权限由 Harness 内部的 Command 目录决定，自然语言只负责**翻译**成
命令；模型无法伪造身份、越权或直接触碰执行层。

## 7. 运维

```bash
systemctl status ai-harness
journalctl -u ai-harness -f            # 实时日志（含每次 tick 的 phase 错误）
systemctl restart ai-harness
systemctl stop ai-harness              # 停止后不再有新的调度/执行

# 维护：终态 Run 的 worktree 会保留（Review 需要看 diff）
# 本地磁盘紧张或有大量已审阅 Run 时定期回收：
cd /srv/ai-harness && set -a; . deploy/ai-harness.env; set +a
node dist/cli/index.js workspace cleanup

# 回滚：把上一版 dist/ 与 src/ 重新 rsync 后 restart 即可（无 schema 反演）
```

长连接凭证错误不会让进程退出（SDK 会重试），所以启动后请确认日志里没有
`[ws] invalid appId` 之类的报错。

## 7.1 本次部署实录（2026-09-28）

| 项目 | 结果 |
| --- | --- |
| 主机 | 2 vCPU / 1.9 GB / 磁盘 3.7 G 可用（89%）的 VPS |
| 控制面库 | `ai-harness-db`（独立容器 + 独立 volume，未碰 xmusic 的库） |
| 迁移 | 12 个全部应用；新增 `schema_migrations` 跟踪后重复执行 = 0 applied / 12 skipped |
| 服务单元 | `/etc/systemd/system/ai-harness.service` 已安装（凭证填入后 enable + start） |
| 执行面 | 真 Docker：worktree → 容器（cap-drop ALL、只读 rootfs、单挂载、`restricted` + allow-list 代理）→ 容器内 codex → 容器内验证 |
| 直接执行路径 | `ai run` → **SUCCEEDED**（21 s，验证 PASS） |
| 调度路径 | `ai loop --once` → scheduled=1 / executed=1 → Run **SUCCEEDED**，Task → REVIEW |
| 运行后残留 | 容器 0、workspace 0、网络 0 |
| 真机暴露并修复的缺口 | ① 迁移脚本每次重放 → 改为 `schema_migrations` 跟踪 + 显式 baseline；② 容器内 codex 无 provider 配置/密钥 → `AI_CODEX_CONFIG` 以 `-c` 注入 + `--secret DEEPSEEK_API_KEY`；③ 容器内嵌套 bwrap 无法建 namespace → docker 驱动下 codex 沙箱自动切 `danger-full-access`（容器即边界） |
| 待联调 | 真实飞书凭证（长连接）——代码路径已用假 appId 预检到握手一步 |

故障排查顺序：

1. `journalctl -u ai-harness -n 100`：配置错误会在启动时显式报变量名。
2. `docker ps -a | grep ai-run` / `docker exec ai-harness-db pg_isready`。
3. `node dist/cli/index.js run show <run-id>`、`ai event list --run <run-id>`。
4. 群里的执行卡片包含每个 target 的 check 命令、exit code 与输出截断。

## 8. 已知边界（刻意保留）

| 边界 | 说明 |
| --- | --- |
| 不自动 Release / Merge / 部署 | Delivery 到 `READY_FOR_RELEASE` 只通知，`delivery.release` 必须人工执行 |
| 不自动 `push` | 执行策略允许容器内 commit，禁止 push（见 `docs/remote-execution-isolation.md`） |
| 运行态看板在聊天里 | 无 Web UI（v0.1 明确不做） |
| 通知绑定在事件表 | Run→会话绑定持久化在 `events`，重启不丢也不重复；未被绑定（CLI 触发）的 Run 默认静默 |
| 意图模型非确定性 | 模型可能把模糊消息判成“无命令”，此时机器人回帮助卡片；命令层仍会做严格校验与授权 |
