# TASK-1263 飞书文案统一中文

> 状态：**已实现**（`src/channel/rendering/copy.ts` + 全部渲染器 + 单测）。

## 1. 问题

同一张卡片里中英文混排，用户读不懂现在发生了什么、该做什么：

```text
run-2877ce4260 SUCCEEDED
Status: SUCCEEDED
**Reviewer**
🔁 评审要求返工 —— ...
**Acceptance**
- ✓ ...
**Workspaces**
✓ x-music (primary)
Verification: PASS
check: npm test → passed (exit 0)
```

三个具体毛病：

1. **状态词是机器枚举**：`SUCCEEDED` / `RUNNING` / `REVIEW` / `IN_PROGRESS`
   直接进群，用户得自己翻译。
2. **区块标题半英半中**：`Status` / `Reviewer` / `Acceptance` / `Workspaces`
   与「验收」「工作区」混着出现，同一件事两种叫法。
3. **角色/空态也是英文**：`(primary)`、`(not released)`、`(no targets)`。

## 2. 目标

一句话：**用户在群里看到的每一个字都是中文**，且同一件事永远同一种说法。

由此定下三条规则：

| # | 规则 | 理由 |
| :-- | :-- | :-- |
| R1 | **状态一律中文**，Run 状态描述"这次运行"，不描述需求 | `SUCCEEDED` 只代表"这次跑完了"，评审仍可能打回；写成"执行完成"才不会让人误以为交付完成 |
| R2 | **机器值不翻译**：`run-…` / `task-…` / `spec-…` / `dlv-…` / `prob-…` 和 shell 命令原样保留 | 这些是用户要发回来的指令与排查句柄 |
| R3 | **未知状态回退原值**，不吞掉 | 新增状态时最多是"难看"，不会变成空白 |

## 3. 唯一来源

所有对外文案集中在 `src/channel/rendering/copy.ts`；渲染器只做拼接，不再写字面量。

```text
copy.ts
├── RUN_STATUS_LABELS          Run 状态
├── TASK_STATUS_LABELS         Task 状态
├── SPECIFICATION_STATUS_LABELS
├── DELIVERY_STATUS_LABELS
├── RELEASE_STATUS_LABELS
├── PROBLEM_STATUS_LABELS
├── CHECK_STATUS_LABELS        验证命令结果
├── REVIEW_VERDICT_LABELS      评审结论（短）
├── SECTION                    区块标题
└── *_label() / targetRoleLabel() / noteLabel()
```

## 4. 状态词表

### Run（`run-…`）

| 机器值 | 群里显示 |
| :-- | :-- |
| QUEUED | 排队中 |
| STARTING | 启动中 |
| RUNNING | 开发中 |
| VERIFYING | 验证中 |
| SUCCEEDED | 执行完成 |
| FAILED | 执行失败 |
| TIMED_OUT | 执行超时 |
| CANCELLED | 已取消 |
| LOST | 已失联 |

### Task / Specification / Delivery / Problem

| 类型 | 机器值 → 显示 |
| :-- | :-- |
| Task | INBOX→待开始 · READY→待执行 · RUNNING→开发中 · VERIFYING→验证中 · REVIEW→待评审 · BLOCKED→已阻塞 · FAILED→失败 · DONE→已完成 |
| Specification | DRAFT→草稿 · READY→待拆解 · PLANNED→已拆解 · SUPERSEDED→已作废 |
| Delivery | PLANNED→已计划 · IN_PROGRESS→开发中 · READY_FOR_RELEASE→待发布 · BLOCKED→已阻塞 · RELEASED→已上线 |
| Release | PENDING→进行中 · RELEASED→已发布 · CANCELLED→已取消 |
| Problem | INBOX→已提交 · ANALYZING→分析中 · NEEDS_INPUT→待你确认 · ANSWERED→已回答 · CONFIRMED→已确认 · INVESTIGATING→调研中 · SPECIFIED→已出规格 · READY→待开发 |

### 验证与评审

| 机器值 | 显示 |
| :-- | :-- |
| check `passed` / `failed` / `skipped` / `pending` | 通过 / 未通过 / 跳过 / 待运行 |
| verdict `approve` / `request_changes` / `needs_human` | 通过 / 要求返工 / 需人工判断 |
| target role `primary` / `supporting` | 主仓库 / 辅助仓库 |

## 5. 区块标题

`状态`、`评审结论`、`验收标准`、`工作区`、`目标仓库`、`验证`、`依赖`、
`被谁阻塞`、`阻塞链`、`最近一次失败`、`任务`、`计划`、`需求`、`摘要`、
`描述`、`发布`、`失败原因`、`问题`、`允许列表`、`执行档案`。

同一概念只有这一个写法：例如「验收标准」既用于 Run 卡片，也用于规格卡片与交付卡片。

## 6. 改后示例

同一张卡片（Run 成功但评审要求返工）：

```text
run-2877ce4260 执行完成
run-2877ce4260
状态：执行完成
**评审结论**
🔁 评审要求返工 —— 功能接线与任务一致，但缺测试覆盖…
**验收标准**
- ✓ 列表每个歌曲项都有下载按钮
- ? 列表页不存在「下载全部」
**工作区**
- task-…-target-0 · /root/ai-workspaces/… (ai/…-t0)
✓ x-music (主仓库)
工作目录：/workspace
验证：通过
检查：npm test → 通过 (exit 0)
```

## 7. 测试

- `tests/feishuCopy.test.ts`：
  - 每张状态表都被覆盖，且文案必须是中文、不等于枚举值本身（新增状态没写文案会失败）；
  - 未知状态回退原值；
  - 五类卡片（Run / Task / Specification / Delivery / Problem）的渲染结果里
    不允许再出现 `Status:`、`**Reviewer**`、`(not released)` 等英文残留。
- 原有断言（`tests/rendering.test.ts`、各 Phase E2E）已同步为中文。

## 8. 验收

```bash
npm run typecheck
npm test
```

## 9. 与其它设计的关系

- 卡片结构与「下一步 / 一键按钮」见
  [stage-next-step-design.md](stage-next-step-design.md)（TASK-1259）；本任务只改措辞，不改交互。
- 需求外部句柄 `prob-…` 见
  [requirement-interaction-redesign.md](requirement-interaction-redesign.md)。
- 消息渲染模型见
  [conversational-interface.md](conversational-interface.md) §7。

## 10. 领域错误文案

`src/errors.ts` 里的领域错误文案也已改成中文（`没有找到任务：task-…`、
`没有找到交付：dlv-…` 等），并保留了机器 id。这批字符串同时被 CLI 复用
（`src/cli`），所以 CLI 的输出也跟着变中文——这是有意的：同一个原因在
CLI 与飞书两处说法一致。
