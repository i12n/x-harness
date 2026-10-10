# TASK-1262 输出预算从 8192 起翻倍，最多试 3 次

> 现场：2026-10-10 分析器返回 `problem analyzer returned no valid JSON: Unexpected end of JSON input`——
> 模型在 `max_tokens=2048` 上被截断（`finish_reason=length`），半个 JSON 交给解析器。
> 取代：TASK-1233（空正文翻倍一次，上限 8192）、TASK-1251（逐级升到上限）。

## 1. 决策

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 默认预算从 **2048 → 8192**（推理模型常常在 2048 上只写完"思考"） | `llm/chatClient.ts` `DEFAULT_MAX_TOKENS` |
| D2 | 一次 completion 最多 **3 次尝试**，每次预算翻倍：**8192 → 16384 → 32768**（不再设 8192 上限） | 同上 `complete()` |
| D3 | 失败的判定包含两种情况：正文为空，以及 JSON 模式下的**截断**（`finish_reason=length` 且内容非空）。三次都失败 → 抛错，并把"最后一次预算 + reasoning 用量"写进错误信息 | 同上 `completionExhaustedError()` |

## 2. 为什么不是"到上限就把半个 JSON 交出去"

调用方（分析器、规格推导、意图解析）拿到的必须是能解析的 JSON；半个对象只会换来一个更难懂的解析错误，还要多一次往返。宁可明确失败：错误信息里带上次预算与 reasoning 用量，运维一眼能判断是该调大预算还是换模型。

## 3. 边界

- 不新增环境变量：预算策略是客户端常量（真要调，改常量或换模型）。
- 不改变"每次尝试都是独立请求"的语义：三次都按同一提示词重发，只是 `max_tokens` 翻倍。

## 4. 验证

```text
tests/llmChatClient.test.ts  8192→16384→32768 的预算序列；
                             JSON 截断同样触发加预算；
                             三次都失败 → 报错（含最后一次预算与 reasoning）；
npm run typecheck / npm test 全绿
```
