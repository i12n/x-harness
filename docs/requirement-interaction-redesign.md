# 需求交互重设计：一个对象、一个话题、随便怎么说

> 状态：**P1 + P2 已实现（未部署）** —— 见 §8 的分期表与文末「已落地清单」。
> 编码：`review.requestChanges` 接受 DONE（TASK-1242）、话题锚点（TASK-1243）、
> 能力型意图 + 需求解析层 + 动作映射（TASK-1244）。
> 取代：[conversational-interface.md](conversational-interface.md) 里"命令按层划分"的交互约定。
> 关联：[autonomy-redesign.md](autonomy-redesign.md)（自动开发链路）、[task-1223-delivery-acceptance.md](task-1223-delivery-acceptance.md)（交付验收）、[task-1231-deploy-monitoring.md](task-1231-deploy-monitoring.md)（测试环境与部署）、TASK-1239/1240/1241（发布策略与测试分支）。

## 0. 一句话

用户只跟**需求**打交道；**一个需求只有一个话题**，所有回执、Run 结果、评审意见、部署通知都落在同一个话题里；用户**想怎么说就怎么说**——不带 id、不背动词，意图由 LLM 理解，不可逆动作再确认一次。

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
| D5 | **不限定任何动词/句式**：用户随便说，LLM 负责理解意图。能力表（show/reject/deploy/publish/rerun/create/chat/clarify）只是**内部实现**，不对用户暴露，也不要求用户学习 | 限定动词只是把"不知道说什么"从 id 换成了措辞；用户不该背命令表 |
| D6 | `打回` 接受 `REVIEW` 与 `DONE`；**人工打回不受 attempts 上限约束**；交付已 `RELEASED` 时拒绝打回（引导开新需求） | DONE 之后的测试环境验收才是最常见的"不满意"入口；attempts 是防机器空转，不是防人 |
| D7 | 提示词里**单独渲染"最近一次验收意见"**，`Constraints` 不再重复整份 reviews | 让"打回 → 重跑"真的生效；顺带省 token |
| D8 | 卡片主文案只有**标题 + 阶段 + 待办动作**；`dlv-…` / `task-…` 仅在"详情"折叠行 | id 是排查用的，不是交互用的 |
| D9 | **不可逆动作（部署 / 发布 / 打回）一律二次确认**：机器人先把"我理解成…"回给用户，点确认才执行；读不清意图就反问 | LLM 会误判——把误判的代价从"被合并上线"降到"多问一句" |

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
你  ：上测试环境看看效果              ← 随便说，没有固定句式
机器人：🚀 测试环境：http://47.100.5.48:18080/（同一个 PR，不必记分支名）
你  ：可以了，合并吧
机器人：确认把「面包屑分隔符间距」合并上线？[确认发布] [再等等]   ← 不可逆动作二次确认
你  ：（点确认）
机器人：✅ 已上线「面包屑分隔符间距」
```

同一件事的其它说法（都走同一条路，用户不需要知道有"动词"这回事）：

```text
推测试环境 / 部署到测试环境验收一下 / 上测试环境看看效果
间距还是不行，得再大点 / 验收不通过，移动端还是挤 / 帮我改一下，间距改成 24px
通过 / 通过了 / 可以合并 PR 了 / 验收通过，发吧 / 是不是可以上线了（提问 → 只回答状态）
现在到哪一步了 / 帮我看看现在什么状态 / 测试环境地址是什么
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
旧习惯：      你「测试部署 dlv-c2eaf5d883」→ 机器人：我按当前需求推测试环境了（正在处理「面包屑分隔符间距」）
说不清：      你「可以」→ 机器人：你是说测试通过可以发布，还是要再改一处？[可以发布] [还要改]
问句：        你「可以上线吗？」→ 机器人：可以，测试环境已就绪（PR #3）——要我发布吗？
```

## 7. 技术方案

### 7.1 内部能力（**不是**用户要学的词表）

意图模型的动作集合 —— 注意：这是给模型看的"能做什么"，不是给用户看的"该怎么说"。

| action | 参数 | 角色下限 | 说明 |
| --- | --- | --- | --- |
| `show` | `{}` | 全部 | 需求卡（当前话题；歧义时给候选） |
| `reject` | `{ feedback?, scope?: "all" \| "item", item? }` | reviewer/admin | 打回；`scope` 仅在多开发点时出现 |
| `deploy` | `{}` | reviewer/admin | 推测试分支并开/更新 PR |
| `publish` | `{}` | reviewer/admin | 合并发布（仅"待发布"阶段） |
| `rerun` | `{}` | developer+ | 逃生口：重新跑一次 |
| `create` | `{ statement }` | 全部 | 用户在描述新的事 |
| `chat` | `{ reply? }` | 全部 | 闲聊 / 概念问答 / 无匹配能力 |
| `clarify` | `{ question, options? }` | 全部 | 意图不明或不可逆动作读不准 |

旧命令（`review.*` / `delivery.*` / `deploy.*` / `task.*` 的聊天入口）**从聊天面删除**；命令层实现保留（CLI 用）。

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

### 7.6 意图处理（本方案的核心）

**给模型的上下文**（不是给用户的）：

```text
当前需求：<标题>
阶段：澄清中 / 开发中 / 待验收 / 待发布 / 已上线
最近消息：本话题最近 N 条（含机器人卡片摘要）
    ↓
模型输出：{ action, 参数, reason }
```

**判断规则（决定误判率的地方）**：

1. **疑问句绝不执行**：含 `吗 / ？ / 为什么 / 是不是 / 能不能 / 怎么` 的句子是"想了解情况"——
   能用 `show` 回答就 `show`，否则 `chat`；**任何疑问句都不得触发不可逆动作**。
2. **极短模糊句**（`可以 / 行 / 好 / 嗯 / ok / 批准` 这类看不出对象的）→ `clarify`（给按钮）。
3. **不可逆动作必须有明确动作意图**；读不出来就 `clarify`，不猜。
4. **描述别的事/新的事** → `create`（开新需求），不要塞进当前需求。
5. **没有能力匹配**（例如"回滚"）→ `chat`，不要硬塞到相近能力。
6. 阶段决定语义：同一句话在不同阶段含义不同（"可以上线了"在待发布=发布意图；"可以上线吗？"=提问）。

**二次确认（D9 的落地）**：`deploy / publish / reject` 由机器人先把"我理解成…"回给用户，
点确认才执行；只读动作（`show`）直接执行。这样模型误判的代价是"多问一句"，不是"被合并上线"。

**实测（2026-10-09，真模型 `deepseek-v4-flash`，生产上下文）**

```text
语料：33 条用户真会说的话（打回/部署/发布/查看/重跑/闲聊/问句/旧 id 写法/新需求）
第 1 版提示词（只给能力表）            26/31    危险误判 2 条：
    「可以上线吗？」→ publish（疑问句被执行）
    「可以」→ publish（模糊句被执行不可逆动作）
第 2 版（加入上面 6 条规则）            30/33    危险误判 0 条
    剩余 3 条为良性偏差：「上测试环境看看」→ show（该说 deploy，会由二次确认纠正）；
                        「先别发」「这个需求先放着」→ chat（本来就没有对应能力）
```

结论：**能力表 + 这 6 条规则 + 二次确认**是可行组合；误判集中在"疑问/模糊"两类，且都被规则或确认拦住。
这套语料要作为**回归资产**固化（见 §10）。

### 7.6.1 Run 提示词

把 `constraints.reviews` 里的**最近一条**单独成段（`Latest review feedback (the reason this run exists — address it): …`），并从 `Constraints` JSON 中去掉 reviews。

### 7.7 卡片

- **需求卡**（取代 task 卡 / dlv 卡 / run 卡的独立推送）：`标题 · 阶段 · 最近意见 · [测试部署] [打回] [发布]`；Run 结果作为同一话题里的**进展条目**追加。
- 详情折叠行（可选）：`dlv-… / task-… / PR #3 / 测试地址`。

### 7.8 CLI（待确认）

建议保留机器命令（`ai task approve`、`ai delivery release`、`ai task publish`），仅聊天面收敛——排障与自动化仍需要它们，且 CLI 不影响用户交互清晰度。

## 8. 分期

| 期 | 内容 | 用户可见结果 |
| --- | --- | --- |
| **P1（最小可用）** | 打回支持 DONE（不受 attempts 限制）+ 提示词渲染最近意见 + `constraints` 去重 reviews | 现在这条 `dlv-c2eaf5d883` 就能"打回 → 带意见重跑" |
| **P2（交互重写）** | 需求解析层 + 话题锚点（迁移 013）+ 出站只走 reply-in-thread + **能力型意图目录（§7.6）+ 不可逆动作二次确认 + 意图语料回归** + 卡片去 id + 删除聊天面旧命令 | 用户随便说；不出现 id；所有消息集中在一个话题 |
| **P3（可选）** | 需求短码、新需求入口的措辞、交付级批量打回 | 极端场景的便利 |

> P1 的两处代码已在工作区草拟（`reviewService.requestChanges` 接受 DONE；`contextBuilder` 渲染最近意见并从 `Constraints` 去掉 reviews），**尚未提交**，等本方案定稿后并入。

## 9. 变更清单（文件级）

| 文件 | 变更 |
| --- | --- |
| `src/requirement/application/resolver.ts` | 新增：需求解析层 |
| `src/command/schema.ts` + `src/command/handlers/*` | 新增 `requirement.*`；删除聊天面旧命令 |
| `src/command/llmIntentEngine.ts` | 意图目录整篇重写（5 动词、无 id） |
| `src/command/intentTriage.ts` | 确定性规则改为无 id 形态：`打回` / `测试部署` / `发布` / `进展` / `重跑` |
| `tests/fixtures/intentPhrasings.json` + `scripts/eval-intent.mjs` | 意图语料与联网评估（发版前跑） |
| `src/conversation/*` + `migrations/013` | `anchor_message_id`；需求 ↔ 话题绑定 |
| `src/server/session.ts` + `reply.ts` + `notifications.ts` | `ChatTarget` 带锚点；出站统一 reply-in-thread |
| `src/review/application/reviewService.ts` | 打回接受 DONE、不受 attempts 限制、RELEASED 守卫 |
| `src/agent/contextBuilder.ts` | 最近意见单独成段；`Constraints` 去 reviews |
| `src/channel/rendering/*` | 需求卡；进展条目；去 id |
| `docs/deployment-feishu.md` | 交互章节整体替换 |

## 10. 测试与验收

**意图语料回归（新增，固化 §7.6 的 33 条）**

```text
tests/fixtures/intentPhrasings.json   33 条：{ text, stage, expect, allowAlso? }
tests/requirementIntent.test.ts       离线：断言规则（疑问句 ≠ 不可逆动作、模糊句 → clarify）
scripts/eval-intent.mjs               联网：跑真模型，输出命中率 + 未命中清单（人工复核）
CI 时不跑联网版；发版前手动跑一次，命中率下限 90% 且"危险误判=0"
```

**单测 / 集成**

```text
requirement resolver   话题绑定 / 歧义候选 / 显式 id（按钮）
intent routing         疑问句 → 只读；模糊句 → clarify；不可逆动作 → 二次确认卡；角色校验
command catalog        旧命令不再被识别（回引导，不执行）
outbound routing       一律 reply-in-thread；锚点缺失时降级 + 告警
review service         DONE→READY（不受 attempts 限制）/ RELEASED 拒绝 / 重复打回拒绝
context builder        最近意见成段；旧意见不再进 prompt
schema migration       013 幂等
```

**手工验收（真实飞书）**

1. 新建需求 → 所有回执都在同一话题；
2. 在主时间线里补一句意见 → 回复仍落在原话题；
3. 用**任意说法**（不是固定动词）完成测试部署 / 发布 / 打回，且不可逆动作都出现二次确认；
4. 打回后自动重跑，Run 卡片出现在同一话题；
5. 用旧写法 `测试部署 dlv-…` → 得到引导而不是执行。

## 11. 风险与回滚

| 风险 | 处理 |
| --- | --- |
| 锚点消息被删除（飞书侧） | 降级为普通发送 + 告警事件；卡片里给出"重建话题"入口 |
| 用户仍用旧 id 命令 | 不执行，回一句引导（不报错） |
| 模型误判意图 | 只读动作（show）直接执行；`deploy/publish/reject` 一律二次确认；模糊/疑问一律反问（§7.6 实测：危险误判 0） |
| 跨话题输入导致上下文混乱 | 回复里回显"你说：…"，并把该消息并入需求上下文 |
| 打回误伤（多开发点） | 先问 scope；无法判定时也先问 |
| 迁移 013 出错 | 纯 `ADD COLUMN IF NOT EXISTS`，幂等；回滚 = 停止使用该列 |

## 12. 待确认

1. **CLI 是否一并收敛**？（建议：否——CLI 保留机器命令，只在聊天面删除）
2. **"详情"里是否保留 `dlv-…` / `task-…`**？（建议：保留，仅排查用）
3. **"新需求"入口**：已上线后再改，直接描述即可自动开新需求，还是要求显式 `新需求：…`？（建议：直接描述）

> 原先第 4 条"动词收敛为 5 个"已作废：改为**不限定动词**，由 LLM 理解意图（D5 / §7.6）。

## 13. 已落地清单（截至 2026-10-09，**未部署**）

| 决策 | 实现 | 位置 |
| --- | --- | --- |
| D6 打回支持 DONE、人工不受 attempts 限制 | ✅ | `src/review/application/reviewService.ts` |
| D6 RELEASED 冻结 | ✅（`deliveryStatusForTask` 端口，服务端 + CLI 接线） | 同上、`src/domain/specificationPlan.ts` |
| D7 最近意见单独成段 / Constraints 去 reviews | ✅ | `src/agent/contextBuilder.ts` |
| D2 需求 = 话题（锚点） | ✅（迁移 013 + 会话/通知出站统一 reply-in-thread） | `migrations/013_conversation_anchor.sql`、`src/conversation/service.ts`、`src/server/session.ts`、`src/server/index.ts` |
| D5 不限定动词（能力型意图） | ✅（8 个动作 + §7.6 六条规则；提示词不含任何 id） | `src/command/llmIntentEngine.ts`、`src/server/intentTriage.ts` |
| D5 需求解析层 | ✅ | `src/requirement/application/resolver.ts` |
| 动作 → 内部命令映射（阶段门禁 + 反问） | ✅（`reject` 多开发点先问、`publish` 只在待发布、RELEASED 引导开新需求） | `src/requirement/application/actions.ts` |
| D8 卡片去 id | ✅（需求卡主文案只有标题 + 阶段 + 动作；id 仅在 `includeIds` 详情行） | `src/channel/rendering/requirement.ts` |
| D4 旧命令不再面向用户 | ✅（模型不再产出 id 命令；用户粘 id 时忽略并回一句引导） | `src/server/session.ts`（`pastedIdHint`） |
| 语料回归资产 | ✅（33 条 fixture + 离线测试 + 联网评估脚本；**未跑联网版**） | `tests/fixtures/intentPhrasings.json`、`tests/requirementIntent.test.ts`、`scripts/eval-intent.mjs` |

**部署前还要做的**：跑一次 `node scripts/eval-intent.mjs`（需要 `npm run build` 与线上同源的
`AI_LLM_*`），确认命中率 ≥ 90% 且危险误判 = 0——这是 §10 的放行条件。命令层仍保留机器命令
（卡片按钮、CLI、脚本都在用），只是不再出现在用户面前。
