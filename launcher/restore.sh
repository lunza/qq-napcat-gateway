#!/usr/bin/env bash
# [2026-11-12] 回滚：把 QQ 热更包入口恢复为官方原值，并删除包内 wrapper。
# 用法：bash launcher/restore.sh
set -euo pipefail
VERS="$HOME/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/versions"
for dir in "$VERS"/*/; do
  app="${dir}QQUpdate.app/Contents/Resources/app"
  pj="$app/package.json"
  [ -f "$pj" ] || continue
  python3 - "$pj" "$app" <<'PY'
import json,sys,os
pj,app=sys.argv[1],sys.argv[2]
d=json.load(open(pj))
orig='./application.asar/app_launcher/index.js'
if d.get('main')!=orig:
    d['main']=orig
    json.dump(d,open(pj,'w'),indent=2,ensure_ascii=False)
    print('restored',pj)
w=os.path.join(app,'loadNapCat.js')
if os.path.exists(w):
    os.remove(w); print('removed',w)
PY
done
echo "已恢复。请重启 QQ。"
