# TASK-1238 验证侧的持久缓存（npm + 前端构建）

> 现场证据：§1（2026-10-08 生产库 attempt 6/7/8/9）。
> 前置：[task-1236](task-1236-prompt-context-budget.md) / [task-1237](task-1237-harness-contract-in-prompt.md)。

## 1. 现场

提示词优化后（TASK-1236/1237），一次 Run 的耗时结构变成：

```text
attempt 8   agent 118s + 验证 135s = 255s   （输入 token 511k，改动 3 文件）
attempt 9   agent 207s + 验证 114s = 322s   （输入 token 835k，改动 3 文件）
```

**验证占 114~152 秒，接近一半，而且每次内容完全相同**：Run 容器从只读根文件系统 +
tmpfs `HOME` 启动，每个 attempt 都在全新 worktree 里重新 `npm ci`（167 包 / 33s）+
`npx prisma generate` + `next build`（~80s）。

## 2. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 执行层为每个 Run 额外挂**该仓库**的缓存目录：`<AI_CACHE_DIR>/<repoId>/npm → /ai-cache/npm`、`.../next → <每个 target 的 workdir>/.next/cache` | npm 与 Next 都靠这两处缓存；worktree 仍然是一次性的 |
| D2 | 注入 `npm_config_cache` / `NPM_CONFIG_CACHE` / `NEXT_TELEMETRY_DISABLED` | 让工具真的用上挂载点，不用改仓库的验证命令 |
| D3 | 目录由 harness 创建并 `chown 1000:1000`（容器 uid） | 容器跑非 root；root 拥有的目录对它只读 |
| D4 | `AI_CACHE_DIR` 可配，默认 `/var/cache/ai-harness`；**只挂该仓库目录**，不是整个缓存根 | 保持"只挂当前 Run 相关路径"的隔离边界（见 remote-execution-isolation.md §5.1） |
| D5 | 隔离标志（`--read-only`、`--cap-drop ALL`、非 root、无 docker.sock）全部不变 | 缓存挂载是**追加**，不是放宽 |

## 3. 不做

- 不做镜像级预热（给每个仓库烤一个带 `node_modules` 的镜像）——需要仓库专属构建流程，
  收益与 D1 重叠。
- 不缓存 `node_modules` 本身（并发 Run 共享可变目录会出错），只缓存包与构建产物。
- 不改仓库的验证命令（仍由 `ai repository update --verify` 决定跑什么）。

## 4. 验证

```text
tests/executionCache.test.ts   根目录默认/覆盖、key 不允许穿越、目录创建、按 target 挂载、幂等
tests/dockerExecution.test.ts  缓存挂载与 env 出现在 docker run 参数里，且隔离标志不变
```

预期：第一次 Run 冷启动（填充缓存）与现在持平，**第二次起** `npm ci` 从 33s 降到几秒级、
`next build` 因 `.next/cache` 命中而显著变快。实测数据见 §5（部署后补）。

## 5. 实测

第一次上线（attempt 10）**失败**了一个有价值的原因：挂载 `.next/cache` 时，docker 以
root 创建了缺失的 `/workspace/.next`，容器用户（uid 1000）随后写 `.next/trace` 报
`EACCES`。修法是 harness 在启动容器前**自己创建 `<worktree>/.next/cache` 并 chown 1000:1000**
（D3 的同一原则），并只在仓库声明了 build 命令时才挂构建缓存。

```text
attempt 9   （无缓存）  agent 207s + 验证 114s = 322s
attempt 10  （冷缓存，因 .next 属主失败）
attempt 11  （热缓存）  → 实测见下
```
