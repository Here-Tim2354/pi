提交：`9b06174e7`、`2e83757e2`、`bd4852dcb`

# TLDR

1. `npm run sync` 诞生：`sync-global-pi.mjs` 把仓库构建安装覆盖全局 pi，支持回滚
2. `pi-open-tui` 加入项目本地包，TUI 美化跟随仓库走
3. `check-pinned-deps` 忽略 `.pi` 目录

## 1-sync

**背景**：本地仓库领先全局 npm 时，我不想等官方发版，希望在真实环境尽早用上仓库版 pi。同时出事必须能退回来。

**决策**：写 `scripts/sync-global-pi.mjs`。流程是打包可发布包 → 隔离目录冒烟测试 → 快照当前全局安装 → 安装覆盖。出事 `npm run sync -- --rollback` 退回快照。

**设计**：跨平台（macOS/Linux/Windows）。快照目录带时间戳和版本号，回滚不靠猜。

## 2-pi-open-tui

**背景**：想要动画 header、Starship 风格 footer、圆角编辑器这套视觉定制，且跟着仓库走而不是散落在每台机器。

**决策**：`pi install -l npm:pi-open-tui`，写进 `.pi/settings.json` 的 packages。

## 3-pinned-deps

**背景**：`.pi/settings.json` 里的 npm 包引用被精确版本检查误拦——那不是依赖声明。

**决策**：`check-pinned-deps` 忽略 `.pi` 目录，检查职责归检查，配置归配置。
