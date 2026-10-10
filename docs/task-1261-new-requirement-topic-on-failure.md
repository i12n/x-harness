# TASK-1261 建单失败也要开新话题；JSON 截断自动加预算

> 现场：2026-10-10 用户重发「x-music 添加下载歌曲功能」后，机器人回了
> `❌ problem.create failed: handler_error — problem analyzer returned no valid JSON: Unexpected end of JSON input`，
> 而且这条回执**又落回了旧话题**。
> 相关：conversation-binding-design（会话绑定）、TASK-1257（成功建单时换锚点）、TASK-1251（输出额度逐级升到上限）。

## 1. 根因（两个）

1. **模型输出被截断**：分析器要求 JSON（`response_format=json_object`），模型在 `finish_reason=length` 时只写了一半对象；`parseJsonObject` 切到最后一个 `}` 再解析 → `Unexpected end of JSON input`。`ChatClient` 只在**内容为空**时加预算重试，非空的截断 JSON 不在覆盖范围内。
2. **失败路径不换锚点**：TASK-1257 的换锚点发生在 `problem.create` **成功**之后。建单失败 → 锚点不动 → 回执（以及下一次重试）继续挂在旧话题上。

## 2. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | JSON 模式 + `finish_reason=length`（内容非空但被截断）→ 与"空内容"同等待遇：逐级加预算重试；到上限才把原文交给调用方去报解析错误 | `llm/chatClient.ts` |
| D2 | `create` 动作的回复**从触发它的那条消息开新话题**，成功与否都如此（成功时锚点也随之落在这条消息上） | `server/session.ts` |

## 3. 不做（边界）

- 不在这里改分析器的提示词/结构：截断是输出预算问题，不是提示词问题（提示词由 TASK-1236 单独处理）。
- 不为失败请求改会话 subject：需求没建成，会话仍属于原需求；只是"这条消息的回复"不再污染旧话题。

## 4. 运维（历史遗留锚点）

`conv-63e508dfcb` 的锚点还停在 2026-10-09 05:15 那条**被放弃的面包屑消息**上（当时换锚点的代码还没跑通），所以它的话题归属是错的。一次性纠正：

```sql
UPDATE conversations
   SET anchor_message_id = '<该会话当前 subject 的触发消息 id>', updated_at = now()
 WHERE id = 'conv-63e508dfcb';
```

## 5. 验证

```text
tests/llmChatClient.test.ts   JSON 截断 → 换更大预算重试；到上限才把原文返回给调用方
tests/serverSession.test.ts   建单失败时，回执的 replyToMessageId 仍是这条新消息（不是旧话题锚点）
npm run typecheck / npm test  全绿
```
