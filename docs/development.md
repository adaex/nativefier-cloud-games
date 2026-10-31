# 构建与运行时

修改 `apps.json` 或 `packager/` 时阅读；CI、Release 和根安装器见 [distribution.md](distribution.md)

## 本地构建

环境要求：Node.js（版本以 `package.json` 的 `engines.node` 为准）、Yarn，以及 macOS arm64

```bash
yarn install --frozen-lockfile
yarn build
```

`yarn build` 默认读取仓库根的 `apps.json`，产物写入已被 Git 忽略的 `dist/`。也可用 `node packager/cli.ts /path/to/apps.json` 指定另一份配置

`yarn build-and-install` 会构建全部应用，再逐个运行产物中的安装脚本，替换本机已安装的同名应用

构建需要访问 App Store 和 npm，并下载 Electron。默认查询 npm 上的最新 Electron 版本，可通过 `ELECTRON_VERSION` 固定版本；稳定版列表见 <https://releases.electronjs.org/release?channel=stable>

## 配置与标识

`apps.json` 是非空数组，标准配置项为 `{id, url}`：

- `id`：App Store 数字 ID，作为稳定唯一标识，用于 bundle ID、zip 文件名和 `userData` 隔离
- `url`：云游戏页面的 HTTP(S) 地址
- `country`：可选的 App Store 区域，默认 `cn`

`slug` 不在配置中维护，而是由 `packager/build.ts` 从 URL 域名派生，例如 `ys.mihoyo.com` 对应 `ys-mihoyo`。它用于可读的 zip 文件名和安装器选应用；不要把它当作内部唯一标识

bundle ID 固定为 `io.github.adaex.cloudgames.{id}`。显示名与图标在构建时通过 iTunes Lookup API 获取，显示名会截断常见营销后缀，不在配置中硬编码

## 构建行为

`packager/cli.ts` 在构建前拦截重复 id、slug 冲突、非整数 id、非法 URL 和非 HTTP(S) 协议；构建后再拦截重复显示名，因为同名产物目录会互相覆盖

部分应用失败时，仍写出成功者的 `dist/manifest.json` 并以 0 退出，让 CI 能继续发布可用应用；全部失败才以非 0 退出。部分失败会输出警告和 GitHub Actions Step Summary

`dist/manifest.json` 是构建阶段的内部清单，包含本地产物路径 `appPaths`；它与 Release 对外提供的 `release-manifest.json` 不是同一个文件

## 客户端运行时

`packager/template/main.js` 的关键约束：

- 必须在请求单实例锁之前，按 id 设置独立的 `userData`，否则不同应用会共享 session、cookie 和缓存，单实例锁也会互相影响
- User-Agent 去掉 Electron 和应用名段，避免云游戏站点因检测到你不是普通 Chrome 而降级或拒绝服务
- 窗口没有标签页和返回导航；弹窗和外站跳转交给系统浏览器，页面内跳转仅限同主域
- 外部页面按不可信内容处理，保持 `contextIsolation: true`、`nodeIntegration: false`

## 验证

仓库目前没有单元测试。修改构建代码后至少运行以下静态检查，并用上文的 `yarn build` 完成一次完整构建；修改后已经构建过的，不必为验证重复执行：

```bash
node --check packager/cli.ts
node --check packager/build.ts
node --check packager/template/main.js
```

`yarn build` 会访问网络并生成完整应用，不是快速静态检查。修改客户端运行时后，还需启动受影响的产物，验证页面加载、单实例、弹窗和外站跳转；仅构建成功不能覆盖这些行为
