# nativefier-cloud-games

在 Mac 上用独立窗口打开咪咕游戏、云·原神和云·星穹铁道。客户端不向网页开放麦克风和摄像头

## 安装与更新

适用于搭载 Apple 芯片的 Mac，建议使用最新版 macOS。在「终端」中按需要运行下面的一条命令，无需下载仓库：

```bash
# 安装或更新全部游戏
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash

# 只安装或更新云·原神
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- 1569029742

# 查看可选游戏和安装编号，不安装任何应用
curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- --list
```

安装其他游戏时，把第二条命令里的 `1569029742` 换成列表中对应的安装编号即可。也可以用英文简称：例如 `mihoyo` 会选中简称中含有 `mihoyo` 的两款游戏。已下载仓库的用户可在仓库目录运行 `./install.sh`，参数相同

安装后，在访达的「应用程序」中按游戏名称打开。如果当前账户不能写入系统的「应用程序」文件夹，游戏会装到个人目录的 `~/Applications`，安装结束时会显示具体位置。以后重新运行同一条命令即可更新，已经是最新版的游戏不会重复下载

安装器会对照 GitHub 上的发布记录校验安装包，通过后才移除 macOS 的下载隔离标记并安装。默认从 GitHub 下载；如果下载慢，可在第二条命令的游戏编号后加 `--mirror`，改用镜像下载安装包。校验记录始终从 GitHub 获取

其他选项：`--no-mirror` 改回直连，`-f` 或 `--force` 重新安装已是最新版的游戏，`-l` 是 `--list` 的简写，`-h` 或 `--help` 查看用法

## 开发文档

- 本地构建、应用配置与客户端运行时：[docs/development.md](docs/development.md)
- CI、Release 与安装器：[docs/distribution.md](docs/distribution.md)
