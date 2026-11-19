#!/usr/bin/env bash
set -euo pipefail
[[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]] || { echo '请在搭载 Apple 芯片的 Mac 上使用原生终端运行安装命令' >&2; exit 1; }
cd "$(dirname "$0")"
app=$(find . -maxdepth 1 -name "*.app" -type d | head -1)
if [ -z "$app" ]; then echo "未找到 .app"; exit 1; fi
name=$(basename "$app")
read_bundle_id() { plutil -extract CFBundleIdentifier raw -o - -- "$1/Contents/Info.plist"; }
bundle_id=$(read_bundle_id "$app")
xattr -dr com.apple.quarantine "$app"

# 远程安装器传入已选定的目录；独立运行时自行选择
dest_base=${CLOUD_GAMES_DEST_BASE:-}
if [ -z "$dest_base" ]; then
  if [ -w /Applications ]; then dest_base=/Applications; else dest_base="$HOME/Applications"; fi
fi
mkdir -p "$dest_base"
dest="$dest_base/$name"
previous=''
if [ -e "$dest" ]; then
  installed_id=$(read_bundle_id "$dest" 2>/dev/null || true)
  if [ "$installed_id" != "$bundle_id" ]; then
    printf '无法确认「%s」是这款游戏，已有的同名应用未被替换。请在访达中确认它的身份，再决定是否移走它\n' "$dest" >&2
    exit 1
  fi
  if [ ! -w "$dest" ]; then
    printf '当前账户不能更新「%s」，原有应用未改动。请使用有权更新该应用的账户重试\n' "$dest" >&2
    exit 1
  fi
else
  # 首装或改名才查找旧包；日常更新走上面的同名路径
  for other in "$dest_base"/*.app; do
    [ -d "$other" ] && [ ! -L "$other" ] || continue
    other_id=$(read_bundle_id "$other" 2>/dev/null) || continue
    [ "$other_id" = "$bundle_id" ] || continue
    if [ -n "$previous" ]; then printf '找到多份旧应用，请先手动整理：%s、%s\n' "$previous" "$other" >&2; exit 1; fi
    previous=$other
  done
fi

# 先复制到同卷临时目录，避免复制失败时破坏旧安装
tmp="$dest_base/.${name}.tmp.$$"
rm -rf "$tmp"
trap 'rm -rf "$tmp"' EXIT
cp -cR "$app" "$tmp"
rm -rf "$dest"
mv "$tmp" "$dest"
if [ -n "$previous" ]; then rm -rf "$previous"; fi
echo "已安装：$dest"
