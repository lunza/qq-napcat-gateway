#!/usr/bin/env bash
# [2026-11-12] gateway → harness 的桥接入口
# 约定：接受与 `dsh --profile headless` 相同的 app 参数（--session-id / --approval-policy / task）
# 环境变量 DSH_BRIDGE_PROFILE 指定 profile（默认 headless-qq）
# 说明：Electron Helper 以 ELECTRON_RUN_AS_NODE=1 运行时支持读取 app.asar 内的 dsh CLI，
#       普通 node 无法 require asar，因此必须用它。
set -euo pipefail
DSH_APP="/Applications/DSH NEXT.app"
HELPER="$DSH_APP/Contents/Frameworks/DSH NEXT Helper.app/Contents/MacOS/DSH NEXT Helper"
BIN="$DSH_APP/Contents/Resources/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js"
PROFILE="${DSH_BRIDGE_PROFILE:-headless-qq}"
exec env ELECTRON_RUN_AS_NODE=1 "$HELPER" "$BIN" --profile "$PROFILE" "$@"
