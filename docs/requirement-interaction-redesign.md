# 需求交互重设计：一个对象、一个话题、五个动词

> 状态：**设计稿**（先定稿，再编码）。
> 取代：[conversational-interface.md](conversational-interface.md) 里"命令按层划分"的交互约定。
> 关联：[autonomy-redesign.md](autonomy-redesign.md)（自动开发链路）、[task-1223-delivery-acceptance.md](task-1223-delivery-acceptance.md)（交付验收）、[task-1231-deploy-monitoring.md](task-1231-deploy-monitoring.md)（测试环境与部署）、TASK-1239/1240/1241（发布策略与测试分支）。

## 0. 一句话

用户只跟**需求**打交道；**一个需求只有一个话题**，所有回执、Run 结果、评审意见、部署通知都落在同一个话题里；用户只需要 **5 个不带 id 的动词**。

## 1. 问题（都是实测发生过的）

| # | 现象 | 证据 |
| --- | --- | --- |
| P1 | **概念泄漏五层**：`prob-` / `spec-` / `task-` / `run-` / `dlv-` 全出现在对话里，用户被迫搬运 id | 2026-10-08/09 真实会话：`prob-f93c25696d` → `spec-2f86df7ecb` → `task-spec-e13a0f2517-0` → `dlv-c2eaf5d883` |
| P2 | **命令按层划分**：`打回 task-x`、`测试部署 dlv-x`、`发布 dlv-x`——用户要先知道"现在该用哪一层" | `src/command/schema.ts` 里 review / delivery / deploy 各成一组 |
| P3 | **消息散落**：回执在触发消息的话题、Run 通知在"绑定会话"、部署通知又被 bind 到发起会话；同一需求的对话被打散到多个话题甚至主时间线 | `run.chat_target` / `deploy.chat_target` 事件 + `FEISHU_THREAD_REPLIES` 的按会话配置 |
| P4 | **时序缺口**：测试环境验收发生在任务 DONE 之后，而 `打回` 只接受 REVIEW → "验收不通过"没有入口 | `reviewService.requestChanges` 的状态守卫；`dlv-c2eaf5d883` 实际卡在此处 |
| P5 | **反馈送达很弱**：打回意见写进 `task.constraints.reviews`，提示词里只是 `Constraints: {...}` 的一段 JSON | `contextBuilder.composePrompt` |

## 2. 目标 / 非目标

**目标**

1. 单一对象：用户只认「需求」；内部五层不外露。
2. 单一话题：一个需求 = 一个飞书话题，所有消息回到这里。
3. 零 id 交互：动词不带 id；歧义时用标题 + 按钮消歧。
4. 回环完整：测试环境验收不通过 → 打回 → 带意见重跑 → 再部署 → 发布。
5. 门禁用"人话"表达，并总是给出下一步动作。

**非目标**

- 不改 Task / Run / Delivery 的权威状态机（DONE 仍是"开发 + 机器验证通过"，RELEASED 才是冻结点）。
- 不做 Web UI；不新增执行层；不做多语言。
- CLI 的机器命令面**暂不收敛**（待确认，见 §12）。

## 3. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 用户对象 = **需求**（标题；必要时附短码）。内部 `problem/specification/delivery/task/run` 只出现在"详情" | 用户心里只有"我要的那件事 + 现在到哪一步" |
| D2 | **需求 = 话题**：锚定"用户创建需求的那条消息"（`anchor_message_id`）；用户从别处（主时间线 / 别的话题）补充意见时，回复仍落到原话题 | 飞书没有"按 thread_id 发送"的接口，只能 reply 到话题内的消息（§7.4） |
| D3 | **出站只走 `reply + reply_in_thread`**，不再有 `sendMessage` 进主时间线；飞书拒绝时降级并记录告警，绝不静默丢消息 | 明确要求"不要直接在会话中回复" |
| D4 | **不兼容旧命令**：聊天面删除 `通过 task-x`、`测试部署 dlv-x`、`打回 task-x`、`spec-…` 等所有带 id 的命令 | 明确要求；两套并存会让"该用哪个"重新变模糊 |
| D5 | 动词收敛为 5 个：`进展` / `打回 <意见>` / `测试部署` / `发布` / `重跑`；**直接描述需求 = 新需求** | 覆盖全部人工决策点，其余交给自动链路 |
| D6 | `打回` 接受 `REVIEW` 与 `DONE`；**人工打回不受 attempts 上限约束**；交付已 `RELEASED` 时拒绝打回（引导开新需求） | DONE 之后的测试环境验收才是最常见的"不满意"入口；attempts 是防机器空转，不是防人 |
| D7 | 提示词里**单独渲染"最近一次验收意见"**，`Constraints` 不再重复整份 reviews | 让"打回 → 重跑"真的生效；顺带省 token |
| D8 | 卡片主文案只有**标题 + 阶段 + 待办动作**；`dlv-…` / `task-…` 仅在"详情"折叠行 | id 是排查用的，不是交互用的 |

## 4. 对象与状态

### 4.1 需求阶段（对外唯一状态机）

```text
澄清中 ──→ 开发中 ──→ 待验收 ──→ 待发布 ──→ 已上线
             ↑            │
             └── 已打回 ───┘          （打回意见随状态显示；同一需求可多轮）
```

| 对外阶段 | 判定依据（内部事实） | 该阶段允许的用户动作 |
| --- | --- | --- |
| 澄清中 | problem 未 CONFIRMED / 有 OPEN 澄清 | 回答澄清；放弃 |
| 开发中 | 规格已拆任务，任务非全 DONE | 进展；重跑 |
| 待验收 | 任务全 DONE、交付未发布 | **测试部署**；进展 |
| 待发布 | 测试分支已推（PR 开着），等人工确认 | **发布**；**打回** |
| 已上线 | 交付 RELEASED | 只能开新需求 |

### 4.2 需求 = 话题

```text
需求
 ├─ 标题：面包屑分隔符间距
 ├─ 阶段：待发布
 ├─ 话题：chat_id + thread_id + anchor_message_id   ← 新增：锚点消息 id
 ├─ 最近意见：间距应该是 24px，不是 16px（第 2 轮）
 └─ 内部（详情里才出现）：problem / specification / delivery / tasks / runs
```

## 5. 消息路由规则

1. **锚点创建**：用户第一次提出需求的那条消息 = 锚点；机器人对该消息 `reply(reply_in_thread=true)` → 飞书把这轮对话放进同一话题。
2. **后续一切出站**（回执、Run 卡片、评审结论、部署通知、错误）都 `reply(anchor, reply_in_thread=true)`。
3. **跨话题输入**：用户在主时间线或别的话题里补充意见时，机器人仍在**原话题**回复，并回显他说的内容（`你说：间距应该是 24px`），使话题内自洽；同时把该消息并入同一需求上下文。
4. **卡片按钮**：按钮携带内部 `requirementId`，点击后同样回原话题，不回点击处。
5. **失败降级**：`reply_in_thread` 被拒（个别会话类型）时降级为普通发送，并写 `WARN` 日志与事件——不丢消息，但这是异常路径，不是常态。

## 6. 交互脚本

### A. 正常一轮

```text
你  ：面包屑分隔符前后各留 16px，指的是 sep 那个符号
机器人：🆕 收到「面包屑分隔符间距」— 澄清中
        这个 16px 适用于全站面包屑，还是只这一处？ [全站] [仅此页]
你  ：全站
机器人：📐 规格就绪 · 🧩 1 个开发点 · ▶️ 开始开发（下一条推送带改动与验证）
机器人：✅ 开发完成 · 验收证据 3/3 · 待验收
你  ：测试部署
机器人：🚀 测试环境：http://47.100.5.48:18080/（同一个 PR，不必记分支名）
你  ：发布
机器人：✅ 已上线「面包屑分隔符间距」
```

### B. 测试环境验收不通过（本次卡点）

```text
你  ：打回 间距应该是 24px，不是 16px
机器人：↩️ 已打回「面包屑分隔符间距」— 开发中（第 2 轮）
        意见：间距应该是 24px，不是 16px
        改完我会自动重跑；好了说「测试部署」，没问题说「发布」
        （自动重跑 → 新证据卡 → 你再说「测试部署」→ 同一个 PR 更新）
```

### C. 边界

```text
已上线后要改：你「间距再大一点」→ 机器人：这是新需求，我按「面包屑分隔符间距（第 2 次）」开单
多开发点：    打回时先问「重做哪一项？[① 间距数值] [② 移动端不换行] [全部]」
权限不足：    机器人：这一步需要 reviewer/admin 角色（当前 developer）
旧习惯：      你「测试部署 dlv-c2eaf5d883」→ 机器人：直接说「测试部署」就行（已为你指向当前需求）
```

## 7. 技术方案

### 7.1 命令目录（聊天面，重写）

| 命令 | 字段 | 角色 | 说明 |
| --- | --- | --- | --- |
| `requirement.show` | `{}` | 全部 | 需求卡（当前话题；歧义时给候选） |
| `requirement.reject` | `{ feedback?: string, scope?: "all" \| "item", item?: string }` | reviewer/admin | 打回；`scope` 仅在多开发点时出现 |
| `requirement.deploy` | `{}` | reviewer/admin | 推测试分支并开/更新 PR |
| `requirement.publish` | `{}` | reviewer/admin | 合并发布（仅"待发布"阶段） |
| `requirement.rerun` | `{}` | developer+ | 逃生口：重新跑一次 |
| `requirement.create` | `{ statement: string }` | 全部 | 直接描述需求时由意图层产生 |

旧命令（`review.*` / `delivery.*` / `deploy.*` / `task.*` 的聊天入口）**从目录中删除**；命令层实现保留（CLI 用）。

### 7.2 需求解析层（新增）

```text
resolveRequirement(input) → { requirement, problem, specification, delivery, tasks }
输入优先级：① 显式携带的 requirementId（按钮） ② 当前话题绑定的需求
            ③ 当前会话最近绑定的需求 ④ 歧义 → 返回候选（标题 + 阶段 + 按钮）
```

放在 `src/requirement/application/resolver.ts`（新目录），只做"用户对象 ↔ 内部对象"的翻译，不拥有业务规则；业务仍走现有服务（ProblemService / PlanningService / DeliveryService / DeployService / ReviewService）。

### 7.3 存储

```text
migrations/013_requirement_threads.sql
  ALTER TABLE conversations ADD COLUMN anchor_message_id TEXT;   -- 话题锚点
```

需求 ↔ 话题的绑定复用现有 `conversations`（`subject_type` / `subject_id` 已存在），只新增锚点；不新造表。

### 7.4 出站路由

- 现有 `ChatTarget` 扩展为 `{ conversationId, receiveId, receiveIdType, anchorMessageId }`。
- `sendToTarget` 统一走 `feishu.replyMessage({ messageId: anchor, replyInThread: true })`。
- 飞书能力边界：**没有"按 thread_id 发送"的接口**（`src/channel/feishu/client.ts` 只有 reply 形态），因此锚点消息 id 是必需的；锚点丢失时按 §5.5 降级并告警。

### 7.5 打回语义

```text
requirement.reject(意见)
  → 找到当前交付下"已 DONE 的开发点"（多开发点且未指定 → 先问）
  → 每个目标 Task: DONE → READY（不受 attempts 限制）+ appendTaskReview(意见)
  → Delivery 聚合自动回 IN_PROGRESS（reconciler，无需额外写入）
  → 事件 review.changes_requested（含 actor 与意见原文）
  → 调度器自动起新 Run（AI_AUTO_START）
```

守卫：交付 `RELEASED` → 拒绝并引导开新需求；Task 已是 READY/RUNNING → 拒绝并说明状态。

### 7.6 提示词

- 意图目录**整篇重写**：五个动词 + "直接描述 = 新需求"；不再出现任何 id 形态，也不再出现 task / run / spec / delivery 这些词。
- Run 提示词：把 `constraints.reviews` 里的**最近一条**单独成段（`Latest review feedback (the reason this run exists — address it): …`），并从 `Constraints` JSON 中去掉 reviews。

### 7.7 卡片

- **需求卡**（取代 task 卡 / dlv 卡 / run 卡的独立推送）：`标题 · 阶段 · 最近意见 · [测试部署] [打回] [发布]`；Run 结果作为同一话题里的**进展条目**追加。
- 详情折叠行（可选）：`dlv-… / task-… / PR #3 / 测试地址`。

### 7.8 CLI（待确认）

建议保留机器命令（`ai task approve`、`ai delivery release`、`ai task publish`），仅聊天面收敛——排障与自动化仍需要它们，且 CLI 不影响用户交互清晰度。

## 8. 分期

| 期 | 内容 | 用户可见结果 |
| --- | --- | --- |
| **P1（最小可用）** | 打回支持 DONE（不受 attempts 限制）+ 提示词渲染最近意见 + `constraints` 去重 reviews | 现在这条 `dlv-c2eaf5d883` 就能"打回 → 带意见重跑" |
| **P2（交互重写）** | 需求解析层 + 话题锚点（迁移 013）+ 出站只走 reply-in-thread + 5 动词命令目录 + 卡片去 id + 删除旧命令 | 完全不出现 id；所有消息集中在一个话题 |
| **P3（可选）** | 需求短码、新需求入口的措辞、交付级批量打回 | 极端场景的便利 |

> P1 的两处代码已在工作区草拟（`reviewService.requestChanges` 接受 DONE；`contextBuilder` 渲染最近意见并从 `Constraints` 去掉 reviews），**尚未提交**，等本方案定稿后并入。

## 9. 变更清单（文件级）

| 文件 | 变更 |
| --- | --- |
| `src/requirement/application/resolver.ts` | 新增：需求解析层 |
| `src/command/schema.ts` + `src/command/handlers/*` | 新增 `requirement.*`；删除聊天面旧命令 |
| `src/command/llmIntentEngine.ts` | 意图目录整篇重写（5 动词、无 id） |
| `src/command/intentTriage.ts` | 确定性规则改为无 id 形态：`打回` / `测试部署` / `发布` / `进展` / `重跑` |
| `src/conversation/*` + `migrations/013` | `anchor_message_id`；需求 ↔ 话题绑定 |
| `src/server/session.ts` + `reply.ts` + `notifications.ts` | `ChatTarget` 带锚点；出站统一 reply-in-thread |
| `src/review/application/reviewService.ts` | 打回接受 DONE、不受 attempts 限制、RELEASED 守卫 |
| `src/agent/contextBuilder.ts` | 最近意见单独成段；`Constraints` 去 reviews |
| `src/channel/rendering/*` | 需求卡；进展条目；去 id |
| `docs/deployment-feishu.md` | 交互章节整体替换 |

## 10. 测试与验收

**单测 / 集成**

```text
requirement resolver   话题绑定 / 歧义候选 / 显式 id（按钮）
command catalog        旧命令被拒并回帮助卡；5 动词可用；角色校验
outbound routing       一律 reply-in-thread；锚点缺失时降级 + 告警
review service         DONE→READY（不受 attempts 限制）/ RELEASED 拒绝 / 重复打回拒绝
context builder        最近意见成段；旧意见不再进 prompt
schema migration       013 幂等
```

**手工验收（真实飞书）**

1. 新建需求 → 所有回执都在同一话题；
2. 在主时间线里补一句意见 → 回复仍落在原话题；
3. 测试部署 / 发布 / 打回 全部用无 id 动词完成；
4. 打回后自动重跑，Run 卡片出现在同一话题；
5. 用旧写法 `测试部署 dlv-…` → 得到引导而不是执行。

## 11. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 锚点消息被删除（飞书侧） | 降级为普通发送 + 告警事件；卡片里给出"重建话题"入口 |
| 用户仍用旧 id 命令 | 不执行，回一句引导（不报错） |
| 跨话题输入导致上下文混乱 | 回复里回显"你说：…"，并把该消息并入需求上下文 |
| 打回误伤（多开发点） | 先问 scope；无法判定时也先问 |
| 迁移 013 出错 | 纯 `ADD COLUMN IF NOT EXISTS`，幂等；回滚 = 停止使用该列 |

## 12. 待确认

1. **CLI 是否一并收敛**？（建议：否——CLI 保留机器命令，只在聊天面删除）
2. **"详情"里是否保留 `dlv-…` / `task-…`**？（建议：保留，仅排查用）
3. **"新需求"入口**：已上线后再改，直接描述即可自动开新需求，还是要求显式 `新需求：…`？（建议：直接描述）
