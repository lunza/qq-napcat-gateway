#!/usr/bin/env bash
# [2026-11-12] NapCat 看护进程（由 harness 后台 job 托管）
# 职责：
#   1) 镜像实例挂了 -> 重新拉起（QQ 进程退出、崩溃等）
#   2) gateway 报告持续离线超过 3 分钟 -> 重启镜像实例（应对掉线卡死）
#   3) 每巡 10 次（约 5 分钟）写一行进度，保证有可观察的进度通道
# 注意：本文件只用 ASCII 标点，避免中文全角括号在多字节截断时破坏 bash 变量名。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE="$ROOT/state"
LOGS="$ROOT/logs"
mkdir -p "$STATE" "$LOGS"
RETRY_BACKOFF=0
say() { echo "[$(date '+%F %T')] [watchdog] $*" | tee -a "$LOGS/watchdog.log"; }

napcat_pid() { pgrep -f "QQParallel/QQNapCat.app/Contents/MacOS/QQ" | head -1; }

say "启动看护, 检查间隔 30s"
N=0
while true; do
  N=$((N+1))
  PID=$(napcat_pid)
  if [ -z "$PID" ]; then
    say "NapCat 进程不存在, 重启镜像实例"
    ( cd "$ROOT" && bash launcher/start-parallel.sh > "$LOGS/parallel-start.log" 2>&1 )
    sleep 45
    RETRY_BACKOFF=$((RETRY_BACKOFF+1))
    if [ "$RETRY_BACKOFF" -ge 3 ]; then say "连续重启 $RETRY_BACKOFF 次, 退避 120s"; sleep 120; fi
    continue
  fi
  RETRY_BACKOFF=0
  if [ -f "$STATE/health.json" ]; then
    OFFLINE_SINCE=$(python3 -c "import json;d=json.load(open('$STATE/health.json'));s=d.get('offlineSince');print(int(s/1000) if s else 0)" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    if [ "${OFFLINE_SINCE:-0}" -gt 0 ] && [ $((NOW - OFFLINE_SINCE)) -gt 180 ]; then
      say "gateway 报告持续离线 $((NOW - OFFLINE_SINCE))s, 重启镜像实例"
      kill "$PID" 2>/dev/null
      sleep 5
      ( cd "$ROOT" && bash launcher/start-parallel.sh > "$LOGS/parallel-start.log" 2>&1 )
      sleep 45
    fi
  fi
  if [ $((N % 10)) -eq 0 ]; then
    ONLINE=$(python3 -c "import json;print(json.load(open('$STATE/health.json')).get('online'))" 2>/dev/null || echo unknown)
    say "第 $((N*30/60)) 分钟: 巡一次, NapCat PID=$PID, 在线=$ONLINE"
  fi
  sleep 30
done
