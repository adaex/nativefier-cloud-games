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
RELEASES="https://github.com/$REPO/releases"
MIRROR="https://v6.gh-proxy.org"
ASSET_SUFFIX="-darwin-arm64.zip"
MANIFEST_ASSET="release-manifest.json"  # CI 上传的精简 manifest（id/slug/名称/URL，权威顺序=apps.json）
CHECKSUM_ASSET="checksums.txt"          # CI 上传的 zip SHA256 清单

# ---------------------------------------------------------------------------
# 函数定义（须在调用前）
# ---------------------------------------------------------------------------

die() { echo "错误：$*" >&2; exit 1; }

print_help() {
  cat <<'EOF'
用法：install.sh [选项] [安装编号或英文简称 ...]

  不指定游戏时，安装或更新全部游戏；已经是最新版的不会重复下载
  安装编号只选一款游戏，例如 1569029742 对应云·原神
  英文简称可以只输入一部分，例如 mihoyo 会选中简称中含有 mihoyo 的所有游戏

选项：
  -l, --list       列出游戏和安装编号，不安装任何应用
  -f, --force      即使已经是最新版也重新安装
  -h, --help       查看用法
      --mirror     通过镜像下载安装包，仍从 GitHub 获取游戏列表和校验记录
      --no-mirror  直接从 GitHub 下载（默认）

只安装或更新云·原神：
  curl -fsSL https://raw.githubusercontent.com/adaex/nativefier-cloud-games/main/install.sh | bash -s -- 1569029742
EOF
}

# 已选索引去重追加
add_idx() {
  local x="$1" e
  for e in ${sel_idx[@]+"${sel_idx[@]}"}; do
    [[ "$e" == "$x" ]] && return
  done
  sel_idx+=("$x")
}

manifest_field() { plutil -extract "$1" raw -o - -- "$manifest" 2>/dev/null || true; }

fetch_manifest() {
  local j id slug name
  curl -fsSL "$DOWNLOAD_BASE/$MANIFEST_ASSET" -o "$manifest" || return 1
  # 保留清单原始下标，后面只读取列出或安装所需的字段
  for ((j = 0; ; j++)); do
    plutil -extract "$j" raw -o /dev/null -- "$manifest" 2>/dev/null || break
    id=$(manifest_field "$j.id")
    slug=$(manifest_field "$j.slug")
    if [[ ! "$id" =~ ^[0-9]+$ || ! "$slug" =~ ^[a-z0-9-]+$ ]]; then
      echo "提示：manifest 第 $((j + 1)) 项的 id/slug 非法，已跳过" >&2
      continue
    fi
    name=$(manifest_field "$j.name")
    AID[j]="$id"; ASLUG[j]="$slug"; ANAME[j]="${name:-$slug}"
  done
  [[ ${#ASLUG[@]} -gt 0 ]]
}

print_games() {
  local k
  echo '可安装的游戏（用安装编号或英文简称选择）：'
  for k in "${!ASLUG[@]}"; do
    printf '  %s　安装编号：%s　英文简称：%s\n    %s\n' "${ANAME[$k]}" "${AID[$k]}" "${ASLUG[$k]}" "$(manifest_field "$k.url")"
  done
}

# 下载 zip 的 SHA256 清单。注意：即使 --mirror 也始终直连 GitHub 获取——
# 校验文件若走同一镜像，篡改者连校验值一起改，校验就失去意义
fetch_checksums() {
  local cs="$tmpdir/$CHECKSUM_ASSET"
  curl -fsSL "$DOWNLOAD_BASE/$CHECKSUM_ASSET" -o "$cs" || return 1
  [[ -s "$cs" ]]
}

# 用 checksums.txt 校验已下载的 zip；清单中无此项或不一致均拒绝安装
verify_zip() {
  local file="$1" name="$2" expected actual
  expected=$(awk -v f="${file##*/}" '$2 == f {print $1}' "$tmpdir/$CHECKSUM_ASSET")
  if [[ -z "$expected" ]]; then
    echo "【${name}】发布记录中没有这个安装包的校验值，本次未安装这款游戏。请稍后重试" >&2
    return 1
  fi
  actual=$(shasum -a 256 "$file" | awk '{print $1}')
  if [[ "$expected" != "$actual" ]]; then
    echo "【${name}】安装包与发布记录不一致，本次未安装这款游戏，已有版本不受影响" >&2
    if (( use_mirror )); then
      echo '请去掉 --mirror 后重新运行安装命令，直接从 GitHub 下载' >&2
    else
      echo '请稍后重新运行安装命令' >&2
    fi
    printf '校验值（SHA-256）：\n  发布记录：%s\n  下载文件：%s\n' "$expected" "$actual" >&2
    return 1
  fi
}

# 只检查包内安装器实际会写入的位置，并从同一份 Info.plist 读取版本与 revision
skip_if_current() {
  local k="$1" name="${ANAME[$1]}" plist electron_version revision cur_ver cur_rev
  (( ! force )) || return 1
  plist="$dest_base/$name.app/Contents/Info.plist"
  [[ -f "$plist" ]] || return 1
  electron_version=$(manifest_field "$k.electronVersion")
  cur_ver=$(plutil -extract CFBundleShortVersionString raw -o - -- "$plist" 2>/dev/null) || return 1
  [[ -n "$electron_version" && "$cur_ver" == "$electron_version" ]] || return 1
  revision=$(manifest_field "$k.revision")
  cur_rev=$(plutil -extract CloudGamesRevision raw -o - -- "$plist" 2>/dev/null) || return 1
  [[ -n "$revision" && "$cur_rev" == "$revision" ]] || return 1
  echo "【${name}】已是最新版，无需下载"
}

# ---------------------------------------------------------------------------
# 检查平台并选择安装目录
# ---------------------------------------------------------------------------

[[ "$(uname -s)" == "Darwin" ]] || die "本安装器仅支持 macOS"
[[ "$(uname -m)" == "arm64" ]] || die '请在搭载 Apple 芯片的 Mac 上使用原生终端运行安装命令'

# 整个远程安装流程只选择一次目录，并传给包内安装器，确保检查与安装指向同一位置
if [ -w /Applications ]; then dest_base=/Applications; else dest_base="$HOME/Applications"; fi

# ---------------------------------------------------------------------------
# 参数解析：分离位置参数（app id）与 flags
# ---------------------------------------------------------------------------

use_mirror=0
do_list=0
force=0
want_ids=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mirror)    use_mirror=1 ;;
    --no-mirror) use_mirror=0 ;;
    -l|--list)   do_list=1 ;;
    -f|--force)  force=1 ;;
    -h|--help)   print_help; exit 0 ;;
    --)          shift; want_ids+=("$@"); break ;;
    -*)          die "未知选项: $1（用 --help 查看用法）" ;;
    *)           want_ids+=("$1") ;;
  esac
  shift
done

# ---------------------------------------------------------------------------
# 依赖检查
# ---------------------------------------------------------------------------

command -v unzip  >/dev/null 2>&1 || die "缺少 unzip"
command -v plutil >/dev/null 2>&1 || die "缺少 plutil（macOS 自带）"
command -v shasum >/dev/null 2>&1 || die "缺少 shasum（macOS 自带）"
command -v curl   >/dev/null 2>&1 || die "缺少 curl"

# ---------------------------------------------------------------------------
# 准备临时目录
# ---------------------------------------------------------------------------

tmpdir=$(mktemp -d) || die "无法创建临时目录"
trap 'rm -rf -- "$tmpdir"' EXIT
manifest="$tmpdir/$MANIFEST_ASSET"

# ---------------------------------------------------------------------------
# 拉取精简 manifest（必需；不从 asset 名降级，避免误装已移除的旧包）
# ---------------------------------------------------------------------------

# 只向 GitHub 查询一次 latest；本次所有下载都使用同一个 tag
location=$(curl -fsSI --no-location -o /dev/null -w '%{redirect_url}' "$RELEASES/latest") || die "无法查询最新发布版本"
tag=${location#"$RELEASES/tag/"}
[[ "$tag" != "$location" && "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "无法识别最新发布版本"
DOWNLOAD_BASE="$RELEASES/download/$tag"

AID=(); ASLUG=(); ANAME=()
fetch_manifest || die "无法获取 ${MANIFEST_ASSET}（release 不完整或下载失败）"

# ---------------------------------------------------------------------------
# --list
# ---------------------------------------------------------------------------

if (( do_list )); then
  print_games
  exit 0
fi

# ---------------------------------------------------------------------------
# 选择要安装的应用索引：无参数 → 全部（按 apps.json 顺序）；
# 否则逐个参数匹配 —— 纯数字按 id 精准，其余按 slug 子串模糊
# ---------------------------------------------------------------------------

sel_idx=()
if [[ ${#want_ids[@]} -eq 0 ]]; then
  sel_idx=("${!ASLUG[@]}")
else
  for w in "${want_ids[@]}"; do
    matched=0
    for k in "${!ASLUG[@]}"; do
      if [[ "$w" =~ ^[0-9]+$ ]]; then
        [[ "${AID[$k]}" == "$w" ]] || continue
      else
        [[ "${ASLUG[$k]}" == *"$w"* ]] || continue
      fi
      add_idx "$k"
      matched=1
    done
    if (( ! matched )); then
      printf '没有找到「%s」。请从下面选择安装编号或英文简称，替换刚才命令里的游戏参数\n' "$w" >&2
      print_games >&2
      exit 1
    fi
  done
fi

fetch_checksums || die '无法从 GitHub 获取安装包的校验记录，未开始安装。请检查网络后重试'

# ---------------------------------------------------------------------------
# 逐个下载并安装（下载-安装交错，按选中顺序）
# ---------------------------------------------------------------------------

install_one() {
  local k="$1"
  local id="${AID[$k]}" slug="${ASLUG[$k]}" name="${ANAME[$k]}"
  local zip="${id}-${slug}${ASSET_SUFFIX}"
  local dest="$package_dir/$zip" extract_dir="$package_dir/app" url
  mkdir -p "$extract_dir" || return 1

  echo ""
  echo "【${name}】正在下载安装包"
  url="$DOWNLOAD_BASE/$zip"
  (( use_mirror )) && url="$MIRROR/$url"
  curl -fSL --retry 3 --speed-limit 1 --speed-time 60 --progress-bar -o "$dest" "$url" || {
    if [[ $? -eq 28 ]]; then
      echo "【${name}】下载超时，这款游戏未安装。请检查网络后重新运行安装命令" >&2
    else
      echo "【${name}】未能下载安装包。请检查网络后重试" >&2
    fi
    return 1
  }

  verify_zip "$dest" "$name" || return 1

  echo "【${name}】正在解压并安装"
  if ! unzip -qo "$dest" -d "$extract_dir"; then
    echo "【${name}】无法解压安装包，这次没有安装。请重新下载后再试" >&2; return 1
  fi
  rm -f -- "$dest" || return 1
  if [[ -f "$extract_dir/install.sh" ]]; then
    ( cd "$extract_dir" && CLOUD_GAMES_DEST_BASE="$dest_base" bash install.sh )
  else
    echo "【${name}】安装包缺少安装脚本，本次未安装这款游戏" >&2; return 1
  fi
}

echo ""
echo "正在检查 ${#sel_idx[@]} 款游戏是否需要安装或更新"
fail=0
package_dir="$tmpdir/package"
for k in "${sel_idx[@]}"; do
  if skip_if_current "$k"; then continue; fi
  install_one "$k" || fail=$((fail + 1))
  rm -rf -- "$package_dir"
done

echo ""
if (( fail )); then
  echo "有 $fail 款游戏未能完成安装或更新，请查看上方提示" >&2
  exit 1
fi
echo "所选游戏均已是最新版"
