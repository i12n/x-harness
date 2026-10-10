# TASK-1266 澄清卡一次答完，提交后不再展示已答问题

> 现场：2026-10-10 `prob-e99be828e2`（x-music 下载功能）——一次分析产出了 3 个问题，
> 但卡片被发了三遍：1 张初始 + 2 张"还剩几题"的重发卡。
> 用户要求：一次答完；提交过的问题**不再展示**。

## 1. 根因

1. 卡片每组选项各带一个「提交选择」（`payload.clarificationId` 单个），`ConfirmationLoop.answer()` 也只接受一个澄清；想一次答完做不到。
2. 每答一题，handler 返回 `problem + 剩余 clarifications` → 渲染层把**整张卡**重新渲染并作为**新消息**发出（不更新原消息），所以 3 题 = 3 次提交 = 3 张卡。

## 2. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | **一卡一提交**：每个问题是一个 toggle 组（带问题文本作标题），卡片底部只留一个「提交全部答案」 | `channel/rendering/problem.ts`、`channel/message.ts`（`submit` 变可选）、`channel/feishu/cards.ts`、`channel/cli/adapter.ts` |
| D2 | 提交时把**所有已勾选组**一次转成多条 `problem.clarification.answer`（复用单题路径，校验/授权/“全部关闭才重新分析”的规则不变） | `server/session.ts` `submitAllClarifications()` |
| D3 | **提交后不再展示已答问题**：把更新后的卡片作为卡片回调的响应返回（飞书就地更新原消息，不新增消息）；未答的题目保留、标题计数改为"还剩 N 项" | `server/session.ts` `rebuildClarificationCard()` |
| D4 | 已答内容压成**一行摘要**（方案 B）：`✅ 已确认 2 项：下载程度=仅需按钮 · 音质=默认自动`，既可回溯又不占版面 | `channel/rendering/problem.ts` `answeredLine()` |
| D5 | 只有 analyzer **新问了没见过的题**时才再发新卡；全部答完则交给既有的"规格已就绪"流程 | `server/session.ts` |
| D6 | 批量里的多条命令各自使用稳定的幂等键 `<messageId>#<clarificationId>`，否则会被 `channel:messageId:type` 去重合并成一条；连点两次仍然幂等 | `server/session.ts` |
| D7 | 命令结果带上 `answered` 摘要，任何路径重渲染卡片（例如直接打字回答）都不会再打印已答问题 | `command/handlers/problem.ts`、`server/reply.ts` |

## 3. 不做（边界）

- 不做自由文本问题的内联输入框：仍是"直接回复文字"，但卡片会为它单独起一行提示。
- 不做必答未选的强拦截：未勾选的题目留在卡上并显示"还剩 N 项"，用户可分批提交（服务端仍要求必答项关闭后才能确认）。
- 不引入飞书 message patch：D3 复用卡片回调的响应就地更新，无需额外权限。

## 4. 验证

```text
tests/clarificationForm.test.ts           两问一提交：卡片只剩记录行、无 choice 组；
                                          只勾一题：保留另一题并显示"还剩 1 项"；
                                          一题未勾：提示且不派发命令
tests/problemConfirmationPipeline.test.ts 卡片渲染：组内无 submit、卡级有「提交全部答案」；
                                          问题文本随组展示
npm run typecheck / npm test              全绿
```
