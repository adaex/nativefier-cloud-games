# AGENTS.md

用 `@electron/packager` 把云游戏网页打包成 macOS 客户端，经 GitHub Release 分发；分发链路仅支持 macOS arm64（`darwin-arm64`）

## 文档地图

| 文档 | 什么时候打开 |
| --- | --- |
| `README.md` | 修改面向使用者的安装方式、参数或对外说明时 |
| `docs/development.md` | 修改 `apps.json`、`packager/`、本地构建或客户端运行时，以及做构建验证时 |
| `docs/distribution.md` | 修改根 `install.sh`、CI、Release、manifest、校验和，或与 `games-update` 协同时 |

按任务选读，不必预读全部主题文档

## 关键约束

- 根 `install.sh` 必须保持自包含，支持 `curl ... | bash`，并兼容 macOS 自带的 bash 3.2
- Release 只能增量更新，禁止为了发布而删除再重建 release
- 根 `install.sh` 与 zip 包内的 `install.sh` 是两层不同程序：前者负责下载分发，后者负责单包安装，修改前先分清
