# 待讨论设计议题（记录，未定稿）

> 记录于 2026-09-10，来自 Harness 开发过程中的讨论。以下内容仅作备忘，
> 均未进入实现或定稿，后续需要再议。
>
> 2026-09-16 更新：整体路线已确定，见
> [v0.2 Roadmap](v0.2-roadmap.md)。

## 议题 1：需要决策时如何与 Codex 交互

> 详细设计稿（2026-09-16）：
> [Problem Confirmation Loop](problem-confirmation-loop.md)。

**问题**：非交互式 `codex exec` 是一次性子进程，人在 loop 外；任务执行中
Codex 遇到需要决策的场景（需求歧义、范围外改动、外部副作用、凭据、方案
取舍）时，Harness 应该用什么方式与它交互？

**倾向结论（草案）**：

- 原则：Codex 是执行者/建议者；Harness 持有状态与决策权。Codex 进程退出
  只代表“agent 执行结束”，不代表任务完成——决策同理，Codex 只能上报，
  不能替 Harness 定 workflow 状态。
- 决策前置：Context Builder 的 prompt 增加“决策权限”段，明确
  可自主决定 / 必须上报 / 不允许 三类事项。
- 沙箱划界：`read-only` / `workspace-write` / `danger-full-access` /
  `--approve-for-me` 决定 Codex 的自主边界；越界动作被拦下即成为上报或
  失败，而不是悄悄发生。
- 中途决策协议：prompt 指示 Codex 需要决策时不要猜，以固定标记结束回合
  （如 `DECISION_REQUEST` + question/options/recommendation/reason）。
  Worker 从 `--json` 输出检测标记，Task 进入等待决策态，记录
  `DecisionRequested` 事件（含 thread id），Run lease 需要冻结或区分，
  避免被 Loop 误判为 LOST。
- 与 REVIEW 的区别：REVIEW = 实现+验证完成等人审批；DECISION = 中途卡住
  等人选方向。两者都要过 Human，语义不同。
- 人决策后续跑：`ai task decide <id> --option ... --reason ...`，决策写入
  task constraints（可留痕，已有 appendTaskReview/事件机制），下轮 prompt
  自动带上；更优方向是 `codex exec resume <thread_id>` 续同一会话（thread
  id 可从 `thread.started` 事件解析并存入 run result）。

**待再议**：

- 状态命名：新增 `AWAITING_DECISION`，还是复用 `BLOCKED` + reason？
- 续跑方式：开新一轮 Run vs resume 同一会话？
- headless exec 下审批请求的实际行为需要真实探针验证（现在有可用 API key）。

## 议题 2：Harness 是否是“需求分析 → 上线”全链路

**现状结论：不是。** 当前实现覆盖：

```text
Task（形式化）→ Run → Workspace → Codex 改码 → Verification
→ Review → 人工 approve → DONE
```

- 需求分析在 harness 之外：`task create` 只录入，`validate` 只做形式校验
  （描述/验收/仓库可达）。把模糊意图变成可执行任务的工作由人或上游流程
  完成。
- 上线不在 harness 内：方案“暂时不做”明确排除自动部署/自动 Merge；
  v0.2 的 GitHub Integration 只覆盖到分支/PR。Task 到 DONE 即结束，
  无 push/PR/部署/回滚。

全链路分段对照：

1. 需求分析/任务规约 —— 外置
2. 任务拆解/排期 —— 只有雏形（task create/validate + 优先级调度）
3. 编码执行 —— 已实现
4. 验证 + Review —— 已实现
5. 审批 —— 已实现（approve/reject）
6. Merge / CI —— 未实现（GitHub Integration 仅覆盖前半步）
7. 部署上线 + 回滚 —— 未实现、未列入当前路线

**两条扩展方向（未定）**：

- 上游：需求采集/拆解 agent + 规约评审，产出仍是现有 Task 模型。
- 下游：DONE 之后新增发布阶段（GitHub PR → CI → 部署 → 回滚），
  需要环境、凭证与审批基础设施。

**待再议**：是否要往全链路走；若走，先做上游还是下游。
