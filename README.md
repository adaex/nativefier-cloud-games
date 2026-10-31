# nativefier-cloud-games

把云游戏网页（咪咕、云·原神等）打包成 macOS 客户端

## 安装

远程一行安装（无需 clone）：

```bash
# 安装全部应用
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash

# 只装指定应用（slug 模糊匹配，或 App Store 数字 id 精准匹配）
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- mihoyo migufun

# 列出可安装的应用（id + slug + 名称 + 网址）
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- --list
```

已 clone 仓库也可直接 `./install.sh [app ...]`

选项：

- `-l, --list`：列出可安装的应用
- `-f, --force`：已装同版本也强制重装（默认已装同版本时跳过下载）
- `--mirror` / `--no-mirror`：启用／禁用镜像下载，默认直连 GitHub
- `--gh` / `--no-gh`：强制使用／禁用 gh CLI 下载
- `-h, --help`：查看完整用法

安装器会下载对应 zip、用 release 的 `checksums.txt` 校验完整性（防止镜像下载被篡改）、去除 macOS 隔离标记，并复制到 `/Applications`（无管理员权限时装进 `~/Applications`）。仅支持 macOS arm64（`darwin-arm64`）

## 开发文档

- 本地构建、应用配置与客户端运行时：[docs/development.md](docs/development.md)
- CI、Release 与安装器：[docs/distribution.md](docs/distribution.md)
