# TASK-1259 每完成一步问"下一步"，prob-… 作为唯一追踪句柄

> 设计：[stage-next-step-design.md](stage-next-step-design.md)。
> 现场：用户反馈"机器人只说当前状态，不知道下一步要做什么"；同一天又出现"在旧话题里发指令被判给别的需求"。

## 1. 问题

```text
机器人：✅ 测试环境就绪：dlv-9128847051   🧪 http://47.100.5.48:18080/
用户：（那我现在该干嘛？）——通过？发布？还是接着改？
```

1. 阶段完成只播报结果，不给下一步；动作全靠自然语言，等于要背动词表；
2. 用户在错误话题里发指令 → 判给别的需求（见 conversation-binding-design §0 的同一天事故）；
3. 卡住时只报失败，不给"重跑"入口。

## 2. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | **下一步文案与按钮同源**：`requirementActionPlan(view)` 给出每个阶段的动作、标签、以及"点下去会发生什么、产物在哪、大约多久" | `requirement/application/actions.ts` |
| D2 | 卡片 = 标题（带 `prob-…`）+ 证据行 + `👉 下一步…` + 按钮（`requirement.next`，value 带 `{requirementId, action, stage}`） | `channel/rendering/requirement.ts` |
| D3 | 按钮回调走与打字**同一条**动作管线（门禁 / 角色 / 二次确认），过期的卡片说"这步已经做过了" | `server/session.ts` `requirementNextAction` / `applyRequirementNext` |
| D4 | **`prob-…` 是外部句柄**：正则确定性提取（模型之前）、`resolveByProblemId()`、点名胜过话题绑定；其它机器 id 仍只出现在排查行 | `server/intentTriage.ts`、`requirement/application/resolver.ts`、`server/session.ts` |
| D5 | 结果回**需求自己的话题**（按 prob id 找会话），与卡片点在哪无关 | `server/session.ts` `requirementTarget`、`conversation/service.ts` `findBySubject` |
| D6 | 阶段完成主动发卡：Run 结束且需求到「待验收」→ 追问卡；交付 READY_FOR_RELEASE / BLOCKED → 发到需求话题（找不到才退回默认群） | `server/notifications.ts` `followUp`、`server/index.ts` 交付通知 |

## 3. 不做（边界）

- 不新增阶段枚举：BLOCKED 仍显示「开发中」，但重跑按钮可用（独立"卡住"阶段留 P2）。
- 按钮不做按角色隐藏（点了由授权层拒绝并说明），把门禁留在唯一一处。
- 不合并历史通知成"一张卡片"（P2）：现在仍是追加消息，但只在阶段变化时问一次。

## 4. 验证

```text
tests/requirementCard.test.ts        文案含具体下一步；按钮带 requirementId/action/stage；
                                    released 不再提问；机器 id 只在排查行
tests/serverSession.test.ts          消息点 prob id → 按 id 解析（不走话题绑定）；
                                    卡片按钮 → 触发 deploy.test；developer 点发布被拒
tests/requirementIdExtraction.test.ts 确定性提取（大小写、位置、不误伤 task-/dlv-/problem）
npm run typecheck / npm test         全绿
```
