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
#   curl -fsSL <raw-url> | bash -s -- ys-mihoyo   远程一行安装
#
# 兼容 macOS 自带 bash 3.2：不使用关联数组 / mapfile；set -u 下不对空数组做
# "${arr[@]}" 展开（该展开在 3.2 会报 unbound variable）。

set -euo pipefail

REPO="adaex/nativefier-cloud-games"
MIRROR="https://v6.gh-proxy.org"
ASSET_SUFFIX="-darwin-arm64.zip"
MANIFEST_ASSET="release-manifest.json"  # CI 上传的精简 manifest（id/slug/名称/URL，权威顺序=apps.json）

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
# 成功填充并行数组 AID/ASLUG/ANAME/AURL 并返回 0，失败返回 1
fetch_manifest() {
  local mf="$tmpdir/$MANIFEST_ASSET" url j=0 id slug name murl
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
    j=$((j + 1))
    # slug 是选包与拼 zip 名的关键，缺失则该项不可安装，跳过（不中断后续）
    [[ -n "$slug" ]] || { echo "提示: manifest 第 $j 项缺 slug，已跳过。" >&2; continue; }
    [[ -n "$name" ]] || name="$slug"
    AID+=("$id"); ASLUG+=("$slug"); ANAME+=("$name"); AURL+=("$murl")
  done
  [[ ${#ASLUG[@]} -gt 0 ]]
}

# 降级：manifest 缺失时从 zip asset 名（id-slug-darwin-arm64.zip）解析 id/slug
parse_zip_assets() {
  local a rest id slug
  for a in ${asset_names[@]+"${asset_names[@]}"}; do
    case "$a" in
      *"$ASSET_SUFFIX")
        rest="${a%"$ASSET_SUFFIX"}"           # id-slug
        if [[ "$rest" == [0-9]*-* ]]; then
          id="${rest%%-*}"; slug="${rest#*-}"
        else
          id=""; slug="$rest"
        fi
        AID+=("$id"); ASLUG+=("$slug"); ANAME+=("$slug"); AURL+=("")
        ;;
    esac
  done
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
want_ids=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror)    use_mirror=1 ;;
    --no-mirror) use_mirror=0 ;;
    --gh)        use_gh=1 ;;
    --no-gh)     use_gh=0 ;;
    -l|--list)   do_list=1 ;;
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
# 拉取精简 manifest（best-effort，失败则降级为只显示 id）
# ---------------------------------------------------------------------------

# 并行数组：AID/ASLUG/ANAME/AURL，顺序即 apps.json（manifest）或 asset 名（降级）
AID=(); ASLUG=(); ANAME=(); AURL=()
have_manifest=0
if fetch_manifest; then
  have_manifest=1
else
  echo "提示: 未获取到 ${MANIFEST_ASSET}（可能是旧 release），从包名解析。" >&2
  parse_zip_assets
fi
[[ ${#ASLUG[@]} -gt 0 ]] || die "release $tag 内无可安装的 $ASSET_SUFFIX 包"

# manifest 里的 app 未必都已上传成功，过滤掉 release 中缺失对应 zip 的项
FID=(); FSLUG=(); FNAME=(); FURL=()
for k in "${!ASLUG[@]}"; do
  zip="${AID[$k]:+${AID[$k]}-}${ASLUG[$k]}${ASSET_SUFFIX}"
  asset_exists "$zip" || continue
  FID+=("${AID[$k]}"); FSLUG+=("${ASLUG[$k]}"); FNAME+=("${ANAME[$k]}"); FURL+=("${AURL[$k]}")
done
[[ ${#FSLUG[@]} -gt 0 ]] || die "release $tag 内无可安装的 $ASSET_SUFFIX 包"

# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------

if (( do_list )); then
  echo "可安装应用 ($tag):"
  for k in "${!FSLUG[@]}"; do
    if (( have_manifest )); then
      printf '  %-12s %-16s %s — %s\n' "${FID[$k]}" "${FSLUG[$k]}" "${FNAME[$k]}" "${FURL[$k]}"
    else
      printf '  %-12s %s\n' "${FID[$k]}" "${FSLUG[$k]}"
    fi
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# 选择要安装的应用索引：无参数 → 全部（按 apps.json 顺序）；
# 否则逐个参数匹配 —— 纯数字按 id 精准，其余按 slug 子串模糊
# ---------------------------------------------------------------------------

sel_idx=()
if [[ ${#want_ids[@]} -eq 0 ]]; then
  for k in "${!FSLUG[@]}"; do sel_idx+=("$k"); done
else
  for w in "${want_ids[@]}"; do
    matched=0
    if [[ "$w" =~ ^[0-9]+$ ]]; then
      for k in "${!FID[@]}"; do
        [[ "${FID[$k]}" == "$w" ]] && { add_idx "$k"; matched=1; }
      done
    else
      for k in "${!FSLUG[@]}"; do
        case "${FSLUG[$k]}" in *"$w"*) add_idx "$k"; matched=1 ;; esac
      done
    fi
    (( matched )) || die "未知 app: '$w'。用 './install.sh --list' 查看可选项。"
  done
fi

# ---------------------------------------------------------------------------
# 逐个下载并安装（下载-安装交错，按选中顺序）—— 三模式
# ---------------------------------------------------------------------------

install_one() {
  local id="$1" slug="$2" name="$3"
  local zip="${id:+${id}-}${slug}${ASSET_SUFFIX}"
  local dest="$tmpdir/$zip" url extract_dir

  echo ""
  echo "[$name] 下载 $zip ..."
  if (( use_gh )); then
    gh release download "$tag" --repo "$REPO" --pattern "$zip" \
       --dir "$tmpdir" --clobber || { echo "[$name] 下载失败，跳过"; return 1; }
  else
    url=$(asset_url_by_name "$zip") || { echo "[$name] 在 release 中找不到 $zip，跳过"; return 1; }
    (( use_mirror )) && url="$MIRROR/$url"
    curl -fSL --progress-bar -o "$dest" "$url" || { echo "[$name] 下载失败，跳过"; return 1; }
  fi

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
  install_one "${FID[$k]}" "${FSLUG[$k]}" "${FNAME[$k]}" || fail=$((fail + 1))
done

echo ""
if (( fail )); then
  echo "完成，$fail 个应用失败。"
  exit 1
fi
echo "全部完成。"
