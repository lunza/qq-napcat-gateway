#!/usr/bin/env bash
# [2026-11-12] 一次性迁移脚本：把 QQ 基础包入口从旧式容器内 loadNapCat.js
# 切换到正常入口，并把启动包装器放进 QQ 7.x 热更包。
#
# 背景：QQ 已于 2026-11-12 08:59 热更到 7.0.3，实际加载的是热更包
#       （基础包 package.json 里 run_from_update=true）。
#       旧入口引用的是 2025-07 的 Windows 版 NapCat，早已失效。
#
# 安全：任何一步失败立即退出；package.json 先备份；只改 "main" 一个字段。
set -euo pipefail

APP_DIR="/Applications/QQ.app/Contents/Resources/app"
VERS="$HOME/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions"
WRAPPER_SRC="$(cd "$(dirname "$0")" && pwd)/napcat-boot.js"
[ -f "$WRAPPER_SRC" ] || { echo "缺少包装器 $WRAPPER_SRC"; exit 1; }

echo "== 1/3 基础包入口改为官方入口 =="
python3 - "$APP_DIR/package.json" <<'PY'
import json, shutil, sys
pj = sys.argv[1]
d = json.load(open(pj))
shutil.copy2(pj, pj + '.bak-20261112')
orig = './application.asar/app_launcher/index.js'
if d.get('main') != orig:
    d['main'] = orig
    with open(pj, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
    print('  基础包 main ->', orig)
else:
    print('  基础包 main 已是官方值')
PY

echo "== 2/3 热更包放入启动包装器 =="
patched=0
for dir in "$VERS"/*/; do
  app="${dir}QQUpdate.app/Contents/Resources/app"
  pj="$app/package.json"
  [ -f "$pj" ] || continue
  cp "$WRAPPER_SRC" "$app/loadNapCat.js"
  python3 - "$pj" <<'PY'
import json, shutil, sys
pj = sys.argv[1]
d = json.load(open(pj))
shutil.copy2(pj, pj + '.bak-20261112')
if d.get('main') != './loadNapCat.js':
    d['main'] = './loadNapCat.js'
    with open(pj, 'w') as f:
        json.dump(d, f, indent=2, ensure_ascii=False)
print('  ', pj, '-> ./loadNapCat.js')
PY
  patched=$((patched + 1))
done
[ "$patched" -gt 0 ] || { echo "未找到热更包，中止"; exit 1; }

echo "== 3/3 校验 =="
python3 - "$APP_DIR/package.json" "$VERS" <<'PY'
import glob, json, sys
base = json.load(open(sys.argv[1]))
print('  基础包 main =', base.get('main'))
for p in glob.glob(sys.argv[2] + '/*/QQUpdate.app/Contents/Resources/app/package.json'):
    d = json.load(open(p))
    print(' ', d.get('version'), 'main =', d.get('main'))
PY
echo "完成。请完全退出 QQ（Cmd+Q）后重新打开，由包装器拉起 NapCat。"
