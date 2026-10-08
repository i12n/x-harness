# TASK-1228 预览主机（live preview）

> ⛔ **已废弃（2026-10-08）**：部署改由 GitHub Actions 负责，harness 不再构建/推送/运行
> 测试环境。See [test-environment-deployment-plan.md](test-environment-deployment-plan.md)。
> 本文仅作为历史设计保留：预览主机、`docker save | ssh docker load`、端口/TTL 与
> `deploy/preview-host/install.sh` 均已移除。

> 上级设计：[preview-environment-design.md](preview-environment-design.md) §6。
> 前置：TASK-1226 证据式预览（构建证据 + 截图钩子）已上线。
> 本文只做设计；实现前需要一处外部确认（见 §7）。

## 1. 目标

把"某次交付"真跑起来，给验收人一个能点开的地址——覆盖 TASK-1226 覆盖不了的
交互/数据类验收。

## 2. 现场事实（2026-10-03 实测）

| 机器 | 现状 | 结论 |
| --- | --- | --- |
| 生产机 `192.210.226.179` | 清理后 9.1G/34G(29%)、2C/1.9G、Caddy 只服务 `rehelu.net` | 仍不适合：与生产同机，且部署文档明确"不改 Caddy、不新增对外端口" |
| 阿里云 `47.100.5.48` | 2C / 1.6G（可用 912M）/ **33G 空闲**、**无 docker、无 caddy**、已有 10 个监听端口 | 资源合适，但**不是空机**：装 docker/caddy 属于占用别人机器，需要确认 |

## 3. 决策

| # | 决策 | 理由 |
| --- | --- | --- |
| D1 | 预览只跑在**专用预览主机**，与生产机、与被预览的目标服务彻底分开 | 生产隔离；同机预览在生产机磁盘/内存上都不可行 |
| D2 | 传输用 `docker save \| ssh docker load`，不引入私有 registry | 少一个常驻组件；镜像只在预览期间存在 |
| D3 | v1 暴露方式：**IP + 端口 + 一次性 token**（不依赖 DNS/证书）；v2 再考虑子域名 | 端到端先跑通，不被 DNS 卡住 |
| D4 | 生命周期：TTL 默认 2h、并发上限 1、`预览停止` 立即回收；启动前检查对端磁盘与内存 | 机器只有 1.6G，防止互相挤 |
| D5 | 鉴权：32 字节随机 token 放在路径里（可选叠加 basic auth），预览结束即失效 | 预览地址不该是可猜测的公开入口 |
| D6 | 需要数据库的应用：在预览主机起**一次性** Postgres，迁移 + 种子后使用，随预览销毁 | 绝不连生产库（部署文档原则） |
| D7 | 截图仍由仓库脚本产出（TASK-1226）；live 预览是**补充**，不是替代 | 历史证据（截图）比临时环境更耐久 |
| D8 | harness 侧一切经 `PreviewHostClient` 端口，对端准备用一份可复读的 runbook | 传输/编排可注入 → 可离线测试 |

## 4. 流转

```text
人：预览 dlv-x --live        （或 TASK-1223 验收卡上的「打开预览」）
      │
      ▼
1. TASK-1226 构建（拿到可用镜像/产物）
2. 打标签 + docker save | ssh docker load 到预览主机
3. 对端起容器：--memory 512m --cpus 0.5 -p <port>:3000（+ 一次性 DB）
4. 生成 token，返回 http://<preview-host>:<port>/<token>/
5. 写事件 PreviewServing{url, port, expiresAt}；验收卡附链接
      │
      ▼（TTL 到点 / 人执行 `预览停止`）
6. 对端 stop + rm 容器、(有则) 删一次性库、释放端口
```

## 5. 落点

| 文件 | 改动 |
| --- | --- |
| **新增** `src/preview/application/previewHostClient.ts` | 端口：`deploy(imageRef, {port, token, env})` / `stop(id)` / `status()`；默认实现走 ssh |
| **新增** `src/preview/application/livePreviewService.ts` | 编排：构建 → 传输 → 起容器 → 记录 URL/TTL → 回收 |
| `src/preview/application/previewService.ts` | 产出可部署的镜像引用（或产物 tar），供 live 复用 |
| 命令层 | `preview.serve <deliveryId>` / `preview.stop <deliveryId>`（CLI + 聊天） |
| 事件 | `PreviewServing` / `PreviewServingFailed` / `PreviewStopped` |
| TASK-1223 验收卡 | 增加「打开预览」链接（在 token 有效期内） |
| 配置 | `AI_PREVIEW_HOST`、`AI_PREVIEW_PORT_RANGE`、`AI_PREVIEW_TTL_MINUTES`、`AI_PREVIEW_SSH_KEY` |
| 新增 `deploy/preview-host/install.sh` | 对端一次性准备：docker、目录、端口范围、磁盘/内存检查（幂等；**不改动其它服务**） |

## 6. 验收（可执行）

1. `preview.serve` 成功后，URL 在有效期内可访问；**无 token 返回 403**。
2. TTL 到点或 `preview.stop` 后：容器消失、端口释放、URL 失效。
3. 预览主机上不存在任何生产域名、生产库或生产凭据（检查对端 `docker ps` / `env`）。
4. 需要数据的应用：一次性库随预览销毁，生产库连接串从不出现。
5. 对端磁盘/内存不足时**拒绝**启动并说明原因，而不是把机器拖死。
6. 传输失败/对端不可达时：事件写明原因，验收流程不受影响（仍可用截图 + 证据验收）。

## 7. 实现前需要一处确认

阿里云 `47.100.5.48` **不是空机**（已有 10 个监听端口、无 docker/caddy）。要在它上面跑预览，
就必须装 docker、开一段端口——这属于占用别人的机器，需要明确许可。三个选项：

1. **允许占用它**（装 docker、用一段独立端口范围，不碰其它服务）；
2. **新开一台便宜 VPS**（干净、无冲突，需要域名/账单）；
3. **先只做 harness 侧**（`PreviewHostClient` + 服务 + 命令 + 测试全部落地，对端等你决定后再接）。

我的建议：**先做 3**，因为它零外部风险、可测试、且把 90% 的代码写完；
你决定机器后只差一份 runbook + 一次真机验证。

## 8. 风险

| 风险 | 应对 |
| --- | --- |
| 预览环境被外部扫到 | 一次性 token + TTL + 只在预览期间开端口 |
| 对端资源被打满 | 硬上限（512m/0.5C）、并发 1、启动前检查、TTL 强制回收 |
| 预览与生产配置漂移 | 预览只用于"人能点开看"，不作为发布依据；发布仍走 release |
| SSH 传输镜像慢 | 应用镜像通常 300MB 内可接受；超限则只传产物 tar + 对端基础镜像 |
