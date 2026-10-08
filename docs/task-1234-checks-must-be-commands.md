# TASK-1234 task 的 checks 必须是可执行命令

> 现场证据：§1（2026-10-08 生产库，`task-spec-e13a0f2517-0`）。
> 相关：TASK-1220（可执行验收）、TASK-1224（work item 整理）、TASK-1232（规划粒度）。

## 1. 现场

规格推导给任务带的 checks：

```text
[ "npm test",
  "npm run lint",
  "在运行应用的开发者工具中选取面包屑 sep 元素，断言
   getComputedStyle(el).marginLeft === '16px' && …（或等效的 padding/gap 组合）" ]
```

验证器把每条 check 原样交给 `sh -lc` 执行（`verification/runner.ts`），于是第 3 条：

```text
sh: 1: Syntax error: "(" unexpected     (exit 2)
```

三次 attempt 全部 `verification failed`（agent 自身 exit 0），任务进 BLOCKED，交付被卡在
`dlv-c2eaf5d883 = BLOCKED`。除了这条人工步骤，另两条 `npm test` / `npm run lint` 也失败
（`playwright: not found`、`tsc: not found`）——那是仓库执行档案缺"验证前装依赖"的问题，
单独按 §4 处理。

## 2. 根因

三处都假设"check 一定是命令"，但没有任何地方检查过：

| 位置 | 问题 |
| --- | --- |
| `server/specificationBootstrap.ts` `derivePrompt` | 只说 "executable check (a command or an assertion)"，同一段又要求"用问题同语言书写"，模型于是写出中文人工步骤 |
| `specification/application/workItems.ts` `repairWorkItems` | 规则 2「没有可执行 check 的条目不是交付物」只看 `checks.length`，从不判断内容 |
| `verification/acceptance.ts` `acceptanceChecksOf` | 只要数组非空，所有验收标准都算 `verified`；一条无法执行的人工步骤也能"证明"改动 |

## 3. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 新增纯函数 `isExecutableCheck()`：空/多行、CJK 或全角字符、以句末标点结尾 → 不是命令 | `domain/specification.ts` |
| D2 | 规划前先过滤 checks；全被过滤掉的条目按规则 2 变成"无 check 条目"（并入相邻交付物），而不是变成注定失败的任务 | `specification/application/workItems.ts` |
| D3 | 验收证据只认可执行 check；只有人工步骤时标准标为 `unverifiable` 并要求人工验收，绝不谎称 `verified` | `verification/acceptance.ts` |
| D4 | 提示词写明契约：checks 是 `sh -lc` 在仓库工作区里原样执行的命令，即使规格其它部分是中文也必须写成 ASCII 命令 | `server/specificationBootstrap.ts` |

为什么用确定性规则而不是再问一次模型：与 TASK-1232 / `intentTriage` 一致——可复现、
可审阅；误判的代价是**保守**的（条目降级成无 check，并入相邻交付物，信息不丢）。

D3 同时修好了**已经存在**的任务：过滤发生在执行路径上，历史数据里的人工步骤不会再被当成
shell 命令去跑。

## 4. 不做（边界）

- 不改 `verification/runner.ts` 的语义（每条 check 仍原样执行）——过滤放在它之前。
- 不改"验证前装依赖"：`repo-x-music` 的验证命令仍是仓库注册项的事，属执行档案配置，
  不在本次代码范围内（见 §5 的运维动作）。
- 不新造 check 类型（`executable` / `manual`），也不改 `VerificationCheck` 状态枚举。

## 5. 验证与运维

```text
tests/workItems.test.ts        命令 vs 人工步骤的判定；带人工步骤的条目降级并入
tests/acceptanceEvidence.test.ts 只有人工步骤时标准为 unverifiable、要求人工验收
```

`npm run typecheck` / `npm test` 全绿。

运维侧（部署后）：`repo-x-music` 的验证命令要自带安装步骤并放行 npm registry，
否则任务里的 `npm test` / `npm run lint` 仍会 `not found`：

```bash
node dist/cli/index.js repository update repo-x-music \
  --verify "node scripts/check-docs.mjs" \
  --verify "npm ci --no-audit --no-fund && npm test" \
  --allow api.deepseek.com --allow registry.npmjs.org
```
