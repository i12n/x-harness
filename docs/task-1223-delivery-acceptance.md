# TASK-1223 交付验收（Delivery 级证据聚合 + 一次人确认）

> 上级设计：[autonomy-redesign.md](autonomy-redesign.md) §4.3 / §5。
> 前置：TASK-1220 验收证据、TASK-1221/1222 评审结论与升级策略。

## 1. 缺口

现在人看到的是**每个 Run 的卡片**：一个一个看、一个一个判断。任务级证据齐了，
但没有任何地方把它们聚合成"这次交付到底证明了什么"，也没有一个地方能让人**一次**
完成验收。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 交付视图聚合每个任务的：状态、验收证据（verified / unverifiable）、评审 verdict、风险 | 人验收看的是"整批交付证明了什么"，不是 N 张 Run 卡 |
| D2 | `requiresHumanAcceptance` = 任一任务有不可验证标准 / 评审 needs_human / 任务未完成 | 与 TASK-1221 的边界保持一致：机器判不了才找人 |
| D3 | 确认动作复用**既有** `delivery.release`（人评审、幂等、只允许 READY_FOR_RELEASE） | 不新增不可逆动作，也不新增命令 |
| D4 | 交付卡提供「确认验收并发布」按钮；未就绪时不提供按钮，只列出待办 | 人只需要一次点击 |

## 3. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/delivery/application/acceptance.ts` | `buildDeliveryAcceptance()`：聚合（任务 + 最近 Run 的验收证据与评审结论） |
| `src/command/handlers/delivery.ts` | `delivery.show` 产出 acceptance 视图（注入 runs 端口） |
| `src/channel/rendering/delivery.ts` | 渲染验收区块；就绪时给出一次确认按钮（`delivery.release`） |
| `src/server/index.ts` | 把 `runs` 接进 delivery handler |

## 4. 验收（可执行）

1. 全部任务 DONE 且证据齐全 → 卡片列出每条验收标准的结论，并提供一次确认按钮。
2. 有 `unverifiable` / needs_human / 未完成任务 → `requiresHumanAcceptance=true`，
   卡片写明原因，不给按钮。
3. 已 release 的交付不再显示按钮。
4. 不是 READY_FOR_RELEASE 时不给按钮（`delivery.release` 本来就拒绝，UI 不再诱导）。

## 5. 回滚

验收视图只是 `delivery.show` 的附加字段；渲染缺省与今天一致，不传 acceptance 即回退。
