# 发布与安装

修改 `.github/workflows/build.yml`、根 `install.sh`，或调整 Release 产物约定时阅读；本地构建见 [development.md](development.md)，面向使用者的命令见 [../README.md](../README.md)

## 发布链路

`.github/workflows/build.yml` 定时运行，也支持手动运行。每个分支的任务串行执行；功能分支只验证构建和安装脚本，不推送图标，也不压缩或发布安装包。任务开始时检出所选分支当前的提交，npm 未返回有效的 Electron 稳定版本号就停止

默认分支先刷新 `icons/`，只有图标或配套显示名有变化时才提交并推回。随后用当前提交构建全部应用，以 `v{Electron 版本}` 为 tag 发布 `darwin-arm64` 产物。即使 Electron 版本没变，安装器也能识别新图标

| 产物 | 用途 |
| --- | --- |
| `{id}-{slug}-darwin-arm64.zip` | 单个应用及包内安装器 |
| `release-manifest.json` | 对外精简清单，包含 `id`、`slug`、`name`、`url`、实际 `electronVersion` 和源码 `revision`，供安装器列出、选择应用并判断更新 |
| `checksums.txt` | 所有 zip 的 SHA256，供下载后校验 |

`dist/manifest.json` 是构建阶段的内部清单，不要上传；两份清单的分工见 [构建行为](development.md#构建行为)

## 发布策略

新版本先建草稿，文件全部上传成功后才公开并标为最新版。已有公开版本就地更新，不删除或重建 Release。`gh release upload --clobber` 会先删除同名旧文件；如果上传中断，公开版本可能缺包或校验不一致，用户自己重试不能修复。维护者应从默认分支重新发起工作流，补齐全部文件后再让用户重试；已有的图标提交和未发布草稿都可复用

构建器串行构建全部应用，任一失败就以非 0 退出，CI 不进入发布步骤，旧 release 保持可用。全部成功后才上传本次全部 zip 和 manifest，不读取或合并历史 manifest，也不携带旧包

CI 和安装器必须使用同一个实际 asset 名 `release-manifest.json`。`gh release create` 的 `path#label` 只改变显示标签，不改变下载时使用的 asset 名

## 两层安装器

| 安装器 | 职责 |
| --- | --- |
| 仓库根 `install.sh` | 远程分发器：获取 release、选择并下载 zip、校验、解压，再调用包内安装器 |
| zip 包内 `install.sh` | 单包安装器：构建时从 `packager/install.sh` 原样复制，去除 quarantine，并替换已安装应用 |

包内安装器优先写入 `/Applications`，无写权限时写入 `~/Applications`。同名应用按 bundle id 确认后替换；目标名称不存在时才在该安装目录查找同 bundle id 旧包。若只有一个，新包就位后再移除旧名应用；若有多个，提示用户整理，不猜测应删哪一个。不会覆盖同名的其他应用。复制先在目标卷的临时目录完成，再替换旧应用，避免复制中途失败时破坏旧版本；替换不是崩溃原子操作，进程在删除旧应用后、移动新应用前被强制终止时仍需重新安装

## 根安装器约定

- 必须获取 `release-manifest.json`；下载失败或文件缺失时直接退出，不从 zip 文件名降级，避免误装已移除的旧包。用于拼路径和资产名的 id、slug 会先做格式校验
- 无位置参数时安装全部应用；纯数字参数按 id 精准匹配，其余参数按 slug 子串模糊匹配
- 已安装应用的 Electron 版本与 manifest 一致，且源码 `CloudGamesRevision` 与 manifest 的 `revision` 一致时，默认跳过下载；缺少字段或值不同都会重装，`--force` 强制重装
- 必须获取 `checksums.txt`，zip 匹配清单才能安装；下载失败、文件缺失或校验不一致都拒绝安装
- 下载只使用 macOS 自带的 `curl`。每次运行先直连 GitHub，从 `releases/latest` 的重定向取得 tag，之后只下载该 tag 下的文件，不依赖 `gh` 或 GitHub API 配额。`--mirror` 只代理 zip，版本、应用清单和校验清单都取自 GitHub，避免镜像缓存的旧清单导致跳过更新
- 脚本必须自包含，支持 `curl ... | bash`，不能依赖仓库中的其他文件
- 必须兼容 macOS 自带的 bash 3.2：不用关联数组、`mapfile`，并避免 `set -u` 下直接展开空数组；JSON 解析使用 macOS 自带的 `plutil`，不依赖 Python

## 关联仓库

`adaex/dot-shrc` 的 `rc.d/games.sh` 提供 `games-update`，它只是本仓库根 `install.sh` 的薄封装：下载脚本、执行并透传参数；`--mirror` 时也通过镜像获取脚本。修改安装器参数或退出码时，需要检查这个调用方是否仍兼容

## 验证

修改包内安装器后，运行 `bash tests/install.sh` 在临时目录验证改名、同名更新和多份旧包的处理，并确认构建产物中的 `install.sh` 可直接执行。修改根安装器后至少运行：

```bash
bash -n install.sh
./install.sh --help
./install.sh --list
```

`--list` 只读取远端 release，不安装应用。改动镜像下载逻辑时，再覆盖 `./install.sh --list --mirror`

真实安装会替换 `/Applications` 或 `~/Applications` 中同 bundle id 的同名应用，不要把安装命令当作只读检查。修改 CI 后可用 `workflow_dispatch` 做端到端验证，但它会实际更新 GitHub Release，需要核对 manifest、全部 zip 和 `checksums.txt`
