# TASK-1236 基础提示词不再注入整个 docs/ 目录

> 现场证据：§1（2026-10-08 生产库 + 线上 dist 实测）。
> 相关：TASK-1215（usage 采集 / 按日预算）、TASK-1217（执行档案）。

## 1. 现场

同一台机器上 8 次 Run 的 usage（`RunUsage` 事件，`parseAgentUsage` 逐次调用累加）：

```text
run-85b94c566f  29 次调用   2,608,949 in / 11,051 out   243s   （一行 CSS 改动）
run-aa7a46f758  —           5,307,853 in / 17,467 out   281s
run-295a06bb1c  —           5,517,256 in / 23,465 out   827s
run-5627523d52  —           3,428,709 in / 21,955 out   153s
```

进/出比约 **200:1**：2.6M ÷ 29 ≈ 每次调用提示词 **9 万 token**。

用线上 dist 直接量同一条推导路径的基础提示词（workspace = 真实的 x-music 检出）：

```text
prompt_bytes = 259,841   prompt_chars = 146,450   ≈ 87k token
```

## 2. 根因

`src/agent/contextBuilder.ts` 的 `collectProjectInstructions()` 除了根级
`AGENTS.md` / `PROJECT.md` / `README.md`，还**递归读取 `docs/**/*.md` 全文**并整段贴进
提示词（上限 `MAX_INSTRUCTION_BYTES = 256 KB`）。x-music 的文档树是 **40 个文件 /
483,813 字节**（`docs/06-context/handoff.md` 单文件 99,582 字节），于是每次模型调用都
带着一份 ~87k token 的"仓库文档"，任务本身只占其中几千 token。

agent 在一个 turn 里跑 ~29 次调用（24 次命令执行），每次都要重发这份上下文，成本按调用
次数线性放大——**不是泄漏，是结构性的**。次要放大器：`AI_TOKEN_BUDGET_PER_DAY` 未配置，
agent 还会主动 `cat` 大文档（整段输出此后一直留在上下文里）。

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | `docs/**` 只注入**路径索引**（≤4 KB），不注入内容 | `src/agent/contextBuilder.ts` |
| D2 | 根级指令文件仍**原文注入**，总预算 256 KB → **32 KB**（多仓每仓 96 KB → 16 KB） | 同上 |
| D3 | 提示词明确"只读需要的文件，不要整篇 cat" | 同上 |
| D4 | 不改执行层、不加环境变量、不改 `Task`/`AgentContext` 契约 | 边界 |

理由：agent 在 worktree 里有 shell，本来就能自己读文件；把它需要的**目录索引**给它，
比替它把整座文档库塞进每次调用更省，而且不影响可发现性。

## 4. 验证

```text
tests/contextBuilder.test.ts       文档内容不入提示词、路径索引在；20 篇大文档的仓库
                                   prompt 仍 < 8 KB（回归）
tests/contextBuilderMulti.test.ts  多仓：指令按仓注入、文档只索引、内容不出现
```

改前后用同一脚本量同一棵树：`259,841 → 待补（部署后实测）` 字节。

## 5. 不做

- 不做 RAG / 向量检索（plan 一：v0.1 明确不做）。
- 不动 codex 自身的 tool 输出（那是 agent 行为，靠 D3 约束）。
