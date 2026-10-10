# TASK-1260 富文本（post）消息不再被忽略

> 现场：2026-10-10 用户在飞书发「x-music 添加下载歌曲功能：歌曲列表…」整段需求后，机器人完全没反应。
> 日志证据：`[ai-harness] ignoring event: unsupported message type: post`。

## 1. 根因

飞书把**带格式的正文**（列表、标题、粘贴进来的多段文字）用 `message_type = "post"` 发送，纯文字才是 `"text"`。`parseFeishuEvent` 只接受 `text`，其余一律 `ignored`——事件被丢掉，用户看到的是"机器人死了"。

第二条问题：被忽略的事件只写日志，**不回复**，所以用户无法区分"没收到"和"收到了但读不懂"。

## 2. 修复

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | `post` 也当作正文解析：取 `title` + 每行所有 segment 的文本（`text`/`a` 取 text，`at` 渲染 `@名字`，`img`/`media` 用 `[图片]` 占位，`emotion` 忽略）；兼容 v1 扁平结构与 v2 按语言包装（`zh_cn`） | `channel/feishu/events.ts` `extractPostText()` |
| D2 | 仍然读不了的消息（图片、文件、表情…）**回一句**说明，不再静默；只在 1:1 会话里回，避免群里每条图片都被念一遍 | `server/session.ts` `explainUnsupportedMessage()` |

## 3. 不做（边界）

- 不解析图片/文件内容（需要额外下载与多模态，超出范围）：只回答"读不了，请用文字"。
- 不把 `post` 转成 markdown 回显：只取纯文本给意图层，避免把飞书 segment 混进提示词。

## 4. 验证

```text
tests/feishuThreading.test.ts   post（v2 分语言 / v1 扁平）解析出正文、@ 与 [图片] 占位
tests/serverSession.test.ts     图片消息 → 回「只认纯文字」，不再静默
npm run typecheck / npm test    全绿
```
