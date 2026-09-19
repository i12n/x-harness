# Phase 11 — Conversational Interface（设计稿）

> 状态：设计稿（先设计，后编码）。本文档定稿前不实现飞书/钉钉代码。
>
> 目标：把"人怎么和 Harness 沟通"从 CLI 扩展成 **群聊 = Harness 的自然语言
> 控制台**。群聊不是执行层，而是 **Human Interface**。

## 进度（滚动更新）

- TASK-1101 ✅ Channel abstraction（2026-09-19）：
  - `src/channel/{message.ts,channel.ts,command.ts}`：`Channel`
    (`id` / `receive` / `send`)、`IncomingMessage`、`OutgoingMessage` +
    `MessageBlock`（text/code/divider）、`CommandEnvelope`（仅定义形状，
    Intent 解析留给 TASK-1106）
  - `src/channel/cli/adapter.ts`：`CliChannel`（第一个 Channel），
    `send()` 渲染文本，输出与旧 CLI 逐字一致；`receive()` 调用可选 handler
    后回发（供 Conversation 接入）
  - CLI `ai run` 的输出改经 `CliChannel.send()` 渲染；真实 codex 冒烟验证
    “旧 CLI 行为 = 新 Channel 架构下行为”
  - 边界守卫测试：Channel 不 import 任何业务模块；Harness Core（domain/
    store/worker/loop/scheduler/verification/execution/workspace/agent/
    problem/config/util）不 import channel
- 下一步：TASK-1102 Conversation（多轮上下文 + 去重）

- TASK-1102 ✅ Conversation（2026-09-19）：
  - `migrations/006_conversations.sql`：`conversations`（channel/
    external_chat_id/external_thread_id/title/subject_type/subject_id/status，
    subject 可为空且**不控制** Problem/Task/Run 生命周期）+
    `conversation_messages`（direction INBOUND/OUTBOUND、sender_id、
    message_type、content、metadata、external_message_id）
  - 幂等键在 Conversation 层解决：`UNIQUE(channel, external_message_id)`
    （部分索引），Webhook 重推 → `duplicate=true`，不写第二条、不重复触发
  - `src/domain/conversation.ts` + 内存/Postgres `ConversationStore`
    （ensureConversation by channel+chat+thread、attachSubject、appendMessage、
    findMessageByExternal、listMessages）
  - `src/conversation/service.ts`：`ConversationService`
    （getOrCreate / handleIncoming 幂等 / recordOutgoing / context /
    attachSubject）；上下文窗口支持 `limit`（最近 N，按时间升序返回）、
    `before`、`after`；不含 embedding/向量检索/summary
  - 未做（按边界）：LLM Intent（1106）、Feishu（1103/1104）、卡片（1105）、
    权限（1109）
- 下一步：TASK-1103 Feishu Bot

- TASK-1103 ✅ Feishu Provider（离线部分，2026-09-19）：
  - `src/channel/feishu/{client,adapter,cards,messages,errors}.ts`
  - `FeishuClient` 抽象：`sendMessage` / `sendCard`；`HttpFeishuClient` 用
    fetch 实现（tenant_access_token 缓存、超时、结构化错误映射）
  - 渲染：`OutgoingMessage` → Feishu text payload 或 generic interactive card
    （markdown/divider），不定义 Task/Run/Review 业务卡片
  - 错误：`FeishuError{code,retryable,status?,retryAfterSeconds?}`；
    4xx 不可重试、5xx/429/超时可重试（429 带 Retry-After）、
    malformed response 不可重试；**不自建 retry loop**
  - 配置可选：无 `FEISHU_APP_ID/SECRET` 也能加载与跑单测，真实发送时才报
    configuration 错误
  - 边界：adapter 只做通信与格式转换，不 import Problem/Task/Run；webhook/
    event ingestion 留给 TASK-1104
- 下一步：TASK-1104 Feishu event ingestion（Webhook + Conversation 接入）

- TASK-1104 ✅ Feishu Event Ingestion（离线，2026-09-19）：
  - `verification.ts`：`url_verification` challenge、verification token、
    sha256(timestamp+nonce+encryptKey+body) 签名、时间戳新鲜度校验；
    无凭证/密钥时进入显式 dev 模式（`verified=false` 但可跑）
  - `events.ts`：Feishu v2 `im.message.receive_v1` → `IncomingMessage`
    （chat_id→conversation/externalChatId、thread_id/root_id→
    external_thread_id、sender_id→senderId、message_id→messageId/幂等键、
    text content、create_time→timestamp、metadata 保留 chatType/eventId 等）；
    非消息事件显式 ignored
  - `webhook.ts`：`verify → parse → ConversationService.handleIncoming()`；
    验证失败/不支持/畸形请求在产生任何 Conversation 副作用前返回；
    重复投递 → `duplicate=true` 且 **不再触发 onMessage 副作用**
  - `fixtures/`：message / group-message / unsupported 三份事件样本驱动测试
  - 无需真实 app_id/app_secret 与公网回调即可完成全部离线验收
- 下一步：TASK-1105 Message / Card Rendering

- TASK-1105 ✅ Message / Card Rendering（2026-09-19）：
  - 扩展 `MessageBlock`：`text | markdown | code | divider | section | actions`
    （`MessageAction{id,label,style,value}`）；CLI 与 Feishu 渲染器同步支持新块
  - `src/channel/rendering/`：`renderTaskMessage` / `renderRunMessage` /
    `renderReviewMessage`（+ `common.ts` 的 `collectRunTargets`、截断、
    计数、状态标记）；输出始终是 `OutgoingMessage`
  - Run 卡片包含 workspaces、逐 target ✓/✗、verification、失败 check
    （命令/exit code）与**截断后的** output（默认 400 字符，可配置）
  - Review 卡片：targets 摘要 + `N passed / M failed` + 结构化 actions
    （`review.approve` / `review.request_changes`，仅占位，不执行审批语义）
  - 边界：业务 Renderer 不 import 任何具体传输（feishu/cli），只产出
    OutgoingMessage；Feishu Adapter 仍负责最终 payload 转换
  - 数据隔离：target 的 check/output/workdir 只出现在自己的 section 中
- 下一步：TASK-1106 Intent → Command

- TASK-1106 ✅ Intent → Command（离线，2026-09-19）：
  - `src/command/`：`types` / `schema` / `validation` / `authorization` /
    `idempotency` / `dispatcher` / `engine` / `index`
  - Command 目录（9 个）：problem.create|confirm、task.show|run、
    run.show|cancel、review.show|approve|request_changes；每个都有显式
    payload schema 与允许角色
  - 严格校验：未知 command / payload 类型错误 / 缺字段 / 未知字段 /
    不支持的 version 一律 `rejected`（不进 Application）
  - Authorization 在 Harness 内（Dispatcher 中）执行：guest 可查询类命令，
    developer+ 可执行类，review.approve / request_changes 需要 reviewer/admin
  - Command 幂等：Dispatcher 层 `idempotencyKey` 去重，重放返回第一次结果
    （`replayed: true`）；task.run / review.approve 不会二次执行
  - Dispatcher 只做显式 handler map 路由，禁止动态方法调用；handler 异常
    转成 `CommandResult(failed)`
  - Intent：`IntentEngine` 接口 + `ScriptedIntentEngine`（离线）；
    `handleIntent()` 把 message 的 channel/sender/conversation/messageId
    注入为**可信字段**（引擎伪造的 actor/idempotencyKey 被忽略）；
    引擎无法绕过 Authorization
  - 边界守卫：`src/command/**` 不 import channel/store/worker/loop/
    execution/workspace/agent/verification/problem；Intent Engine 只能产出
    Command，永远拿不到内部能力
  - 未做（按边界）：真实 LLM / Function Calling / MCP / Feishu 部署 /
    审批或 Merge 业务实现
- 下一步：TASK-1107 Problem Confirmation 接入（Conversation → Command →
  Problem）

## 1. 定位

```text
飞书 / 钉钉 / Slack / Web Chat / CLI
                 │
          Channel Adapter
                 │
            Conversation
                 │
        Intent → Command
                 │
          Authorization
                 │
            Harness Core
   (Problem / Task / Scheduler / Run / Worker /
    Verification / Review / Event)
```

Harness Core **不知道**飞书、钉钉、Slack 的存在；它只认结构化 Command。

## 2. 为什么第一个 Channel 选飞书

判断标准是"AI-native 软件交付界面"，不是"哪个办公软件更好"：

| 维度 | 飞书 | 钉钉 |
| --- | --- | --- |
| Bot / 事件订阅 | ★★★★★ | ★★★★★ |
| 卡片交互（按钮/输入框） | ★★★★★ | ★★★★ |
| 对话体验 | ★★★★★ | ★★★★ |
| 文档协作 | ★★★★★ | ★★★★ |
| AI Agent 场景 | ★★★★★ | ★★★★★ |
| 开发者体验 | ★★★★★ | ★★★★ |
| Harness 适配 | ★★★★★ | ★★★★ |

结论：**第一阶段做飞书 Adapter**；钉钉作为后续 Adapter，不写死进核心。

## 3. 模块划分（建议目录）

```text
src/channel/
  channel.ts          # Channel 接口
  message.ts          # IncomingMessage / OutgoingMessage
  command.ts          # Command 定义 + 解析结果
  conversation.ts     # Conversation 域（多轮上下文状态）
  authorization.ts    # 角色 → 允许的 Command
  application.ts      # Command → Harness Core 应用服务
  cli/                # CLI 也是一种 Channel（复用同一套 Command）
  feishu/
    client.ts         # open API client（发消息/更新卡片）
    webhook.ts        # 事件订阅入口（签名校验、去重）
    events.ts         # 事件 → IncomingMessage
    cards.ts          # OutgoingMessage → 消息卡片
    adapter.ts        # FeishuChannel implements Channel
  dingtalk/           # 后续
```

核心接口（最小）：

```ts
interface Channel {
  receive(message: IncomingMessage): Promise<void>;
  send(message: OutgoingMessage): Promise<void>;
}
```

## 4. Conversation 层（本阶段核心之一）

不要 `飞书消息 → Problem` 直连。中间必须有 Conversation：

```text
群消息 → Channel Adapter → Conversation → Intent/Command → Harness
```

原因：群里不是每句话都是需求；Conversation 负责：

- 维护会话上下文（channelId / chatId / thread / participants）
- 关联"当前正在讨论的 Problem / Task / Run"
- 把多轮澄清（Confirmation Loop）串成一条线索
- 控制上下文窗口与限流，避免把整个群历史塞给模型

建议数据模型（新增表）：

```text
conversations(id, channel, external_chat_id, external_thread_id,
              subject_type, subject_id, status, created_at, updated_at)
conversation_messages(id, conversation_id, direction, actor,
                      text, command, payload, external_message_id,
                      created_at)
```

`external_message_id` 唯一约束用于事件重试去重（飞书事件会重推）。

## 5. Intent → Command（本阶段核心之二）

**自然语言不是权限。** LLM 只做一件事：把话转成结构化 Command。

```json
{ "command": "task.approve", "taskId": "TASK-103" }
{ "command": "run.cancel", "runId": "RUN-203" }
{ "command": "problem.create", "title": "...", "statement": "..." }
```

链路：

```text
消息 → Intent Parser（LLM）→ Command → Authorization → Application Service → Harness
```

约束：

- LLM 不直接调用内部 API、不直接写数据库
- Command 必须有 schema（可用 `codex exec --output-schema` 强制 JSON）
- 解析失败/低置信 → 回复澄清，不执行
- 每个 Command 幂等键（external_message_id）防止重复执行

## 6. 权限模型（Authorization）

| 操作 | 群聊 | 说明 |
| --- | --- | --- |
| 创建 / 修改 Problem | ✅ | |
| 创建 Task | ✅ | |
| 启动 Run | ✅ | |
| 查看日志 / Diff / Run | ✅ | |
| Cancel Run | ✅ | |
| Review（批准 / 打回） | ✅ | 需有 reviewer 角色 |
| Merge | ⚠️ | 需要显式审批 + CI 绿 |
| Push main | ❌ | 由 Policy 决定，默认拒绝 |
| Deploy production | ❌ / 二次审批 | 默认拒绝 |
| 删除资源 | ❌ | 默认拒绝 |

角色映射：飞书用户/群 → Harness 角色（viewer / operator / reviewer / admin），
映射表保存在 Harness 侧（配置文件或 DB），不从聊天内容推断。

## 7. 消息渲染（方向：Harness → 群）

以**状态变化**为驱动，禁止"正在运行…"刷屏：

```text
🚀 TASK-103 开始执行      RUN-203 / Codex / RUNNING
🧪 TASK-103 验证中        ✓ typecheck ✓ lint ⏳ test ⏳ build
✅ TASK-103 等待 Review   14 files +382/-47
                          [查看 Diff] [查看 Run] [批准] [要求修改]
```

卡片元素复用同一套 OutgoingMessage 模型，飞书卡片只是渲染器之一
（CLI 渲染成文本、Web 渲染成 HTML）。

## 8. 四个实施阶段

```text
Phase A  通知渠道        Harness → 飞书（Run Started/Failed/Succeeded/Task Review）
Phase B  操作入口        飞书 → Harness（创建/查询 Problem、Task、Run；取消 Run）
Phase C  对话驱动开发    自然语言 → Problem → Confirmation → Specification → Task
Phase D  完整交付        需求 → 对话 → Task DAG → Runs → PR → CI → Review → Merge → Deploy
```

Phase C 正是已有 **Problem Confirmation Loop** 的入口；Phase D 依赖
Dependency DAG 与 GitHub Integration。

## 9. 安全与工程约束

- 事件入口必须校验签名（飞书/钉钉加密策略），并做事件去重
- 应用凭证走 Secret Store / 环境变量，不落 Repository/Task/Run/Event
- 出站消息限流 + 失败重试；卡片更新用 message_id，避免刷屏
- 所有群内操作写 Event（谁、在哪个群、执行了什么 Command）
- 群聊只作为 Human Interface，绝不绕过 Verification / Review / Policy

## 10. 任务拆分（TASK-1101…1110）

```text
TASK-1101  Channel abstraction（Channel / Message / Card 模型）
TASK-1102  Conversation domain（表 + 状态 + 去重）
TASK-1103  Feishu Bot（应用凭证、发消息、卡片渲染）
TASK-1104  Feishu event ingestion（webhook + 签名 + 事件→IncomingMessage）
TASK-1105  Message / Card rendering（状态卡片、按钮、更新策略）
TASK-1106  Intent → Command（schema 约束 + 幂等）
TASK-1107  Problem Confirmation 接入（Conversation → Problem → 澄清循环）
TASK-1108  Task / Run operations（创建、查询、启动、取消）
TASK-1109  Review / Approval 接入（批准 / 打回 / 权限校验）
TASK-1110  Rehelu E2E（真实群 + 真实仓库 + 真机 Harness）
```

真正需要先做扎实的是 **TASK-1102（Conversation）** 与
**TASK-1106（Intent → Command）**；飞书只是第一个 Channel。

## 11. 验收标准（Phase 11）

1. Phase A：一次真实 Run 的状态变化能在飞书群里按事件顺序出现
2. Phase B：群内可查询 Problem/Task/Run、启动与取消 Run，且权限校验生效
3. Phase C：群内一句话 → 澄清循环 → Problem CONFIRMED → 生成 Task
4. 安全性：未授权用户执行 approve/cancel 被拒绝；非法 Command 不落库
5. 幂等：飞书事件重推不会产生重复 Command / 重复 Problem
6. 可替换性：新增一个 Channel（如 CLI/DingTalk）不需要改 Harness Core
7. 单元测试不依赖外网（Fake Channel + 录制事件 fixtures）

## 12. 待确认（进入编码前需要拍板）

1. 顺序：先做 Phase 10（Multi Repository）还是先做 Phase 11 A/B？
   （A/B 不依赖 Phase 10；Phase C 的多仓库场景才依赖）
2. 飞书应用：自建应用归属哪个租户、由谁创建并保管凭证？
3. Conversation 持久化：按 §4 建两张表，还是先只落 events？
4. Intent Parser 用哪个模型/Provider？是否需要独立的成本与限额策略？
5. 角色映射：谁拥有 reviewer/admin（决定谁能 approve/merge）？
6. 通知粒度：哪些事件推群、哪些只进 Run 详情（避免刷屏）？
7. 群 ↔ 项目映射：一个群对应一个 Repository 集合，还是由 Command 指定？
