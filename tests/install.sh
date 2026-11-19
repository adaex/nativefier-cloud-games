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

expect_install_failure() {
  if message=$(bash "$pkg/install.sh" 2>&1) || [[ "$message" != *"$1"* ]]; then
    printf '预期安装失败并提示「%s」，实际输出：%s\n' "$1" "$message" >&2
    return 1
  fi
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

# 当前账户不能写入已有应用时，不应引导用户删除它
if (( EUID != 0 )); then
  dest="$CLOUD_GAMES_DEST_BASE/新名.app"
  chmod u-w "$dest"
  expect_install_failure '原有应用未改动' || { chmod u+w "$dest"; exit 1; }
  chmod u+w "$dest"
  [[ "$message" != *"删除"* ]]
  cmp "$pkg/新名.app/Contents/version" "$dest/Contents/version"
fi

# 有两份旧包时，不猜测该删除哪一份
mv "$CLOUD_GAMES_DEST_BASE/新名.app" "$CLOUD_GAMES_DEST_BASE/旧名.app"
make_app "$CLOUD_GAMES_DEST_BASE/旧名副本.app" "$id"
expect_install_failure '找到多份旧应用'
test -d "$CLOUD_GAMES_DEST_BASE/旧名.app"
test -d "$CLOUD_GAMES_DEST_BASE/旧名副本.app"
test ! -e "$CLOUD_GAMES_DEST_BASE/新名.app"

# 同名但不是这款游戏时，说明为什么停止，并保留已有应用
make_app "$CLOUD_GAMES_DEST_BASE/新名.app" org.example.unrelated
expect_install_failure '已有的同名应用未被替换'
test "$(plutil -extract CFBundleIdentifier raw -o - -- "$CLOUD_GAMES_DEST_BASE/新名.app/Contents/Info.plist")" = org.example.unrelated
