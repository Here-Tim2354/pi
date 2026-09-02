提交：`11dbaea1e`、`5bbdc2239`、`d7ce3d9f0`

# TLDR

1. 新增 `analyze-image` 视觉子代理扩展（402 行）
2. `@ff-labs/pi-fff` 加入 packages
3. `npm run sync` 回撤 08-08 的配置镜像，收敛为 deployment-only

## 1-analyze-image

**背景**：想让 agent 具备读图能力，且不引入常驻进程。

**决策**：移植社区 pi-image-subagent。`analyze_image` 工具起一个无状态 pi 子进程，视觉模型通过 read 工具读图、返回文本描述。全局默认模型走 `~/.pi/agent/extensions/analyze-image/config.json`，调用时可按次覆盖。

## 2-pi-fff

**背景**：想要 FFF 搜索扩展，直接挂 packages。

## 3-回撤

**背景**：08-08 的镜像撞上了 pi 的自动发现——仓库内 `.pi/extensions/` 被 pi 加载，镜像又复制一份到全局，同一工具双重注册，sync 后仓库内启动直接坏掉。这是硬性冲突，不是配置问题。

**决策**：sync 只保留部署链路（check 门槛、打包、冒烟测试、快照回滚、安装），删掉镜像部分和 `--plugins-only`。用户配置不再由脚本搬运，改走 pi-config-pack / pi-config-apply 技能迁移。

**设计**：skills/prompts 本来就不用镜像——pi 会读仓库内 `.pi/`，git 就是分发渠道。extensions 的矛盾这次绕过去了，但没解决，答案在 08-31 / 09-01。
