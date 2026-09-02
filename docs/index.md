# 背景

本仓库 fork 自 https://github.com/earendil-works/pi ，并与官方仓库产生分叉。故 `docs/` 专门用于记录开发者 `Tim2354` 的实现记录。

# 约定

- 目录按月划分：`docs/YYYY-MM/`；文件按日命名：`YYYY-MM-DD-主题.md`
- 这里只记录 fork 自有改动（偏离上游的部分）。上游自身的功能与修复见 `packages/*/CHANGELOG.md`
- 根目录下的docs/通常应当由人类撰写，AI辅助。AI不得直接写Docs。

# 导航

## 2026-08（分叉前的工具链铺垫期）

- [2026-08-05 npm run sync 诞生与项目本地包](2026-08/2026-08-05-sync-script-and-local-packages.md)
- [2026-08-08 sync 扩展为全量配置镜像（已回撤）](2026-08/2026-08-08-sync-plugins-config.md)
- [2026-08-19 项目扩展初现与 sync 收敛为 deployment-only](2026-08/2026-08-19-extensions-and-deployment-only-sync.md)
- [2026-08-31 项目扩展重新纳入 sync](2026-08/2026-08-31-extensions-back-to-sync.md)

## 2026-09（正式分叉）

- [2026-09-01 extensions-src 迁移：第一次正式分叉](2026-09/2026-09-01-extensions-src-first-divergence.md)
