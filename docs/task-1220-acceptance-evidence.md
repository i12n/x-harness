# TASK-1220 可执行验收（acceptance → checks + 证据包）

> 上级设计：[autonomy-redesign.md](autonomy-redesign.md) §4.3。
> 前置：TASK-1224 已让任务携带自己的 acceptance 子集与 `constraints.checks`。

## 1. 现状

| 事实 | 证据 |
| --- | --- |
| 验收标准只进 agent 提示词 | `task.acceptance` 仅被 `agent/contextBuilder.ts` 拼进 prompt |
| 门禁只有仓库级命令 | `Verifier.run()` 执行 `repository.verificationCommands` |
| 任务级检查没人跑 | TASK-1224 写进 `task.constraints.checks`，目前没有任何消费者 |
| 5 条验收 vs 1 条命令 | x-music 实测：acceptance 5 条，实际门禁 `node scripts/check-docs.mjs` |

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 任务级 `checks` 与仓库命令**一起跑**：仓库命令是回归底线，任务 checks 是本次变更的证明 | 两者语义不同，都要跑；失败都算验证失败 |
| D2 | run 结果新增 **acceptance 证据**：每条验收标准 → `verified` / `unverifiable` + 用到的 checks | 「验收确认」变成看证据，不是凭感觉点通过 |
| D3 | 任务**没有声明 checks** → 其验收标准标记 `unverifiable`，并置 `requiresHumanAcceptance` | 机器判不了的显式说出来，交给 TASK-1221/1222 升级给人 |
| D4 | 验收证据**不影响** Run 成败（门禁仍是全部 checks 通过） | 自动通过/升级是评审环节的事（TASK-1221/1222），先只把证据做出来 |
| D5 | 「改了行为却没改测试」的元检查**推迟**，与 TASK-1223 的交付级证据一起做 | 它需要 diff 来源接入证据管线，单独做会在错误层次上打补丁 |

## 3. 证据包形状

```json
{
  "verification": { "passed": true, "checks": [...] },
  "acceptance": {
    "requiresHumanAcceptance": true,
    "criteria": [
      { "criterion": "移动端按钮与标签之间可见明显空隙",
        "status": "verified", "checks": ["node scripts/check-docs.mjs"] },
      { "criterion": "桌面端渲染与修改前一致",
        "status": "unverifiable", "checks": [] }
    ]
  }
}
```

## 4. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/verification/acceptance.ts` | `buildAcceptanceEvidence(criteria, checks)` 纯函数 |
| `src/verification/targetVerifier.ts` | 请求新增 `acceptanceChecks`，与仓库命令一起执行并记录 |
| `src/worker/worker.ts` | 从 `task.constraints.checks` 取任务检查；把 acceptance 证据写进 run.result |
| `src/channel/rendering/run.ts` | run 卡展示验收证据；`requiresHumanAcceptance` 时显式标注 |

## 5. 验收（可执行）

1. 任务声明 checks → 这些命令真的被执行（TargetVerifier 单测断言请求内容）。
2. 有 checks → 每条标准 `verified`；无 checks → `unverifiable` 且 `requiresHumanAcceptance=true`。
3. 任务 checks 失败 → Run 仍 FAILED（门禁不变）。
4. run 卡出现验收区块，并在需要人验收时明确写出来。

## 6. 回滚

证据是附加字段，旧 reader 忽略即可；任务没有 `constraints.checks` 时行为与今天一致
（只是验收标准被标为 `unverifiable`）。
