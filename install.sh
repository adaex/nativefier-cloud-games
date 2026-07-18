#!/usr/bin/env bash
# install.sh — 云游戏客户端远程分发器（standalone，可 curl | bash 运行）
#
# 注意：这不是 zip 包内的 install.sh。本脚本负责下载 GitHub Release 的 zip，
#       解压后再调用各 zip 内的 install.sh（去 quarantine + 复制到 /Applications）。
#
# 用法：
#   ./install.sh                      安装全部应用
#   ./install.sh migufun-pc mihoyo-ys 仅安装指定 app id
#   ./install.sh --list               列出可安装的应用
#   curl -fsSL <raw-url> | bash -s -- migufun-pc   远程一行安装
#
# 兼容 macOS 自带 bash 3.2：不使用关联数组 / mapfile；set -u 下不对空数组做
# "${arr[@]}" 展开（该展开在 3.2 会报 unbound variable）。

set -euo pipefail

REPO="adaex/nativefier-cloud-games"
MIRROR="https://v6.gh-proxy.org"
ASSET_SUFFIX="-darwin-arm64.zip"
MANIFEST_ASSET="manifest.json"          # CI 上传到 release 的精简 manifest 显示名

# ---------------------------------------------------------------------------
# 函数定义（须在调用前）
# ---------------------------------------------------------------------------

die() { echo "错误: $*" >&2; exit 1; }

print_help() {
  cat <<'EOF'
用法: install.sh [选项] [app-id ...]

  无 app-id      安装全部应用
  指定 app-id    仅安装列出的应用（如: install.sh migufun-pc mihoyo-ys）

选项:
  -l, --list     列出可安装的应用（id + 名称 + 网址）后退出
  -h, --help     显示本帮助
      --mirror   通过镜像下载 (https://v6.gh-proxy.org)，国内网络更快
      --no-mirror  直连 GitHub（默认）
      --gh       强制使用 gh cli 下载
      --no-gh    禁用 gh cli

远程一行安装:
  curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- migufun-pc
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

# id 是否在后续参数列表中
in_list() {
  local x="$1"; shift
  local e
  for e in "$@"; do
    [[ "$e" == "$x" ]] && return 0
  done
  return 1
}

# 从并行数组 MID/MNAME/MURL 中查显示名 / url（找不到名字回退 id）
lookup_name() {
  local q="$1" k
  for k in "${!MID[@]}"; do
    [[ "${MID[$k]}" == "$q" ]] && { printf '%s' "${MNAME[$k]}"; return; }
  done
  printf '%s' "$q"
}
lookup_url() {
  local q="$1" k
  for k in "${!MID[@]}"; do
    [[ "${MID[$k]}" == "$q" ]] && { printf '%s' "${MURL[$k]}"; return; }
  done
}

# 下载并解析精简 manifest；成功填充 MID/MNAME/MURL 并返回 0，失败返回 1
fetch_manifest() {
  local mf="$tmpdir/$MANIFEST_ASSET" url j=0 id name murl
  if (( use_gh )); then
    gh release download "$tag" --repo "$REPO" --pattern "$MANIFEST_ASSET" \
       --dir "$tmpdir" --clobber >/dev/null 2>&1 || return 1
  else
    url=$(asset_url_by_name "$MANIFEST_ASSET") || return 1
    (( use_mirror )) && url="$MIRROR/$url"
    curl -fsSL "$url" -o "$mf" || return 1
  fi
  [[ -f "$mf" ]] || return 1
  while id=$(plutil -extract "$j.id" raw -o - -- "$mf" 2>/dev/null); do
    name=$(plutil -extract "$j.name" raw -o - -- "$mf" 2>/dev/null || printf '%s' "$id")
    murl=$(plutil -extract "$j.url"  raw -o - -- "$mf" 2>/dev/null || printf '')
    MID+=("$id"); MNAME+=("$name"); MURL+=("$murl")
    j=$((j + 1))
  done
  [[ ${#MID[@]} -gt 0 ]]
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

MID=(); MNAME=(); MURL=()
have_manifest=0
if fetch_manifest; then
  have_manifest=1
else
  echo "提示: 未获取到 ${MANIFEST_ASSET}（可能是旧 release），仅显示 id。" >&2
fi

# ---------------------------------------------------------------------------
# 计算可选 id（列出 zip assets 去后缀）—— 无需额外索引
# ---------------------------------------------------------------------------

avail_ids=()
for a in "${asset_names[@]}"; do
  case "$a" in
    *"$ASSET_SUFFIX") avail_ids+=("${a%"$ASSET_SUFFIX"}") ;;
  esac
done
[[ ${#avail_ids[@]} -gt 0 ]] || die "release $tag 内无可安装的 $ASSET_SUFFIX 包"

# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------

if (( do_list )); then
  echo "可安装应用 ($tag):"
  for id in "${avail_ids[@]}"; do
    if (( have_manifest )); then
      printf '  %-16s %s — %s\n' "$id" "$(lookup_name "$id")" "$(lookup_url "$id")"
    else
      printf '  %s\n' "$id"
    fi
  done
  exit 0
fi

# ---------------------------------------------------------------------------
# 选择要安装的 id：无位置参数 → 全装；否则按 id 过滤并校验拼写
# ---------------------------------------------------------------------------

sel_ids=()
if [[ ${#want_ids[@]} -eq 0 ]]; then
  sel_ids=("${avail_ids[@]}")
else
  for w in "${want_ids[@]}"; do
    in_list "$w" "${avail_ids[@]}" \
      || die "未知 app id: '$w'。用 './install.sh --list' 查看可选项。"
    sel_ids+=("$w")
  done
fi

# ---------------------------------------------------------------------------
# 下载选中的 zip —— 三模式
# ---------------------------------------------------------------------------

echo ""
echo "准备下载 ${#sel_ids[@]} 个应用..."
if (( use_gh )); then
  for id in "${sel_ids[@]}"; do
    echo "[$id] 通过 gh 下载..."
    gh release download "$tag" --repo "$REPO" --pattern "${id}${ASSET_SUFFIX}" \
       --dir "$tmpdir" --clobber || die "[$id] 下载失败"
  done
else
  for id in "${sel_ids[@]}"; do
    fname="${id}${ASSET_SUFFIX}"
    url=$(asset_url_by_name "$fname") || die "[$id] 在 release 中找不到 $fname"
    (( use_mirror )) && url="$MIRROR/$url"
    echo "[$fname] 下载中..."
    curl -fSL --progress-bar -o "$tmpdir/$fname" "$url" || die "[$fname] 下载失败"
  done
fi

# ---------------------------------------------------------------------------
# 解压 + 调用各包内 install.sh（去 quarantine + 复制到 /Applications）
# ---------------------------------------------------------------------------

echo ""
echo "开始安装..."
for f in "$tmpdir"/*"$ASSET_SUFFIX"; do
  [[ -f "$f" ]] || continue
  filename="${f##*/}"
  extract_dir="$tmpdir/${filename%.zip}"
  echo ""
  echo "[$filename] 解压..."
  mkdir -p "$extract_dir"
  if ! unzip -qo "$f" -d "$extract_dir"; then
    echo "[$filename] 解压失败，跳过"
    continue
  fi
  if [[ -f "$extract_dir/install.sh" ]]; then
    ( cd "$extract_dir" && bash install.sh )
  else
    echo "[$filename] 未找到包内 install.sh，跳过"
  fi
done

echo ""
echo "全部完成。"
