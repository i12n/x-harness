# TASK-1233 规格推导失败：推理模型把输出额度耗尽在 reasoning 上

> 现场证据：§1（2026-10-08 生产库实测）。
> 影响面：`SpecificationBootstrap` 的规格推导（`AI_AUTO_BOOTSTRAP_SPECIFICATION`
> 默认开）与所有走 `ChatClient` 的控制面调用（意图解析、问题分析、评审 agent）。

## 1. 现场

群聊里确认问题后，机器人回：

```text
⚠️ 问题已确认，但无法生成规格：chat completion returned empty content
（通常是因为没有可用的目标仓库；请在对话里点名要改的仓库，或先用 CLI 注册仓库）
```

两处事实与文案不符：

| 现象 | 事实 |
| --- | --- |
| 文案断言"没有可用的目标仓库" | `repo-x-music` 早已注册，`specification.created` 事件里 target 就是它 |
| 报错是"模型没输出" | 连续两次（`05:30:42`、`05:34:05`）都是同一句 |

## 2. 根因

部署用的是推理模型（`AI_LLM_MODEL=deepseek-v4-flash`）：它先产出隐藏的
`reasoning_content`，而 `max_tokens` 覆盖 **reasoning + 正文**。当推理把额度吃光时，
接口**仍然返回 HTTP 200**，但正文为空：

```json
{"choices":[{"message":{"content":"","reasoning_content":"We need answer JSON only…"},
             "finish_reason":"length"}],
 "usage":{"completion_tokens":60,
          "completion_tokens_details":{"reasoning_tokens":60}}}
```

同一请求用 `max_tokens` = 60 / 24 / 8 三次实测均可复现（`reasoning_tokens` 等于
全部 `completion_tokens`，`content` 为 `""`）。harness 侧 `extractContent` 只认
`choices[0].message.content`，于是抛 `chat completion returned empty content`；
会话层再把它当成"缺仓库"报给用户，把人引到错误方向。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 正文为空时**按输出额度翻倍重试一次**（2048 → 4096，上限 8192） | `src/llm/chatClient.ts` `complete()` |
| D2 | 仍失败则抛**可操作的错误**：带 `finish_reason`、额度与 `reasoning_tokens` | `emptyContentError()` |
| D3 | `parseCompletion()` 保留 `finish_reason` / `reasoning_tokens`，`extractContent()` 语义不变 | 同上 |
| D4 | 会话层的 ⚠️ 提示按**真实原因**分流：模型失败 ≠ 仓库缺失 | `src/server/session.ts` `specificationFailureHint()` |

为什么重试放在 `ChatClient` 而不是调用方：这是**传输层产物**，调用方无法与"模型
确实没话说"区分；放在这里只多花一次调用，`SpecificationBootstrap` /
`ProblemAnalyzer` / 评审 agent 同时受益。模块仍是"只做传输"，只多了这一条额度策略。

## 4. 不做（边界）

- 不新增 `ChatClient` 通用重试/退避策略（HTTP 4xx/5xx 语义不变）。
- 不改默认 `max_tokens`（2048），也不引入新的环境变量。
- **不修**另一个独立问题：`SpecificationBootstrap.complete()` 在 `markReady`
  失败时会留下一份 DRAFT 规格（例如 `spec.create` 建出的空验收标准规格）。
  那是规划/就绪链路的问题，另行处理。

## 5. 验证

```text
tests/llmChatClient.test.ts   reasoning-only 响应 → 第二次调用 max_tokens 翻倍
                              额度已到上限 → 只调一次并抛出说明 token 的错误
tests/serverSession.test.ts   推导失败时 ⚠️ 文案指向模型，而不是仓库
```

`npm run typecheck` / `npm test` 全绿（803 passed）。
