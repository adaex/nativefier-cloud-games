nativefier "https://www.migufun.com/middleh5/ucenter" dist \
  --name "MiGuFun" \
  --icon "icons/migufun.icns" \
  --bookmarks-menu "menus/migufan.json" \
  --platform "darwin" \
  --arch "arm64" \
  --single-instance \
  --fast-quit \
  --verbose \
  --electron-version "36.4.0" \


nativefier "https://ys.mihoyo.com/cloud/#/" dist \
  --name "miHoYo" \
  --icon "icons/mihoyo.icns" \
  --bookmarks-menu "menus/mihoyo.json" \
  --platform "darwin" \
  --arch "arm64" \
  --single-instance \
  --fast-quit \
  --verbose \
  --electron-version "36.4.0" \