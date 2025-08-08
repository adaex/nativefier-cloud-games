#!/usr/bin/env bash
set -euo pipefail

#############################
# 配置 & 说明
# 需求：自动获取最新版 Electron，使用 nativefier 打包，并将结果复制到 /Applications
# 可选：通过参数控制行为
#
# 参数：
#   --skip-copy        仅构建，不复制到 /Applications
#   --force-electron v  强制指定 Electron 版本 (例如: 31.0.2)
#   --verbose          打印 nativefier 详细日志
#   --clean            清理 dist 后再构建
#############################

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

OUTPUT_DIR="dist"
APPLICATIONS_DIR="/Applications"
REGISTRY="https://registry.npmmirror.com"

SKIP_COPY=false
VERBOSE=false
FORCE_ELECTRON=""
CLEAN=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-copy) SKIP_COPY=true ; shift ;;
    --verbose) VERBOSE=true ; shift ;;
    --force-electron) FORCE_ELECTRON="$2" ; shift 2 ;;
    --clean) CLEAN=true ; shift ;;
    -h|--help)
      cat <<EOF
用法: $0 [options]
  --skip-copy          仅构建，不复制到 /Applications
  --force-electron VER  指定 Electron 版本
  --verbose            nativefier 详细输出
  --clean              构建前删除 dist
  -h, --help           显示本帮助
EOF
      exit 0
      ;;
    *) echo "未知参数: $1" ; exit 1 ;;
  esac
done

color() { # $1=color_code $2=msg
  local c="$1"; shift; printf "\033[%sm%s\033[0m\n" "$c" "$*";
}
info(){ color 36 "[INFO] $*"; }
warn(){ color 33 "[WARN] $*"; }
err(){ color 31 "[ERR ] $*" >&2; }
succ(){ color 32 "[ OK ] $*"; }

check_cmd(){ command -v "$1" >/dev/null 2>&1 || { err "缺少命令: $1"; exit 1; }; }

check_cmd node
check_cmd npm

NATIVEFIER_CMD="npx --yes nativefier"
if ! command -v nativefier >/dev/null 2>&1; then
  info "使用 npx 方式运行 nativefier (未检测到全局安装)"
else
  NATIVEFIER_CMD="nativefier" # 已全局安装
fi

ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) NF_ARCH="arm64" ;;
  x86_64) NF_ARCH="x64" ;;
  *) warn "未知架构 $ARCH，尝试用 arm64"; NF_ARCH="arm64" ;;
esac

if [[ -n "$FORCE_ELECTRON" ]]; then
  ELECTRON_VERSION="$FORCE_ELECTRON"
  info "使用指定 Electron 版本: $ELECTRON_VERSION"
else
  info "正在获取最新 Electron 版本 (registry: $REGISTRY)..."
  if ! ELECTRON_VERSION=$(npm view electron version --registry "$REGISTRY" 2>/dev/null); then
    err "获取 Electron 版本失败"; exit 1
  fi
  succ "Electron 版本: $ELECTRON_VERSION"
fi

if $CLEAN && [[ -d "$OUTPUT_DIR" ]]; then
  info "清理 $OUTPUT_DIR ..."
  rm -rf "$OUTPUT_DIR"
fi
mkdir -p "$OUTPUT_DIR"

build_one(){
  local url="$1" name="$2" icon="$3" menu="$4"
  info "开始构建: $name"
  local extra=""
  $VERBOSE && extra="--verbose"
  # 使用子目录输出，避免名称冲突
  local target_dir="$OUTPUT_DIR/$name"
  mkdir -p "$target_dir"
  $NATIVEFIER_CMD "$url" "$target_dir" \
    --name "$name" \
    --icon "$icon" \
    --bookmarks-menu "$menu" \
    --platform "darwin" \
    --arch "$NF_ARCH" \
    --electron-version "$ELECTRON_VERSION" \
    --single-instance \
    --fast-quit \
    $extra
  succ "构建完成: $name"
}

copy_app(){
  local name="$1"
  local app_path
  # 查找输出目录里的 .app
  app_path=$(find "$OUTPUT_DIR/$name" -maxdepth 2 -type d -name "${name}.app" 2>/dev/null | head -n1 || true)
  if [[ -z "$app_path" ]]; then
    err "未找到生成的 ${name}.app"
    return 1
  fi
  if $SKIP_COPY; then
    info "跳过复制: $name"
    return 0
  fi
  if [[ ! -w "$APPLICATIONS_DIR" ]]; then
    warn "没有写入 /Applications 权限，尝试使用 sudo (可能需要输入密码)"
    if sudo test -d "$APPLICATIONS_DIR"; then
      sudo rm -rf "$APPLICATIONS_DIR/${name}.app"
      sudo cp -R "$app_path" "$APPLICATIONS_DIR/"
    else
      err "无法访问 $APPLICATIONS_DIR"; return 1
    fi
  else
    rm -rf "$APPLICATIONS_DIR/${name}.app"
    cp -R "$app_path" "$APPLICATIONS_DIR/"
  fi
  succ "已复制到 $APPLICATIONS_DIR/${name}.app"
}

# ---------------- 实际构建 ----------------
build_one "https://www.migufun.com/middlepc/ucenter" "MiGuFun" "icons/migufun.icns" "menus/migufan.json"
build_one "https://ys.mihoyo.com/cloud/#/" "miHoYo" "icons/mihoyo.icns" "menus/mihoyo.json"

copy_app "MiGuFun"
copy_app "miHoYo"

info "全部完成 ✅"
if $SKIP_COPY; then
  info "(已跳过复制阶段)"
fi