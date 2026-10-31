#!/usr/bin/env bash
# install.sh — 云游戏客户端远程分发器（standalone，可 curl | bash 运行）
#
# 注意：这不是 zip 包内的 install.sh。本脚本负责下载 GitHub Release 的 zip，
#       解压后再调用各 zip 内的 install.sh（去 quarantine + 复制到 /Applications）。
#
# 用法：
#   ./install.sh                      按 apps.json 顺序安装全部应用（下载-安装交错）
#   ./install.sh mihoyo               slug 模糊匹配（"mihoyo" 命中所有含该串的应用）
#   ./install.sh 1569029742           纯数字按 App Store id 精准匹配
#   ./install.sh --list               列出可安装的应用
#   ./install.sh --force              已装同版本也强制重装（默认跳过同版本）
#   curl -fsSL <raw-url> | bash -s -- ys-mihoyo   远程一行安装
#
# 兼容 macOS 自带 bash 3.2：不使用关联数组 / mapfile；set -u 下不对空数组做
# "${arr[@]}" 展开（该展开在 3.2 会报 unbound variable）。

set -euo pipefail

REPO="adaex/nativefier-cloud-games"
MIRROR="https://v6.gh-proxy.org"
ASSET_SUFFIX="-darwin-arm64.zip"
MANIFEST_ASSET="release-manifest.json"  # CI 上传的精简 manifest（id/slug/名称/URL，权威顺序=apps.json）
CHECKSUM_ASSET="checksums.txt"          # CI 上传的 zip SHA256 清单

# ---------------------------------------------------------------------------
# 函数定义（须在调用前）
# ---------------------------------------------------------------------------

die() { echo "错误: $*" >&2; exit 1; }

print_help() {
  cat <<'EOF'
用法: install.sh [选项] [app ...]

  无 app 参数    按 apps.json 顺序安装全部应用
  指定 app       纯数字按 id 精准匹配；其余按 slug 子串模糊匹配
                 （如: install.sh mihoyo  或  install.sh 1569029742）

选项:
  -l, --list     列出可安装的应用（id + slug + 名称 + 网址）后退出
  -f, --force    已装同版本也强制重装（默认跳过）
  -h, --help     显示本帮助
      --mirror   通过镜像下载 (https://v6.gh-proxy.org)，国内网络更快
      --no-mirror  直连 GitHub（默认）
      --gh       强制使用 gh cli 下载
      --no-gh    禁用 gh cli

远程一行安装:
  curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- ys-mihoyo
EOF
}

# 在已落盘的 release.json 中，按 asset 名查其 browser_download_url
asset_url_by_name() {
  local want="$1" i=0 n
  while n=$(plutil -extract "assets.$i.name" raw -o - -- "$rel" 2>/dev/null); do
    if [[ "$n" == "$want" ]]; then
      plutil -extract "assets.$i.browser_download_url" raw -o - -- "$rel"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

# asset 名是否存在于 release
asset_exists() {
  local want="$1" a
  for a in ${asset_names[@]+"${asset_names[@]}"}; do
    [[ "$a" == "$want" ]] && return 0
  done
  return 1
}

# 已选索引去重追加
add_idx() {
  local x="$1" e
  for e in ${sel_idx[@]+"${sel_idx[@]}"}; do
    [[ "$e" == "$x" ]] && return
  done
  sel_idx+=("$x")
}

# 下载并解析精简 manifest（权威源，顺序 = apps.json）；
# 成功填充应用信息、源码 revision 和实际 Electron 版本，失败返回 1
fetch_manifest() {
  local mf="$tmpdir/$MANIFEST_ASSET" url j=0 id slug name murl rev ever
  if (( use_gh )); then
    gh release download "$tag" --repo "$REPO" --pattern "$MANIFEST_ASSET" \
       --dir "$tmpdir" --clobber >/dev/null 2>&1 || return 1
  else
    url=$(asset_url_by_name "$MANIFEST_ASSET") || return 1
    (( use_mirror )) && url="$MIRROR/$url"
    curl -fsSL "$url" -o "$mf" || return 1
  fi
  [[ -f "$mf" ]] || return 1
  # 循环条件用「第 j 项对象是否存在」，而非某字段提取成功——
  # 否则某项缺 slug 会让循环提前终止、静默丢弃其后所有 app。
  while plutil -extract "$j" raw -o /dev/null -- "$mf" 2>/dev/null; do
    slug=$(plutil -extract "$j.slug" raw -o - -- "$mf" 2>/dev/null || printf '')
    id=$(plutil -extract "$j.id"   raw -o - -- "$mf" 2>/dev/null || printf '')
    name=$(plutil -extract "$j.name" raw -o - -- "$mf" 2>/dev/null || printf '')
    murl=$(plutil -extract "$j.url"  raw -o - -- "$mf" 2>/dev/null || printf '')
    rev=$(plutil -extract "$j.revision" raw -o - -- "$mf" 2>/dev/null || printf '')
    ever=$(plutil -extract "$j.electronVersion" raw -o - -- "$mf" 2>/dev/null || printf '')
    j=$((j + 1))
    # id/slug 是拼 zip 名（id-slug-*.zip）的关键，缺失则该项不可安装，跳过（不中断后续）
    [[ -n "$id" && -n "$slug" ]] || { echo "提示: manifest 第 $j 项缺 id/slug，已跳过。" >&2; continue; }
    [[ -n "$name" ]] || name="$slug"
    # 兼容旧 manifest；新条目始终带有 electronVersion 和 revision
    [[ -n "$ever" ]] || ever="${tag#v}"
    AID+=("$id"); ASLUG+=("$slug"); ANAME+=("$name"); AURL+=("$murl")
    AREV+=("$rev"); AEVER+=("$ever")
  done
  [[ ${#ASLUG[@]} -gt 0 ]]
}

# 下载 zip 的 SHA256 清单。注意：即使 --mirror 也始终直连 GitHub 获取——
# 校验文件若走同一镜像，篡改者连校验值一起改，校验就失去意义
fetch_checksums() {
  local cs="$tmpdir/$CHECKSUM_ASSET" url
  if (( use_gh )); then
    gh release download "$tag" --repo "$REPO" --pattern "$CHECKSUM_ASSET" \
       --dir "$tmpdir" --clobber >/dev/null 2>&1 || return 1
  else
    url=$(asset_url_by_name "$CHECKSUM_ASSET") || return 1
    curl -fsSL "$url" -o "$cs" || return 1
  fi
  [[ -s "$cs" ]]
}

# 用 checksums.txt 校验已下载的 zip；清单中无此项或不一致均拒绝安装
verify_zip() {
  local zip="$1" file="$2" expected actual
  expected=$(awk -v f="$zip" '$2 == f {print $1}' "$tmpdir/$CHECKSUM_ASSET")
  if [[ -z "$expected" ]]; then
    echo "校验清单中无 $zip，拒绝安装（release 不完整）" >&2
    return 1
  fi
  actual=$(shasum -a 256 "$file" | awk '{print $1}')
  if [[ "$expected" != "$actual" ]]; then
    echo "$zip 校验失败（期望 $expected，实际 $actual），拒绝安装——文件可能被篡改" >&2
    return 1
  fi
}

# 读取已安装应用的 Info.plist 字段（/Applications 与 ~/Applications）
installed_info() {
  local name="$1" key="$2" base plist
  for base in /Applications "$HOME/Applications"; do
    plist="$base/$name.app/Contents/Info.plist"
    [[ -f "$plist" ]] || continue
    plutil -extract "$key" raw -o - -- "$plist" 2>/dev/null && return 0
  done
  return 1
}

# 新 manifest 同时比较实际 Electron 版本与源码 revision；旧 manifest 无 revision
# 时保留原有版本判断。携带旧包使用其自身 Electron 版本，而不是当前 release tag
is_current() {
  local name="$1" revision="$2" electron_version="$3" cur_ver cur_rev
  (( ! force )) || return 1
  cur_ver=$(installed_info "$name" CFBundleShortVersionString) || return 1
  [[ "$cur_ver" == "$electron_version" ]] || return 1
  [[ -n "$revision" ]] || return 0
  cur_rev=$(installed_info "$name" CloudGamesRevision) || return 1
  [[ "$cur_rev" == "$revision" ]]
}

# ---------------------------------------------------------------------------
# 前置检查 + 临时目录清理（作为独立进程，trap EXIT 天然生效，无需子 shell）
# ---------------------------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || die "本安装器仅支持 macOS。"

tmpdir=""
cleanup() { [[ -n "$tmpdir" ]] && rm -rf -- "$tmpdir"; return 0; }
trap cleanup EXIT

# ---------------------------------------------------------------------------
# 参数解析：分离位置参数（app id）与 flags
# ---------------------------------------------------------------------------

use_mirror=0
use_gh=""          # 空 = 自动探测
do_list=0
force=0
want_ids=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror)    use_mirror=1 ;;
    --no-mirror) use_mirror=0 ;;
    --gh)        use_gh=1 ;;
    --no-gh)     use_gh=0 ;;
    -l|--list)   do_list=1 ;;
    -f|--force)  force=1 ;;
    -h|--help)   print_help; exit 0 ;;
    --)          shift; while [[ $# -gt 0 ]]; do want_ids+=("$1"); shift; done; break ;;
    -*)          die "未知选项: $1（用 --help 查看用法）" ;;
    *)           want_ids+=("$1") ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# gh 探测 + 依赖检查
# ---------------------------------------------------------------------------

if [[ -z "$use_gh" ]]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    use_gh=1
  else
    use_gh=0
  fi
fi

command -v unzip  >/dev/null 2>&1 || die "缺少 unzip"
command -v plutil >/dev/null 2>&1 || die "缺少 plutil（macOS 自带）"
command -v shasum >/dev/null 2>&1 || die "缺少 shasum（macOS 自带）"
if (( ! use_gh )); then
  command -v curl >/dev/null 2>&1 || die "缺少 curl"
fi

# ---------------------------------------------------------------------------
# 获取 release 元数据（tag + asset 名单）—— 三模式，共用 plutil 解析
# ---------------------------------------------------------------------------

tmpdir=$(mktemp -d) || die "无法创建临时目录"
rel="$tmpdir/release.json"

if (( use_gh )); then
  gh api "repos/$REPO/releases/latest" > "$rel" 2>/dev/null \
    || die "无法获取 release 信息（gh api 失败）"
else
  api="https://api.github.com/repos/$REPO/releases/latest"
  (( use_mirror )) && api="$MIRROR/$api"
  curl -fsSL "$api" -o "$rel" || die "无法获取 release 信息"
fi

tag=$(plutil -extract tag_name raw -o - -- "$rel" 2>/dev/null) \
  || die "无法解析 release（空 release 或格式异常）"

asset_names=()
i=0
while n=$(plutil -extract "assets.$i.name" raw -o - -- "$rel" 2>/dev/null); do
  asset_names+=("$n")
  i=$((i + 1))
done
[[ ${#asset_names[@]} -gt 0 ]] || die "release $tag 没有任何 asset"
echo "找到 release: $tag"

# ---------------------------------------------------------------------------
# 拉取精简 manifest（必需；不从 asset 名降级，避免误装已移除的旧包）
# ---------------------------------------------------------------------------

# 并行数组：应用信息、源码 revision、实际 Electron 版本，顺序即 apps.json
AID=(); ASLUG=(); ANAME=(); AURL=(); AREV=(); AEVER=()
fetch_manifest || die "无法获取 ${MANIFEST_ASSET}（release 不完整或下载失败）"
[[ ${#ASLUG[@]} -gt 0 ]] || die "release $tag 内无可安装的 $ASSET_SUFFIX 包"

# manifest 里的 app 未必都已上传成功，只保留有对应 zip 的原始下标
available_idx=()
for k in "${!ASLUG[@]}"; do
  zip="${AID[$k]:+${AID[$k]}-}${ASLUG[$k]}${ASSET_SUFFIX}"
  asset_exists "$zip" && available_idx+=("$k")
done
[[ ${#available_idx[@]} -gt 0 ]] || die "release $tag 内无可安装的 $ASSET_SUFFIX 包"

# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------

if (( do_list )); then
  echo "可安装应用 ($tag):"
  for k in "${available_idx[@]}"; do
    printf '  %-12s %-16s %s — %s\n' "${AID[$k]}" "${ASLUG[$k]}" "${ANAME[$k]}" "${AURL[$k]}"
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# 拉取 zip 校验清单（必需；下载失败或文件缺失都拒绝继续安装）
# ---------------------------------------------------------------------------

fetch_checksums || die "无法获取 ${CHECKSUM_ASSET}，拒绝安装未校验的包"

# ---------------------------------------------------------------------------
# 选择要安装的应用索引：无参数 → 全部（按 apps.json 顺序）；
# 否则逐个参数匹配 —— 纯数字按 id 精准，其余按 slug 子串模糊
# ---------------------------------------------------------------------------

sel_idx=()
if [[ ${#want_ids[@]} -eq 0 ]]; then
  for k in "${available_idx[@]}"; do sel_idx+=("$k"); done
else
  for w in "${want_ids[@]}"; do
    matched=0
    if [[ "$w" =~ ^[0-9]+$ ]]; then
      for k in "${available_idx[@]}"; do
        [[ "${AID[$k]}" == "$w" ]] && { add_idx "$k"; matched=1; }
      done
    else
      for k in "${available_idx[@]}"; do
        case "${ASLUG[$k]}" in *"$w"*) add_idx "$k"; matched=1 ;; esac
      done
    fi
    (( matched )) || die "未知 app: '$w'。用 './install.sh --list' 查看可选项。"
  done
fi

# ---------------------------------------------------------------------------
# 逐个下载并安装（下载-安装交错，按选中顺序）—— 三模式
# ---------------------------------------------------------------------------

install_one() {
  local k="$1"
  local id="${AID[$k]}" slug="${ASLUG[$k]}" name="${ANAME[$k]}"
  local revision="${AREV[$k]}" electron_version="${AEVER[$k]}"
  local zip="${id:+${id}-}${slug}${ASSET_SUFFIX}"
  local dest="$tmpdir/$zip" url extract_dir

  # Electron 与源码 revision 均未变化才跳过；旧 manifest 无 revision 时仅比版本
  if is_current "$name" "$revision" "$electron_version"; then
    echo "[$name] 已是最新 ($electron_version)，跳过。用 --force 强制重装。"
    return 0
  fi

  echo ""
  echo "[$name] 下载 $zip ..."
  if (( use_gh )); then
    gh release download "$tag" --repo "$REPO" --pattern "$zip" \
       --dir "$tmpdir" --clobber || { echo "[$name] 下载失败，跳过"; return 1; }
  else
    url=$(asset_url_by_name "$zip") || { echo "[$name] 在 release 中找不到 $zip，跳过"; return 1; }
    (( use_mirror )) && url="$MIRROR/$url"
    curl -fSL --retry 3 --progress-bar -o "$dest" "$url" || { echo "[$name] 下载失败，跳过"; return 1; }
  fi

  verify_zip "$zip" "$dest" || return 1

  echo "[$name] 解压并安装..."
  extract_dir="$tmpdir/${zip%.zip}"
  mkdir -p "$extract_dir"
  if ! unzip -qo "$dest" -d "$extract_dir"; then
    echo "[$name] 解压失败，跳过"; return 1
  fi
  if [[ -f "$extract_dir/install.sh" ]]; then
    ( cd "$extract_dir" && bash install.sh )
  else
    echo "[$name] 未找到包内 install.sh，跳过"; return 1
  fi
}

echo ""
echo "准备安装 ${#sel_idx[@]} 个应用..."
fail=0
for k in "${sel_idx[@]}"; do
  install_one "$k" || fail=$((fail + 1))
done

echo ""
if (( fail )); then
  echo "完成，$fail 个应用失败。"
  exit 1
fi
echo "全部完成。"
