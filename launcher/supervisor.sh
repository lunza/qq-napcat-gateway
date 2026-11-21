#!/usr/bin/env bash
# [2026-11-12] QQ 机器人统一看护（唯一入口，替代 monitor-daemon.sh + guard.sh + 各自拉实例）
#
# 设计原则（针对 2026-11-12 14:03 掉线事故）：
#   1. 唯一入口：本脚本是**唯一**允许拉起 NapCat 实例的地方；LaunchAgent 只调它。
#      避免 watchdog / guard / autostart 三方并发导致双实例抢登录态。
#   2. 恢复分层：
#        L1 NapCat 自带：SelfOffline/KickedOffLine -> Worker 重启 -> NAPCAT_QUICK_ACCOUNT 自动登录
#                       （必须保留多进程；单进程下 requestRestartProcess 会报"未初始化"）
#        L2 本脚本：进程不存在 -> 重启实例；账号离线超过阈值 -> 结束实例并重启（触发重新登录）
#        L3 本脚本：连续失败退避，避免疯狂重启触发风控
#   3. 判活以 NapCat 真实状态为准（get_status.online），不信任任何缓存文件。
#   4. 每次动作都写日志，掉线全过程可追溯。
#
# 用法：
#   bash launcher/supervisor.sh          # 单次巡检（LaunchAgent 每 N 秒调一次）
#   bash launcher/supervisor.sh --loop   # 常驻循环（调试用）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
STATE_DIR="$ROOT/state"
# [2026-11-12] 必须匹配整个 app（含 QQ Helper 子进程）：OneBot 端口是 Worker/Helper 持有的，
# 只匹配 Contents/MacOS/QQ 会漏掉真正占端口的进程，导致 kill 后端口仍被占（EADDRINUSE）。
NAP_PATTERN="QQParallel/QQNapCat.app"
HTTP="http://127.0.0.1:3000"
mkdir -p "$LOG_DIR" "$STATE_DIR"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# 阈值（秒）
OFFLINE_RESTART_SEC=150      # 离线超过 2.5 分钟 -> 重启实例
BACKOFF_FILE="$STATE_DIR/.supervisor_backoff"
FAIL_FILE="$STATE_DIR/.supervisor_fails"

say() { echo "[$(date '+%F %T')] [supervisor] $*" >> "$LOG_DIR/supervisor.log"; }

# 单次 curl，带超时；拿不到就返回空
probe_online() {
  local r
  r=$(curl -s -m 6 -X POST "$HTTP/get_status" -H 'Content-Type: application/json' -d '{}' 2>/dev/null) || return 1
  [ -z "$r" ] && return 1
  echo "$r" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print('1' if d.get('status')=='ok' and d.get('data',{}).get('online') is True else '0')
except Exception:
    print('0')
" 2>/dev/null
}

# 主进程 PID（判断"有几个实例"只能看这个）
main_pids() { pgrep -f "QQParallel/QQNapCat.app/Contents/MacOS/QQ" 2>/dev/null | sort -n; }
# app 内全部进程（含 Helper，仅在兜底清理残留时使用）
nap_pids() { pgrep -f "$NAP_PATTERN" 2>/dev/null | sort -n; }
nap_count() { main_pids | wc -l | tr -d ' '; }

start_instance() {
  # start-parallel.sh 内部有原子锁与"已在运行"检查，重复调用是安全的
  say "拉起 NapCat 实例"
  ( cd "$ROOT" && bash launcher/start-parallel.sh >> "$LOG_DIR/parallel-start.log" 2>&1 )
}

# [2026-11-12] 结束实例。关键：先 SIGCONT 解冻，否则处于 SIGSTOP 的进程收不到 SIGKILL 生效前的信号、
# 且会一直占着 3000/3001 端口，导致新实例登录成功却 EADDRINUSE 绑定失败（曾真实发生）。
# [2026-11-12] 结束实例：必须优雅退出。
# 关键教训：`kill -9` 强杀会让 QQ 服务端残留会话，下次登录报"已登录,无法重复登录"，
# 只能人工去手机端踢线 —— 这是唯一的人工步骤。改为 SIGTERM 优雅退出后，
# 实例会自行向服务端注销，实测可立即重新登录成功。
# 强杀只作为优雅退出超时后的最后手段，并会记录日志警告。
kill_all_instances() {
  local mains i
  mains=$(pgrep -f "QQParallel/QQNapCat.app/Contents/MacOS/QQ" 2>/dev/null)
  if [ -z "$mains" ]; then
    # 主进程不在但端口被孤儿 Helper 占用
    if lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
      say "主进程已退出但端口被孤儿进程占用，清理中"
      for p in $(nap_pids); do kill -CONT "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; done
      sleep 5
      for p in $(nap_pids); do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done
    fi
    wait_port_free 15 >/dev/null 2>&1
    return 0
  fi

  say "优雅停止实例主进程: $(echo $mains | tr ' ' ' ')"
  for p in $mains; do kill -CONT "$p" 2>/dev/null; kill -TERM "$p" 2>/dev/null; done

  # 最多等 25 秒优雅退出
  for i in $(seq 1 25); do
    sleep 1
    [ -z "$(pgrep -f 'QQParallel/QQNapCat.app/Contents/MacOS/QQ' 2>/dev/null)" ] && break
  done

  if [ -n "$(pgrep -f 'QQParallel/QQNapCat.app/Contents/MacOS/QQ' 2>/dev/null)" ]; then
    say "警告：优雅退出超时，改用强制结束（可能会导致服务端残留会话）"
    for p in $(pgrep -f 'QQParallel/QQNapCat.app/Contents/MacOS/QQ' 2>/dev/null); do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done
    sleep 3
  else
    say "实例已优雅退出"
  fi

  # 清理可能残留的 Helper 与端口
  if lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
    say "端口仍被占用，清理残留子进程"
    for p in $(nap_pids); do kill -CONT "$p" 2>/dev/null; kill -9 "$p" 2>/dev/null; done
    sleep 2
  fi
  wait_port_free 20
}

# 等待 OneBot 端口释放（旧进程僵持时端口会一直被占）
wait_port_free() {
  local max=${1:-20} i=0
  while [ "$i" -lt "$max" ]; do
    if ! lsof -nP -iTCP:3001 -sTCP:LISTEN >/dev/null 2>&1; then
      [ "$i" -gt 0 ] && say "端口已释放（等待 ${i}s）"
      return 0
    fi
    sleep 1
    i=$((i+1))
  done
  say "警告：3001 端口 ${max}s 后仍被占用"
  return 1
}

# 记录离线起始时间（用于判断持续离线多久）
mark_offline() {
  local f="$STATE_DIR/.offline_since"
  if [ ! -f "$f" ]; then date +%s > "$f"; say "开始记录离线时间"; fi
}
clear_offline() {
  local f="$STATE_DIR/.offline_since"
  if [ -f "$f" ]; then rm -f "$f"; say "已恢复在线"; fi
}
offline_seconds() {
  local f="$STATE_DIR/.offline_since"
  if [ -f "$f" ]; then echo $(( $(date +%s) - $(cat "$f" 2>/dev/null || echo 0) )); else echo 0; fi
}

# 退避：连续失败 N 次后，等待时间递增，避免疯狂重启被风控
backoff_remaining() {
  [ -f "$BACKOFF_FILE" ] || { echo 0; return; }
  local until; until=$(cat "$BACKOFF_FILE" 2>/dev/null || echo 0)
  local now=$(( $(date +%s) ))
  local left=$(( until - now ))
  [ "$left" -gt 0 ] && echo "$left" || echo 0
}
set_backoff() {
  local fails=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$fails" > "$FAIL_FILE"
  local wait=30
  [ "$fails" -ge 2 ] && wait=90
  [ "$fails" -ge 3 ] && wait=300
  [ "$fails" -ge 5 ] && wait=900
  echo $(( $(date +%s) + wait )) > "$BACKOFF_FILE"
  say "重启失败累计 $fails 次，退避 ${wait}s"
}
clear_backoff() { rm -f "$FAIL_FILE" "$BACKOFF_FILE"; }

# gateway 进程守护（崩溃自动拉起）
# 判定 gateway 是否活着：只认 node 进程，排除 bash -c 等命令行里含关键字的包装进程
gateway_alive() {
  local pid
  for pid in $(pgrep -f "gateway/src/main.ts" 2>/dev/null); do
    case "$(ps -o comm= -p "$pid" 2>/dev/null)" in
      *node*) return 0 ;;
    esac
  done
  return 1
}

ensure_gateway() {
  if gateway_alive; then
    return 0
  fi
  say "gateway 不存在，拉起"
  cd "$ROOT"
  set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
  nohup node --experimental-strip-types gateway/src/main.ts >> "$LOG_DIR/gateway.out.log" 2>&1 < /dev/null &
  disown
  sleep 5
}

# 软恢复：调用 NapCat WebUI 的重启进程接口，让它自己优雅重建登录服务。
# 需要 WebUI token；拿不到就跳过（由上面的判断继续走硬重启）。
soft_restart() {
  local token resp
  token=$(python3 -c "
import json,os
p=os.path.expanduser('~/Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config/webui.json')
try: print(json.load(open(p)).get('token',''))
except Exception: print('')
" 2>/dev/null)
  if [ -z "$token" ]; then
    say "软恢复：未取到 WebUI token，跳过"
    return 1
  fi
  # NapCat WebUI 的鉴权：先登录拿 JWT，再调用重启
  resp=$(curl -s -m 8 -X POST "http://127.0.0.1:6099/api/auth/login" -H 'Content-Type: application/json' -d "{\"token\":\"$token\"}" 2>/dev/null)
  local jwt
  jwt=$(echo "$resp" | python3 -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print((d.get('data') or {}).get('Credential',''))
except Exception: print('')
" 2>/dev/null)
  if [ -n "$jwt" ]; then
    say "软恢复：WebUI 鉴权成功，请求重启"
    curl -s -m 10 -X POST "http://127.0.0.1:6099/api/QQLogin/SetQuickLogin" >/dev/null 2>&1
    curl -s -m 10 -X POST "http://127.0.0.1:6099/api/Process/Restart" -H "Authorization: Bearer $jwt" >/dev/null 2>&1
    return 0
  fi
  # 鉴权失败时用密码登录接口兜底（WebUI 支持直接密码登录，无需扫码）
  say "软恢复：WebUI 鉴权未成功，尝试走密码登录接口"
  return 1
}

# ---------- 主巡检 ----------
tick() {
  ensure_gateway
  local count online offline_sec backoff
  count=$(nap_count)

  # 1) 没有实例 -> 拉起（受退避约束）
  if [ "$count" -eq 0 ]; then
    backoff=$(backoff_remaining)
    if [ "$backoff" -gt 0 ]; then
      say "实例不存在，但处于退避期（还剩 ${backoff}s），跳过"
      mark_offline
      return
    fi
    say "实例不存在，准备拉起"
    mark_offline
    start_instance
    return
  fi

  # 2) 多余实例 -> 只保留最早启动的（它最可能持有登录态）
  if [ "$count" -gt 1 ]; then
    local keep
    keep=$(main_pids | head -1)
    say "发现 ${count} 个主进程实例，保留 PID=${keep}，结束其余"
    for p in $(main_pids); do
      [ "$p" = "$keep" ] && continue
      kill -CONT "$p" 2>/dev/null
      kill "$p" 2>/dev/null
    done
    sleep 3
  fi

  # 3) 单实例：判活
  online=$(probe_online)
  if [ "$online" = "1" ]; then
    clear_offline
    clear_backoff
    rm -f "$STATE_DIR/.soft_tried"
    return
  fi

  # 4) 探活失败或离线
  if [ -z "$online" ]; then
    say "探活无响应（实例在但不回 HTTP），视为异常"
  else
    say "napcat 报告 offline"
  fi
  mark_offline
  offline_sec=$(offline_seconds)
  say "已离线 ${offline_sec}s"

  if [ "$offline_sec" -ge "$OFFLINE_RESTART_SEC" ]; then
    backoff=$(backoff_remaining)
    if [ "$backoff" -gt 0 ]; then
      say "离线 ${offline_sec}s，但处于退避期（还剩 ${backoff}s），暂不重启"
      return
    fi

    # [2026-11-12] 软恢复优先：NapCat 自带 Worker 重启（优雅重建登录服务），
    # 能避免强杀导致的服务端残留会话。每轮离线只尝试一次，失败再走硬重启。
    if [ ! -f "$STATE_DIR/.soft_tried" ]; then
      say "离线 ${offline_sec}s，先尝试软恢复（NapCat 自带 Worker 重启）"
      touch "$STATE_DIR/.soft_tried"
      soft_restart
      sleep 20
      if [ "$(probe_online)" = "1" ]; then
        say "软恢复成功，无需重启实例"
        clear_offline; clear_backoff; rm -f "$STATE_DIR/.soft_tried"
        return
      fi
      say "软恢复无效，转入硬重启"
    fi

    say "离线 ${offline_sec}s 超过阈值 ${OFFLINE_RESTART_SEC}s，重启实例以触发重新登录"
    kill_all_instances
    start_instance
    # 给实例 40 秒登录 + 端口绑定时间，再决定是否记失败
    sleep 40
    wait_port_free 15 >/dev/null 2>&1 || true
    if [ "$(probe_online)" = "1" ]; then
      clear_offline; clear_backoff
      say "重启后已恢复在线"
    else
      set_backoff
    fi
  fi
}

say "巡检开始"
tick
say "巡检结束"

if [ "${1:-}" = "--loop" ]; then
  while true; do
    say "--- 循环巡检 ---"
    tick
    sleep 45
  done
fi
