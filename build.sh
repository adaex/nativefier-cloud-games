#!/bin/bash

# Automatically get the latest Electron version
# https://releases.electronjs.org/release?channel=stable
echo "正在获取最新的 Electron 版本..."
ELECTRON_VERSION=$(npm view electron version --registry https://registry.npmmirror.com)

echo "使用 Electron 版本: $ELECTRON_VERSION"

nativefier "https://www.migufun.com/middleh5/ucenter" dist \
  --name "MiGuFun" \
  --icon "icons/migufun.icns" \
  --bookmarks-menu "menus/migufan.json" \
  --platform "darwin" \
  --arch "arm64" \
  --electron-version "$ELECTRON_VERSION" \
  --single-instance \
  --fast-quit \
  # --verbose \


nativefier "https://ys.mihoyo.com/cloud/#/" dist \
  --name "miHoYo" \
  --icon "icons/mihoyo.icns" \
  --bookmarks-menu "menus/mihoyo.json" \
  --platform "darwin" \
  --arch "arm64" \
  --electron-version "$ELECTRON_VERSION" \
  --single-instance \
  --fast-quit \
  # --verbose \