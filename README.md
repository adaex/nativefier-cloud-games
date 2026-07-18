# nativefier-cloud-games

把云游戏网页（咪咕、云·原神等）打包成 macOS 客户端。

## 安装

远程一行安装（无需 clone）：

```bash
# 安装全部应用
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash

# 只装指定应用（位置参数为 app id）
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- migufun-pc mihoyo-ys

# 列出可安装的应用（id + 名称 + 网址）
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- --list
```

已 clone 仓库也可直接 `./install.sh [app-id ...]`。

选项：

- `-l, --list`：列出可安装的应用
- `--mirror`：通过镜像下载（国内网络更快）
- `--gh` / `--no-gh`：强制 / 禁用 gh cli 下载

安装器会下载对应 zip、去除 macOS 隔离标记，并复制到 `/Applications`。仅支持 macOS (darwin-arm64)。

## 查看 Electron 版本

https://releases.electronjs.org/release?channel=stable

## 查看 Nativefier API

https://github.com/nativefier/nativefier/blob/master/API.md
