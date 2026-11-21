#!/usr/bin/env bash
# [2026-11-12] QQ 实例互斥守卫（单实例保证）
#
# 背景：同一个 QQ 号同一时刻只能被一个实例持有登录态。
#   两种抢占都会让界面"点登录卡死"：
#     A. 主 QQ (/Applications/QQ.app) 与 NapCat 镜像实例同时运行
#     B. 两个 NapCat 镜像实例同时运行（历史上 watchdog 与手动启动在 4 秒内各起一个）
#
# 策略：
#   - 有镜像实例在跑时，结束所有主 QQ（保留最早的镜像实例）
#   - 镜像实例多于一个时，只保留**启动最早**的那个，其余结束
#   - 启动最早 = 持有登录态的那个，结束它反而会导致掉线
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$ROOT")"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
say() { echo "[$(date '+%F %T')] [guard] $*" >> "$LOG_DIR/guard.log"; }

NAP_PATTERN="QQParallel/QQNapCat.app/Contents/MacOS/QQ"
KEEP_PID=""


# 同一类进程只保留最早启动的那个（按 PID 升序近似启动顺序）
dedupe_by_cmd() {
  local pat="$1" label="$2" pids keep
  pids=$(pgrep -f "$pat" 2>/dev/null | sort -n)
  [ -z "$pids" ] && return 0
  keep=$(printf '%s\n' "$pids" | head -1)
  for pid in $pids; do
    [ "$pid" = "$keep" ] && continue
    # 跳过 bash -c 包装进程（其命令行只是包含关键字，不是本体）
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      bash\ -c*) continue ;;
    esac
    kill "$pid" 2>/dev/null && say "已结束重复${label}进程 PID=$pid"
  done
}

check() {
  local pids nap_count pid earliest=2147483647

  # ---- 1) 镜像实例去重：保留启动最早的 ----
  pids=$(pgrep -f "$NAP_PATTERN" 2>/dev/null)
  nap_count=$(printf '%s\n' "$pids" | grep -c . || true)
  if [ "${nap_count:-0}" -gt 1 ]; then
    for pid in $pids; do
      [ "$pid" -lt "$earliest" ] && earliest=$pid
    done
    say "发现 $nap_count 个镜像实例, 保留最早启动的 PID=$earliest"
    for pid in $pids; do
      if [ "$pid" -ne "$earliest" ]; then
        kill "$pid" 2>/dev/null && say "已结束重复镜像实例 PID=$pid"
      fi
    done
  fi
  KEEP_PID=$(printf '%s\n' "$pids" | sort -n | head -1)

  # 说明：gateway / 看护 的重复由 autostart 的幂等判断和 start-parallel.sh 的启动锁负责，
  # 守卫只处理"会抢登录态"的 NapCat 重复实例，避免 pgrep -f 误杀 bash 包装进程。
  # ---- 2) 有镜像实例时，结束主 QQ ----
  [ -z "$KEEP_PID" ] && return 0
  for pid in $(pgrep -f "^/Applications/QQ.app/Contents/MacOS/QQ" 2>/dev/null); do
    say "镜像实例(PID=$KEEP_PID)在运行, 结束主 QQ(PID=$pid)以免抢占登录态"
    kill "$pid" 2>/dev/null
  done
}

if [ "${1:-}" = "--loop" ]; then
  say "守卫启动, 每 5 秒检查"
  while true; do check; sleep 5; done
else
  check
fi
