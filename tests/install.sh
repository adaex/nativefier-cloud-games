#!/bin/bash
# 只在临时目录验证包内安装器，不访问本机的 Applications
set -euo pipefail
src="$(dirname "$0")/../packager/install.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT
export CLOUD_GAMES_DEST_BASE="$root/Applications"

make_app() {
  local dir="$1/Contents"
  mkdir -p "$dir"
  plutil -create xml1 "$dir/Info.plist"
  plutil -insert CFBundleIdentifier -string "$2" "$dir/Info.plist"
}

id=org.example.cloudgame
pkg="$root/package"
make_app "$pkg/新名.app" "$id"
cp "$src" "$pkg/install.sh"
make_app "$CLOUD_GAMES_DEST_BASE/旧名.app" "$id"
make_app "$CLOUD_GAMES_DEST_BASE/另一个应用.app" org.example.other
printf '新版' > "$pkg/新名.app/Contents/version"

# 改名时只移除匹配的旧包；下次普通更新仍能替换同名安装
bash "$pkg/install.sh"
test ! -e "$CLOUD_GAMES_DEST_BASE/旧名.app"
test -d "$CLOUD_GAMES_DEST_BASE/另一个应用.app"
cmp "$pkg/新名.app/Contents/version" "$CLOUD_GAMES_DEST_BASE/新名.app/Contents/version"
printf '下一版' > "$pkg/新名.app/Contents/version"
bash "$pkg/install.sh"
cmp "$pkg/新名.app/Contents/version" "$CLOUD_GAMES_DEST_BASE/新名.app/Contents/version"

# 有两份旧包时，不猜测该删除哪一份
mv "$CLOUD_GAMES_DEST_BASE/新名.app" "$CLOUD_GAMES_DEST_BASE/旧名.app"
make_app "$CLOUD_GAMES_DEST_BASE/旧名副本.app" "$id"
if message=$(bash "$pkg/install.sh" 2>&1); then exit 1; fi
[[ "$message" == *"找到多份旧应用"* ]]
test -d "$CLOUD_GAMES_DEST_BASE/旧名.app"
test -d "$CLOUD_GAMES_DEST_BASE/旧名副本.app"
test ! -e "$CLOUD_GAMES_DEST_BASE/新名.app"
