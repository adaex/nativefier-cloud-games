# 发布与安装

修改 `.github/workflows/build.yml`、根 `install.sh`，或调整 Release 产物约定时阅读；本地构建见 [development.md](development.md)，面向使用者的命令见 [../README.md](../README.md)

## 发布链路

`.github/workflows/build.yml` 定时运行，也支持 `workflow_dispatch`。同一工作流串行执行，避免并发运行交叉覆盖 Release asset。CI 构建 `apps.json` 中的全部应用，以 `v{Electron 版本}` 为 tag 发布 `darwin-arm64` 产物

| 产物 | 用途 |
| --- | --- |
| `{id}-{slug}-darwin-arm64.zip` | 单个应用及包内安装器 |
| `release-manifest.json` | 对外精简清单，包含 `id`、`slug`、`name`、`url`、实际 `electronVersion` 和源码 `revision`，供安装器列出、选择应用并判断更新 |
| `checksums.txt` | 所有 zip 的 SHA256，供下载后校验 |

`dist/manifest.json` 是构建阶段的内部清单，不要上传；两份清单的分工见 [构建行为](development.md#构建行为)

## 发布策略

禁止为了发布而删除再重建 release：这会造成 release 暂时不存在。已有 tag 用 `gh release edit` 更新说明，asset 用 `gh release upload --clobber` 覆盖

构建器串行构建全部应用，任一失败就以非 0 退出，CI 不进入发布步骤，旧 release 保持可用。全部成功后才上传本次全部 zip 和 manifest，不读取或合并历史 manifest，也不携带旧包

CI 和安装器必须使用同一个实际 asset 名 `release-manifest.json`。`gh release create` 的 `path#label` 只改变显示标签，不改变下载时使用的 asset 名

## 两层安装器

| 安装器 | 职责 |
| --- | --- |
| 仓库根 `install.sh` | 远程分发器：获取 release、选择并下载 zip、校验、解压，再调用包内安装器 |
| zip 包内 `install.sh` | 单包安装器：由 `packager/build.ts` 的 `writeInstallScript` 生成，去除 quarantine，并替换已安装应用 |

包内安装器优先写入 `/Applications`，无写权限时写入 `~/Applications`。它只替换 bundle id 相同的已安装应用，遇到同名但 bundle id 不同的应用会拒绝覆盖。复制先在目标卷的临时目录完成，再替换旧应用，避免复制中途失败时破坏旧版本；替换不是崩溃原子操作，进程在删除旧应用后、移动新应用前被强制终止时仍需重新安装

## 根安装器约定

- 必须获取 `release-manifest.json`；下载失败或文件缺失时直接退出，不从 zip 文件名降级，避免误装已移除的旧包。用于拼路径和资产名的 id、slug 会先做格式校验
- 无位置参数时安装全部应用；纯数字参数按 id 精准匹配，其余参数按 slug 子串模糊匹配
- 已安装应用的 Electron 版本与 manifest 一致，且源码 `CloudGamesRevision` 与 manifest 的 `revision` 一致时，默认跳过下载；缺少字段或值不同都会重装，`--force` 强制重装
- 必须获取 `checksums.txt`，zip 匹配清单才能安装；下载失败、文件缺失或校验不一致都拒绝安装
- 下载只使用 macOS 自带的 `curl`，通过 `releases/latest/download/<文件名>` 获取固定名称的 asset，不依赖 `gh` 或 GitHub API 配额；即使 zip 和 manifest 使用 `--mirror`，校验清单也始终直连 GitHub，避免镜像同时篡改文件和校验值
- 脚本必须自包含，支持 `curl ... | bash`，不能依赖仓库中的其他文件
- 必须兼容 macOS 自带的 bash 3.2：不用关联数组、`mapfile`，并避免 `set -u` 下直接展开空数组；JSON 解析使用 macOS 自带的 `plutil`，不依赖 Python

## 关联仓库

`adaex/dot-shrc` 的 `rc.d/games.sh` 提供 `games-update`，它只是本仓库根 `install.sh` 的薄封装：下载脚本、执行并透传参数；`--mirror` 时也通过镜像获取脚本。修改安装器参数或退出码时，需要检查这个调用方是否仍兼容

## 验证

修改根安装器后至少运行：

```bash
bash -n install.sh
./install.sh --help
./install.sh --list
```

`--list` 只读取远端 release，不安装应用。改动镜像下载逻辑时，再覆盖 `./install.sh --list --mirror`

真实安装会替换 `/Applications` 或 `~/Applications` 中同 bundle id 的同名应用，不要把安装命令当作只读检查。修改 CI 后可用 `workflow_dispatch` 做端到端验证，但它会实际更新 GitHub Release，需要核对 manifest、全部 zip 和 `checksums.txt`
