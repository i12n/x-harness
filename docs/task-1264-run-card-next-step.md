# TASK-1264 Run 卡片自带「接下来」

> 状态：**已实现**。设计与阶段表见
> [stage-next-step-design.md](stage-next-step-design.md) §7.1。

## 问题

用户收到的 Run 卡片只有"发生了什么"，没有"接下来做什么、我要做什么"：

```text
run-2877ce4260 执行完成
状态：执行完成
**评审结论**
🔁 评审要求返工 —— ...
```

点评审返工后 harness 已经自动重跑了下一轮，但卡片没说，用户只能自己去猜。

根因有二：

1. 渲染器只拿得到 `Run`，而"会不会自动重跑 / 是不是停下来等人"是
   `settleAfterReview` 在 Run 结束之后才写进 **Task** 的，Run 自己不知道；
2. P1（TASK-1259）的提问卡只在「待验收」发一张，其它阶段（返工、失败、卡住）
   没有下文。

## 实现

```text
worker 结束 Run
   └─ settleAfterReview 写 Task 状态（READY / REVIEW / BLOCKED / DONE）
RunChatNotifier.flush()
   ├─ describeRunNextStep(run)        server/index.ts：查 Task 状态 + 需求阶段
   │     └─ 决策点 → requirementActionPlan() 的主文案 + 按钮（同源）
   ├─ renderRunMessage(run, { nextStep })     → 卡片里的 **接下来**
   └─ followUp 只在派生不出来时兜底（避免与卡片重复）
```

渲染器还有一层兜底 `defaultNextStep(run)`：调用方没给 `nextStep` 时，用
`run.result.review` 的结论拼一句保守的话（例如"按评审意见自动重跑一轮"），
保证任何 Run 卡片都不是死胡同。

## 卡片形态

```text
run-2877ce4260 执行完成
状态：执行完成
**接下来**
- 会自动：已自动排下一轮（第 2 轮，最多 3 轮）
- 需要你：不用你操作，这一轮的结果我会发在这里。
**评审结论**
🔁 评审要求返工 —— ...
```

需要人决策时，同一张卡片直接给按钮：

```text
**接下来**
- 需要你：改动已完成，等你评审：看下面的改动，点「通过」或「打回修改」。
[通过] [打回修改]
```

## 验收

```bash
npm run typecheck
npm test
```

- `tests/rendering.test.ts` > "Run card next step (TASK-1264)"：
  带 `nextStep` 时渲染「会自动 / 需要你」与按钮；不带时用兜底文案；
  任何卡片都必须含「接下来」。
