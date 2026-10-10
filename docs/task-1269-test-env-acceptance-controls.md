# TASK-1269 测试环境就绪卡带「验收完成」与验收结果反馈

> 相关：[test-environment-deployment-plan.md](test-environment-deployment-plan.md) §5.4/§5.5、
> [task-1259-next-step-cards-and-prob-id.md](task-1259-next-step-cards-and-prob-id.md)、
> [task-1267-acceptance-change-as-revision.md](task-1267-acceptance-change-as-revision.md)。

## 1. 问题

测试环境部署成功后，用户收到的是一条**纯文本播报**：

```text
✅ 测试环境就绪：dlv-9121521df0
🧪 测试环境：http://47.100.5.48:18080/
打开链接即可验收（HTTP + IP + 端口，暂无鉴权）；数据为测试库，随部署更新。
工作流：https://github.com/i12n/x-music/actions/runs/38024069099
```

地址、验收入口都在，但卡片本身**没有动作**：

1. 验收通过要么去别的卡/别的消息里找「发布」按钮，要么自己打字「通过 / 上线」；
2. 想按验收意见调整，只能回一句话，harness 还得从自由文本里猜这是「打回 + 意见」；
3. 一条能验收的卡片，看起来却像一条只能读的通知。

## 2. 目标

把「验收」这一件事收在**这张卡片**上：

```text
✅ 测试环境就绪：dlv-9121521df0
🧪 测试环境：http://47.100.5.48:18080/
打开链接即可验收…
工作流：…

验收结果反馈
[ 要调整的地方写在这里（不用改可以不填） ]
[ 提交验收意见 ]

[ 验收完成 ]
```

- **验收完成**：一键走后续流程；
- **验收结果反馈**：一个输入框 + 提交按钮，把「验收后要调整什么」变成一次修订。

两条路径**都不需要用户再报需求 / 交付 id**：按钮和输入框各自携带同一个
`prob-…` 句柄（在渲染时就解析好），点击后仍走与打字完全相同的动作管线
（门禁、角色、过期判定一致）。

## 3. 映射

| 卡片元素 | 动作 | 何时可用 | 结果 |
| :-- | :-- | :-- | :-- |
| **验收完成** | `publish`（待发布）/ `approve`（待验收） | 需求处在 `awaiting_release` / `awaiting_acceptance` | 合并 PR → 触发线上发布；或先接受这轮工作 |
| **提交验收意见** | `reject` + `feedback`（输入框文本） | 同上 | 交付修订：新增一条修订任务，旧任务保持 DONE，同一个 PR 更新（TASK-1267） |

动作类型按**渲染时的实际阶段**决定（`awaiting_release` → `publish`，
`awaiting_acceptance` → `approve`），卡片把阶段一起带上，点击时若阶段已变，
沿用 TASK-1259 的「这步已经做过了——现在是 X」而不是误执行。

## 4. 落点

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 消息模型新增 `input` 块：一个字段 + 一个提交按钮，提交时把字段并入命令 payload | `channel/message.ts` |
| D2 | 飞书把 `input` 渲染成 `form` + `input` + `action_type: form_submit` 的按钮 | `channel/feishu/cards.ts` |
| D3 | 表单回传 `action.form_value` 折进按钮 value，命令处理层仍只看到一个 payload（同时兼容字段进 value 记录的旧/新形态） | `channel/feishu/cardActions.ts` |
| D4 | 测试环境**成功**过渡卡在需求处于决策点（待验收 / 待发布）时附带「验收完成」+ 反馈框；其余状态、线上部署仍是纯播报 | `channel/rendering/deploy.ts` |
| D5 | 解析交付 → 规格 → 需求，给出 `{requirementId, stage, action}`；决策点之外不附控件 | `server/index.ts` `notifyDeployTransitions` |
| D6 | `requirement.next` 把除路由键外的字段原样作为动作 payload 传给动作表（`feedback` 由此进入 `delivery.revise`） | `server/session.ts` |

## 5. 不做（边界）

- **不改动作语义**：验收通过与发布仍是两步（待验收 → 待发布 → 发布），
  测试环境就绪卡只是把「当前阶段该做的那一步」放到手边；
- **不改授权**：按钮不做按角色隐藏，点了由授权层拒绝并说明，门禁只有一处；
- **不给线上部署卡加控件**：已上线是冻结点，要改就开新需求；
- **不猜自由文本**：输入框为空提交时，明确回一句「要改哪儿？」而不是把空意见当修订。

## 6. 验证

```text
tests/deployTransitionMessage.test.ts  就绪卡带验收完成 + 反馈框；待验收=approve、
                                       待发布=publish；线上/无决策点=纯播报
tests/cardActions.test.ts              form_value 折进 payload；input 渲染成 form/form_submit
tests/serverSession.test.ts            反馈表单提交 → delivery.revise（携带原文 feedback）
npm run typecheck / npm test           全绿
```

## 7. 现场修复：Feishu 组件名必须唯一（TASK-1271）

上线后第一次真实"测试环境就绪"卡被飞书拒收（HTTP 400），原因很具体：

```text
code 230099 · ErrPath: ROOT -> elements -> [2](tag: form) -> elements -> [0](tag: input)
ErrMsg: name(feedback) duplicate
```

飞书把 `form` / `input` / `button` 的 `name` 放在**同一个命名空间**：表单容器和
输入框都叫 `feedback`，整张卡就构建失败——不是控件不受支持，也不是"部署中"
卡的问题（那是纯文本，能发）。修复：表单容器改名 `${name}_form`（`input` 仍是
`${name}`、提交按钮 `${name}_submit`），三者唯一。回归用例
`tests/cardActions.test.ts` > "gives every named element a unique name" 递归收集
卡内所有 `name` 并断言不重复。
