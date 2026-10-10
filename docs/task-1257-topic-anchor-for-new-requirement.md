# TASK-1257 新需求必须换话题锚点（会话绑定）

> 现场证据：§1（2026-10-09 生产库 `conv-63e508dfcb` / `conv-bb97f8e963`）。
> 设计：[conversation-binding-design.md](conversation-binding-design.md)。
> 相关：TASK-1243（话题锚点）、TASK-1244（user-level 动作）、TASK-1250（新需求不依赖旧需求）。

## 1. 现场

两个需求挤进了同一条飞书话题：

```text
05:15  面包屑需求（无 thread）       → chat 级会话 conv-63e508dfcb，锚点=05:15
05:28  同一需求在话题里重发          → 会话 conv-bb97f8e963（thread omt_19adf…）
09:08  专辑页间距需求（无 thread）   → 回到 conv-63e508dfcb，绑定新问题
       ……锚点仍是 05:15 的面包屑消息 ⇒ 新需求的卡片被 reply-in-thread 到旧话题
09:26  「部署到测试环境」（在该话题里）→ 判给面包屑需求 ⇒ 对已上线交付报 patch 失败
```

## 2. 根因

"新需求换锚点"这条不变量只写在**旧命令路径**里（`server/session.ts` 中 `result.type === "problem.create"` 那段）。TASK-1244 之后新需求走的是 user-level `create` 动作 → `handleRequirementAction()` → 内部 dispatch `problem.create` 后直接 `return true`，那段换锚点代码永远执行不到。

次要诱因：`intent` 的上下文是该会话**最近 12 条消息**。chat 级会话会轮转承载不同需求，旧需求的对话混在窗口里，模型更容易把新需求读成"补充"。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 换锚点抽成 `ChatSession.anchorNewRequirement()`，**两条路径共用**（`problem.create` 成功即换，且本轮回复改到新锚点） | `src/server/session.ts` |
| D2 | 上下文按锚点裁剪：`ConversationService.contextSinceAnchor()`，锚点消息本身保留（它是需求描述）；锚点缺失时退回最近 N 条 | `src/conversation/service.ts`、`src/server/index.ts` |
| D3 | **不在别人话题里开新需求**：`create` 动作 + 该会话已绑定需求 + 消息来自话题 → 不落单，回一句"这像是个新需求，请在群里直接发一遍"，让用户在主聊天开新话题 | `src/server/session.ts` |

## 4. 不做（边界）

- 不为 `parent_id`/`root_id` 新建会话（会把历史切碎，TASK-1243 的既有取舍）；引用指代留作 P3。
- 不在"别人话题里"静默改绑该话题（那正是事故本身），也不静默开单。
- 显式点名与多候选询问（P2 剩余部分）不在本次范围：需要"本 chat 活跃需求"查询，单独一期做。

## 5. 验证

```text
tests/serverSession.test.ts       新需求把锚点移到触发消息（回复也随之落进新话题）；
                                 话题里说新需求 → 不建问题、回话点名当前需求
tests/conversationService.test.ts contextSinceAnchor 只给当前话题的消息（含锚点）
npm run typecheck / npm test      全绿
```

历史数据的补救：已错位的 chat 级会话（如 `conv-63e508dfcb`）锚点仍是旧消息；需要时把锚点改为"当前 subject 对应问题的首条相关消息"。本次未跑迁移脚本（P3）。
