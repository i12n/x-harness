# Problem Confirmation Loop（确认闭环）设计稿

> 来源：2026-09-16 讨论记录。状态：讨论稿、未实现。
> 关联：[docs/discussion-notes.md](discussion-notes.md) 议题 1（需要决策时如何与
> Codex 交互）与议题 2（Harness 边界与上游需求阶段）。
> 本文保持讨论原意整理，尚未定稿。

核心原则：

> **AI 负责发现“不确定性”，用户只需要确认那些会影响后续执行的问题。**

不要让用户填写一张很长的表单。

---

# 1. 整体流程

可以把 Problem Confirmation 设计成：

```text
Problem
  │
  ▼
AI 分析
  │
  ├── 信息足够 ──────────────► CONFIRMED
  │
  └── 存在关键不确定性
           │
           ▼
      生成 Clarifications
           │
           ▼
      用户回答 / 确认
           │
           ▼
      AI 重新分析
           │
      ┌────┴────┐
      │         │
   仍有问题    信息足够
      │         │
      └───循环──┘
                │
                ▼
            CONFIRMED
                │
                ▼
          Investigation
```

也就是说：

**确认不是一次性的步骤，而是一个循环。**

---

# 2. 什么情况下才需要让用户确认？

这是整个设计里最重要的一点。

AI 不应该看到任何未知信息就问用户。

例如用户说：

> 首页加载很慢。

AI 可以自己检查：

```text
不知道：
- 首页用了哪些 API？
- 是否存在 N+1 查询？
- 哪个接口慢？
- React 是否重复渲染？
```

这些属于**技术调查问题**。

不应该问用户。

Agent 可以直接：

```text
读取代码
    ↓
分析网络请求
    ↓
运行项目
    ↓
测量加载时间
    ↓
定位慢接口
```

但是下面这些问题，AI 通常无法自行决定：

```text
“慢”是指首屏还是整个页面？

是否允许修改后端 API？

是否允许修改数据库结构？

性能优化是否要求兼容旧浏览器？

这个行为是 Bug，还是产品设计本来如此？
```

这些属于**业务决策 / 范围决策**。

才需要 Confirmation。

所以可以定义一个判断：

```text
Unknown
   │
   ├── Agent 可以通过调查获得
   │       ↓
   │    Investigation
   │
   └── 必须由人决定
           ↓
       Clarification
```

---

# 3. Confirmation 的核心对象：Clarification

不要让 AI 直接输出：

> 请提供更多信息。

这种方式非常低效。

应该生成结构化的 `Clarification`。

例如：

```json
{
  "id": "CLAR-001",
  "problem_id": "PROB-001",

  "question": "你说的“加载很慢”具体是指哪一种情况？",

  "type": "scope",

  "required": true,

  "options": [
    {
      "id": "initial",
      "label": "首次打开页面很慢"
    },
    {
      "id": "interaction",
      "label": "页面打开后操作很慢"
    },
    {
      "id": "api",
      "label": "接口响应很慢"
    }
  ],

  "reason": "不同类型的问题需要调查不同的技术路径",

  "status": "OPEN"
}
```

用户只需要选择。

---

# 4. 尽量让用户“选择”，而不是“写”

例如：

### 不推荐

> 请详细描述一下登录问题。

### 推荐

> 登录问题属于哪一种？

```text
○ 无法登录
○ 登录成功但马上退出
○ 刷新页面后变成未登录
○ 部分账号无法登录
○ 其他
```

用户：

> 刷新页面后变成未登录。

然后 AI 继续。

---

# 5. 一个问题最好只确认一个决策

例如：

> 登录成功，但是刷新后变成未登录。

AI 不应该一次问：

> 请告诉我浏览器、操作系统、登录方式、Token 存储方式、是否使用 SSR、部署环境……

而应该：

### 第一个问题

> **刷新后变成未登录，是所有用户都会发生，还是部分用户发生？**

```text
○ 所有用户
○ 部分用户
○ 只有我
○ 不确定
```

用户：

> 所有用户。

然后 AI 可以继续调查代码。

如果调查后发现：

```text
发现：
Token 存在 localStorage
但是 AuthProvider 初始化时没有等待 token hydration
```

可能根本不需要继续问用户。

---

# 6. 可以把问题分成 4 类

我建议你的 Harness 中把 Confirmation 分成：

```text
Clarification
├── Fact       事实确认
├── Scope      范围确认
├── Decision   决策确认
└── Constraint 约束确认
```

## Fact

确认用户描述的事实。

```text
你说的“登录失败”具体是哪种情况？

○ 无法提交登录
○ 登录接口返回错误
○ 登录成功但页面仍显示未登录
○ 刷新后变成未登录
```

---

## Scope

确认影响范围。

```text
这个问题需要修复哪些环境？

○ 开发环境
○ 测试环境
○ 生产环境
○ 所有环境
```

---

## Decision

需要用户做选择。

```text
这个功能是否需要支持游客用户？

○ 是
○ 否
```

---

## Constraint

确认不能违反的条件。

```text
是否允许修改数据库结构？

○ 允许
○ 不允许
○ 需要先确认
```

---

# 7. Confirmation 不应该一直问

这里可以加入一个非常重要的机制：

## Minimum Sufficient Information

只要信息已经足够开始 Investigation，就应该停止询问。

例如：

```text
用户：
“登录成功，但是刷新页面后变成未登录。”

AI：

已确认：

Problem:
登录状态在页面刷新后丢失。

Expected:
登录成功后，刷新页面仍保持登录状态。

Scope:
所有用户。

Investigation:
可以直接检查认证状态初始化、Token 持久化和 Session 恢复逻辑。

Status:
CONFIRMED
```

不需要再问：

```text
你使用 Chrome 还是 Safari？
Mac 还是 Windows？
Token 是 JWT 还是 Session？
```

因为这些东西 Agent 可以自己检查。

---

# 8. AI 应该告诉用户“为什么要问”

这个非常重要。

不要：

> 是否允许修改数据库？

而是：

> 当前调查发现问题可能涉及用户 Session 表。
> 如果需要修改 Session 数据结构，需要调整数据库 schema。
>
> **是否允许本次任务修改数据库结构？**

```text
○ 允许
○ 不允许
○ 修改前需要再次确认
```

这样用户知道这个问题为什么出现。

---

# 9. Confirmation 的 UI 可以非常简单

我建议 MVP 不做复杂表单。

可以设计成：

```text
┌─────────────────────────────────────┐
│ 需要确认                             │
│                                     │
│ 登录成功后，刷新页面会变成未登录。     │
│                                     │
│ 这个问题是否所有用户都会发生？         │
│                                     │
│ ○ 所有用户                            │
│ ○ 部分用户                            │
│ ○ 只有当前用户                        │
│ ○ 不确定                              │
│                                     │
│             [确认]                    │
└─────────────────────────────────────┘
```

然后 AI 自动进入下一轮。

---

# 10. 用户也可以直接输入

选择只是默认方式。

例如：

```text
○ 所有用户
○ 部分用户
○ 不确定

其他：
[ 我只在 Safari 上遇到过 ]
```

AI 收到以后重新分析。

所以：

```text
Clarification
      ↓
User Answer
      ↓
Analysis
      ↓
New Clarification
```

而不是：

```text
Clarification
      ↓
直接进入 Task
```

---

# 11. 每轮确认都应该产生 Event

你的 Harness 已经有 `events`，这里正好可以利用。

例如：

```json
{
  "type": "problem.clarification.created",
  "problem_id": "PROB-001",
  "clarification_id": "CLAR-001"
}
```

用户回答：

```json
{
  "type": "problem.clarification.answered",
  "problem_id": "PROB-001",
  "clarification_id": "CLAR-001",
  "answer": {
    "option": "all_users"
  }
}
```

AI 重新分析：

```json
{
  "type": "problem.analysis.updated",
  "problem_id": "PROB-001"
}
```

最终：

```json
{
  "type": "problem.confirmed",
  "problem_id": "PROB-001"
}
```

这样整个确认过程都是可追踪的。

---

# 12. Problem 的状态机

我建议最终采用：

```text
INBOX
  │
  ▼
ANALYZING
  │
  ├───────────────┐
  │               │
  ▼               ▼
CONFIRMED     NEEDS_INPUT
  │               │
  │               ▼
  │          CLARIFICATION
  │               │
  │               ▼
  │          ANSWER_RECEIVED
  │               │
  │               ▼
  │           ANALYZING
  │               │
  └───────────────┘
          │
          ▼
      CONFIRMED
          │
          ▼
    INVESTIGATING
          │
          ▼
      SPECIFIED
          │
          ▼
        READY
```

不过 MVP 可以进一步简化成：

```text
INBOX
  ↓
ANALYZING
  ↓
NEEDS_INPUT ←────────┐
  ↓                  │
ANSWERED             │
  ↓                  │
ANALYZING ───────────┘
  ↓
CONFIRMED
  ↓
INVESTIGATING
  ↓
SPECIFIED
  ↓
READY
```

---

# 13. 最关键的一条：Confirmation 不是“审批”

这里最好把两个概念分开。

### Confirmation

确认：

> **“我和 AI 对这个问题的理解是一致的。”**

例如：

```text
问题：
刷新页面后登录状态丢失

预期：
刷新后仍保持登录

范围：
所有用户
```

用户确认。

---

### Approval

审批：

> **“我允许 AI 按这个方案修改代码。”**

例如：

```text
方案：

1. 修改 AuthProvider
2. 修改 Token hydration
3. 增加登录状态测试

预计修改：
src/auth/AuthProvider.tsx
src/auth/token.ts

[批准执行]
```

这属于后面的 **Review / Approval**。

所以：

```text
Problem Confirmation
        ↓
确认“是什么问题”
        ↓
Investigation
        ↓
确认“为什么”
        ↓
Specification
        ↓
Review / Approval
        ↓
确认“怎么做”
        ↓
Coding
```

这个分层非常重要。

---

# 14. 最终可以形成一个非常清晰的职责边界

```text
┌─────────────────────────────────────┐
│ User                                │
│                                     │
│ 提供问题、业务目标、约束、决策        │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│ Problem Confirmation                │
│                                     │
│ 把模糊问题变成“足够明确的问题”        │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│ Investigation Agent                 │
│                                     │
│ 查代码、运行项目、复现、找根因         │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│ Specification                       │
│                                     │
│ 把调查结果转成可执行 Task             │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│ Coding Agent / Codex                │
│                                     │
│ 修改代码、运行测试                   │
└─────────────────┬───────────────────┘
                  ↓
┌─────────────────────────────────────┐
│ Verification                        │
│                                     │
│ 用证据判断是否完成                   │
└─────────────────────────────────────┘
```

**所以，“待确认的问题”本质上应该由一个 `Clarification Engine` 管理，
而不是让 Codex 自己随意向用户提问。**

在你的 Harness 里，我会进一步把它抽象成：

```text
Problem
   ↓
Problem Analyzer
   ↓
Clarification Engine
   ↓
Human
   ↓
Problem Analyzer
   ↓
Confirmed Problem
```

然后再进入 Investigation。

这也使得以后做 CLI、Web UI，甚至让不同 Agent 参与确认，都可以复用同一套
`Problem / Clarification / Answer / Analysis` 数据模型。
