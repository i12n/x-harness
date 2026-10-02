# TASK-1226 证据式预览（构建证据 + 截图钩子）

> 上级设计：[preview-environment-design.md](preview-environment-design.md) §5。
> A 阶段：零基础设施改动，不碰生产 Caddy，不新增对外端口。

## 1. 要解决的问题

验收人现在只能看到"检查都过了"。对于"应用到底还能不能起来""页面长什么样"这类判断，
没有任何证据。而执行档案里 **`commands.install/test/build` 从 v0.1 起就没有消费者**。

## 2. 拍板决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 预览**不是常驻服务**，而是一次**一次性构建容器**：起 → 跑命令 → 收证据 → 停 | 不需要端口、TTL、反向代理；把 B 阶段（常驻预览）留给 TASK-1227 |
| D2 | 执行档案里声明什么就跑什么：`install` → `build` → `screenshot`（新增可选字段） | 让死字段复活；harness 不猜技术栈 |
| D3 | 截图由**仓库自己的脚本**产出（x-music 已有 playwright），harness 只负责跑它、收集文件 | 通用地驱动"起服务 + 截图"需要浏览器与端口编排，超出本期；仓库最清楚怎么截 |
| D4 | 网络在预览构建时放行包源（默认 `registry.npmjs.org`，可配 `AI_PREVIEW_ALLOW`），其余仍受限 | 构建需要装依赖；但预览不该有生产的网络自由度 |
| D5 | 资源上限比执行档案更保守（默认 1 CPU / 768MB，可配） | 生产机只剩 3.7G，预览构建不能把机器打死 |
| D6 | 失败**不阻塞**验收：没配构建 → `NO_BUILD`；命令失败 → `FAILED`，都如实写进证据 | 人可以只接受代码改动；证据的作用是让人知道现状 |
| D7 | 证据落在事件（`PreviewBuilt` / `PreviewFailed`）+ 交付视图 | 不新增表；交付卡读最近一次预览事件 |

## 3. 流转

```text
人：预览 dlv-x   （或交付卡上的入口）
      │
      ▼
PreviewService.build(deliveryId)
  1. 取交付首个必需任务的成功 Run → worktree 路径
  2. 读仓库执行档案：commands.install / build / screenshot
  3. install/build/screenshot 都没有 → NO_BUILD（不启动容器，写清原因）
  4. 起 preview 容器（同镜像、受限网络+包源、只挂该 worktree、1C/768M）
  5. 依次执行：install → build → screenshot
     每个命令记录：命令、退出码、耗时、输出尾部
  6. 收集产物：常见输出目录大小（.next/dist/build/out）、截图文件清单
  7. 停止并删除容器；写事件与证据
      │
      ▼
交付卡「预览」区块：状态 + 构建结论 + 截图路径/N 张 + 产物大小
```

## 4. 落点

| 文件 | 改动 |
| --- | --- |
| `src/domain/executionProfile.ts` | `commands.screenshot?`（新增可选字段） |
| **新增** `src/preview/application/previewService.ts` | 构建证据收集（纯逻辑 + 可注入的执行管理器） |
| `src/command/{types,schema}.ts` + `src/command/handlers/preview.ts`（新） | `preview.build {deliveryId}` |
| `src/channel/rendering/preview.ts`（新） | 证据卡渲染 |
| `src/server/index.ts` | 装配 PreviewService 与 handler |
| `src/command/llmIntentEngine.ts` + `src/server/intentTriage.ts` | 「预览 dlv-x」确定性入口 |

## 5. 验收（可执行）

1. 未配置任何构建命令 → `NO_BUILD`，不启动容器，证据写明"只有仓库验证命令的结论"。
2. install/build 成功 → `BUILT`，事件 `PreviewBuilt`，证据含每条命令的退出码/耗时/输出尾部。
3. build 失败 → `FAILED`，证据保留输出，交付卡写明"应用起不来"，**不影响**验收按钮逻辑。
4. 命令序列固定为 install → build → screenshot，缺哪个跳哪个。
5. 截图与产物清单来自 worktree（容器写、宿主可见），带文件数/大小。
6. 容器资源上限为配置值（默认 1 CPU / 768MB），网络为 restricted + 包源放行。

## 6. 回滚

`preview.build` 是新增命令与独立服务；不调用即完全没有影响。删除命令目录中的
`preview.build` 即回到今天的行为。
