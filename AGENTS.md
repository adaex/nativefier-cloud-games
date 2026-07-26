# AGENTS.md

云游戏打包分发系统:用 @electron/packager 把云游戏网页(咪咕、云·原神等)打包成 macOS .app,经 GitHub Release 分发,由 `games-update`(dot-shrc)或仓库根 `install.sh` 安装。仅支持 macOS darwin-arm64

## 两个仓库

- **本仓库**(`adaex/nativefier-cloud-games`):打包 + 分发。CI(`.github/workflows/build.yml`)每周一/五及 `workflow_dispatch` 触发,构建 `apps.json` 全部 app,打 zip 上传 Release(tag `v{Electron 版本}`),并上传 `release-manifest.json`
- **`adaex/dot-shrc`** 的 `rc.d/games.sh`:`games-update` 函数,薄封装--curl 拉本仓库根 `install.sh` 落盘后执行并透传参数;`--mirror` 时脚本源走 `https://v6.gh-proxy.org`

## 配置与标识

- `apps.json`:数组,每项 `{id, url}`。`id` = App Store 数字 ID,`url` = 云游戏页地址
- **id / slug 分离**(`packager/build.ts`):`id`(数字)对内防撞,用于 bundleId / zip 名 / userData;`slug`(由 url 域名派生,如 `ys-mihoyo`、`migufun`)对外可读,用于 zip 名与安装器选应用
- `bundleId = io.github.adaex.cloudgames.{id}`(每 app 独立)
- 显示名与图标:构建时从 iTunes Lookup API 按 id 拉取(`fetchAppMeta` + `shortName` 截断营销后缀),不硬编码
- `template/main.js`:`setPath('userData', cloud-games-{id})` 按 id 隔离 session/cookie/缓存(否则跨 app 共享且单实例锁互斥);单实例锁;UA 剥 `Electron/` 与应用名段伪装纯 Chrome,避免站点 UA 检测降级

## 两个同名 install.sh(易混淆)

- **仓库根 `install.sh`** = 远程分发器:拉 `release-manifest.json` 得 id/slug/name/url(降级时从 zip asset 名 `id-slug-darwin-arm64.zip` 解析),下载选中 zip -> 解压 -> 调包内 install.sh。支持 `curl|bash` 自包含
- **zip 包内 `install.sh`**(`build.ts: writeInstallScript` 生成)= 单包安装器:去 quarantine + 原子替换到 `/Applications`(cp 到同卷临时目录 -> rm 旧 -> mv 就位 + trap 清理)

## 按需安装

`install.sh` / `games-update` 无位置参数 = 全装;`migufun ys-mihoyo` = slug 子串模糊匹配;`1569029742` = 纯数字按 id 精准匹配

## manifest 约定(关键坑)

CI 额外上传 `release-manifest.json`(剥离 `appPaths` 的精简版,字段 id/slug/name/url),供 `--list` 与安装器做 id/slug -> 名称/URL 映射。**两端必须用同一实际文件名 `release-manifest.json`**--`gh release create` 的 `path#label` 只改显示标签、不改 asset 下载名,安装器按 asset 名匹配

## 构建正确性约束

- `cli.ts` 构建前 pre-flight 校验:重复 id、slug 冲突、非整数 id、非 http(s) 协议、非法 url;构建后校验重复 name(产物目录以 name 为键,撞名互相覆盖)
- 部分 app 失败仍写入成功者的 manifest 并以 0 退出(CI 能发布可用 app 而非整批报废);全部失败才硬失败
- 根 `install.sh` 须兼容 macOS 自带 **bash 3.2**(不用关联数组 / mapfile;`set -u` 下不对空数组做 `"${arr[@]}"` 展开);JSON 解析用 macOS 自带 **`plutil`** 而非 python3
