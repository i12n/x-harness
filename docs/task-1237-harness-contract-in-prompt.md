# TASK-1237 提示词只留"harness 契约"，仓库指令交给 agent 自己加载

> 现场证据：§1（2026-10-08 生产库 run-aa7a46f758 / run-02bb75e4c8 + codex 实测）。
> 前置：[task-1236-prompt-context-budget.md](task-1236-prompt-context-budget.md)。

## 1. 现场

TASK-1236 把 `docs/**` 全文换成路径索引后，基础提示词 259,841 → 7,506 字节，但同一条
任务的下一次 Run **更贵**：

```text
attempt 6（260KB prompt）  2,608,949 in / 11,051 out / 243s
attempt 7（7.5KB prompt）  5,086,610 in / 31,769 out / 791s
```

原因：agent 转而**自己去读**文档（该轮 `06-context` 出现 10 次、`project-state.md` 3 次），
轮次从 ~29 涨到更多，而且它忠实执行了 x-music `AGENTS.md` 的流程——读 4 篇上下文、
更新看板/changelog/handoff/project-state、原子提交、再挑下一个任务。10 个改动文件里 7 个是文档。

同时实测确认：**codex-cli 0.154.0 会自己加载工作目录的 `AGENTS.md`**——给一个只放
`AGENTS.md`（内含 `MAGIC-CONTRACT: ZQ7-ALPHA`）的目录，提示词里不含任何仓库内容，
`codex exec` 仍答出 `ZQ7-ALPHA`（446 tokens）。harness 再注入一遍是重复。

## 2. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 主工作区的 `AGENTS.md`/`PROJECT.md`/`README.md` **不再注入**；多仓的 supporting 仓库仍注入 | agent CLI 自己会加载 cwd 的指令文件；但从仓挂在别的路径，发现机制到不了 |
| D2 | 提示词新增**Harness contract** 固定段：harness 之后会跑哪些验证命令、"不要新增/改写 package.json 脚本来让检查通过"、网络范围、"没有浏览器与数据库"、只做最小改动、**不要提交/推送**、**看板/changelog/handoff 由 harness 负责** | 这些是部署事实，仓库里没有；上一轮 agent 自作主张加 `"test": "playwright test"`，以及把一半精力花在文档流程上 |
| D3 | 冲突时以 contract 为准（仓库 `AGENTS.md` 里那套"完成后的自动推进工作流"在 Run 内不适用） | 交付与记账归 harness，agent 只负责改动 |
| D4 | 提示词的稳定段（指令/索引/契约）位置固定，任务相关内容在后 | 便于 provider 前缀缓存命中 |

## 3. 不做（本次边界）

- **不给每个任务点名 1~3 篇相关文档**：那需要 `SpecificationWorkItem` → plan item →
  `task.constraints` → 提示词的字段贯通（多一层模型输出与校验）。先用 D2/D3 观察 agent 是否
  还会去散读；若仍然散读，再补这条。
- 不改 codex 自身的上下文管理（工具输出仍会沉淀进它的会话）。

## 4. 验证

```text
tests/contextBuilder.test.ts       · 指令文件内容不出现在提示词里（AGENTS.md 由 CLI 加载）
                                   · 契约包含验证命令、package.json 禁令、git 禁令、记账禁令
tests/contextBuilderMulti.test.ts  · 主仓用指针行、从仓仍注入自己的指令并各自分组
                                   · 超限仍有截断标记，offending 文件在从仓
```

改前后用同一脚本量同一棵树（x-music）：`7,506 → 待补（部署后实测）` 字节；并重跑同一条
任务对比 `inputTokens` / 调用次数 / 时长 / 改动文件数。
