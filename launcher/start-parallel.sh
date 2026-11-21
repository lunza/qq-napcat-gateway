#!/usr/bin/env bash
# [2026-11-12] 并行实例启动器：在隔离镜像目录里用 QQ 7.0.3 的 Electron 启动 NapCat。
#
# 为什么需要它(实测原因)：
#   QQ 7.x 由 app_launcher(原生 QQEXDOC)接管主进程，它硬编码加载热更包里的
#   application.asar/background.js，不改三进制的前提下无法注入 NapCat。
#   QQ Helper 的 Electron 二进制仅在 ELECTRON_RUN_AS_NODE 下可作纯 Node 使用(无 GUI 能力)，
#   NapCat 又必须运行在带 GUI 的 QQ Electron 主进程里 —— 因此改为：
#   复制一份 QQ.app(231MB，排除体积大的插件)到独立镜像目录，在镜像里用官方方式注入。
#
# 隔离保证：
#   - 镜像目录：~/Library/Application Support/QQParallel/QQNapCat.app (退出即恢复干净)
#   - 独立登录态：--user-data-dir 指向独立目录，不碰你日常 QQ 的登录态
#   - NapCat 与主 QQ 共用同一个 napcat.mjs 与配置目录
#
# 用法：bash launcher/start-parallel.sh [--foreground]
set -euo pipefail

BASE="/Applications/QQ.app"
NAME="QQNapCat"
PAR_ROOT="$HOME/Library/Application Support/QQParallel"
DEST="$PAR_ROOT/$NAME.app"
# 关键：user-data-dir 必须独立。若与主 QQ 共用登录态目录，QQ 会读取其中的
# versions/7.0.3-54395/ 热更配置并跳去加载热更包，镜像目录里的入口就不会被使用。
UDD="$PAR_ROOT/Profile"
NAP="$HOME/Library/Containers/com.tencent.qq/Data/Documents/napcat"
LOG="$PAR_ROOT/logs"
MARKER="$PAR_ROOT/.prepared-$NAME"

mkdir -p "$PAR_ROOT" "$LOG" "$UDD"

# [2026-11-12] 启动锁 + 单实例判断：防止 watchdog 与手动启动在秒级内各拉起一个实例，
# 两个实例共享同一 user-data-dir 时会互相抢登录态（表现为登录页卡死）。
LOCK="$PAR_ROOT/.start.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "已有启动流程在进行（${LOCK}），退出"
  exit 0
fi

# [2026-11-12] 启动冷却：QQ 进程从 spawn 到出现在 pgrep 结果里有 1~3 秒延迟，
# 仅靠上面的 pgrep 检查会让"紧接着的第二次调用"也通过，产生双实例。
# 这里用时间戳文件做 20 秒冷却，彻底堵住窗口期。
COOLDOWN="$PAR_ROOT/.last_start"
COOLDOWN_SEC=20
if [ -f "$COOLDOWN" ]; then
  LAST=$(cat "$COOLDOWN" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  ELAPSED=$(( NOW - LAST ))
  if [ "$ELAPSED" -lt "$COOLDOWN_SEC" ]; then
    echo "距上次启动仅 ${ELAPSED}s（冷却 ${COOLDOWN_SEC}s 内），跳过"
    exit 0
  fi
fi
date +%s > "$COOLDOWN"
trap 'rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

if pgrep -f "QQParallel/QQNapCat.app/Contents/MacOS/QQ" >/dev/null 2>&1; then
  echo "NapCat 镜像实例已在运行，无需重复启动"
  exit 0
fi

if [ ! -f "$MARKER" ]; then
  echo "== 创建镜像 (首次约 200MB) =="
  rm -rf "$DEST.tmp"
  mkdir -p "$DEST.tmp"
  # 只复制运行必需的：可执行、框架、Resources；排除体积大的插件与更新包
  /usr/bin/rsync -a \
    --exclude='Contents/Resources/app/ppapi_player.plugin' \
    --exclude='Contents/Resources/app/nni_player.plugin' \
    --exclude='Contents/Resources/app/avsdk/libAVSDKPlugin.dylib' \
    --exclude='Contents/Resources/updater' \
    "$BASE/Contents/MacOS" "$DEST.tmp/Contents/" 2>/dev/null || {
      mkdir -p "$DEST.tmp/Contents"; cp -R "$BASE/Contents/MacOS" "$DEST.tmp/Contents/"; }
  for d in Frameworks Resources; do
    /usr/bin/rsync -a \
      --exclude='Resources/app/ppapi_player.plugin' \
      --exclude='Resources/app/nni_player.plugin' \
      --exclude='Resources/app/avsdk/libAVSDKPlugin.dylib' \
      "$BASE/Contents/$d" "$DEST.tmp/Contents/"
  done
  cp "$BASE/Contents/Info.plist" "$DEST.tmp/Contents/Info.plist"
  mv "$DEST.tmp" "$DEST"
  echo "== 注入 NapCat 入口 =="
  APP="$DEST/Contents/Resources/app"
  cat > "$APP/loadNapCat.js" <<JS
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const NAPCAT_MAIN = '$NAP/napcat.mjs';
const loadNapcat = process.argv.includes('--no-sandbox');
const pkg = require(path.join(__dirname, 'package.json'));
if (loadNapcat) {
  import(pathToFileURL(NAPCAT_MAIN).href);
} else {
  require(path.join(__dirname, 'app_launcher/index.js'));
  setImmediate(() => {
    if (global.launcher && global.launcher.installPathPkgJson) {
      global.launcher.installPathPkgJson.main = ((v) => {
        if (v >= 29271) return './application.asar/app_launcher/index.js';
        if (v >= 28060) return './application/app_launcher/index.js';
        return './app_launcher/index.js';
      })(pkg.buildVersion);
    }
    setTimeout(() => {
      if (global.__napcatStarted) return;
      global.__napcatStarted = true;
      console.log('[napcat-boot] starting NapCat');
      import(pathToFileURL(NAPCAT_MAIN).href).catch(e => console.error('[napcat-boot] fail', e));
    }, 500);
  });
}
JS
  python3 - "$APP/package.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d['main'] = './loadNapCat.js'
json.dump(d, open(p, 'w'), indent=2, ensure_ascii=False)
print('  main -> ./loadNapCat.js')
PY
  touch "$MARKER"
fi

# 关闭 Gatekeeper 对副本的隔离标记(副本来源可信：本机 /Applications)
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "== 启动 $NAME(独立 user-data-dir)=="
"$DEST/Contents/MacOS/QQ" \
  --user-data-dir="$UDD" \
  --no-first-run \
  >> "$LOG/parallel.out.log" 2>&1 &
PID=$!
echo "PID=$PID"
echo "日志: $LOG/parallel.out.log"
echo "NapCat 日志: $NAP/logs/"
sleep ${2:-0}
