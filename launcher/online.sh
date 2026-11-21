#!/usr/bin/env bash
# [2026-11-13] 一键上线：把 QQ 机器人整套进程拉起来。
#
# 背景：DSH 重启后，原本由 DSH 会话启动的 supervisor / gateway / NapCat 会全部消失，
# 机器人表现为离线。设置页需要一个"上线"按钮，不需要用户回到 DSH 会话里手动敲命令。
#
# 设计要点：
#   1. 幂等：反复点不会产生第二个 supervisor 或第二个 gateway（曾因双实例互抢登录态掉线）
#   2. 结果落盘：把每一步结果写进 logs/autostart.log，设置页直接读这个文件展示
#   3. 快速返回：只负责"拉起"，不在这里等 30~60 秒登录，登录进度由 supervisor 自己收敛
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
say() { echo "[$(date '+%F %T')] [online] $*" >> "$LOG_DIR/autostart.log"; }

say "=== 手动上线请求 ==="

# 1) supervisor：常驻巡检者，负责盯 NapCat 并自动恢复
SUP_ALIVE=0
for pid in $(pgrep -f "launcher/supervisor.sh --loop" 2>/dev/null); do
  case "$(ps -o command= -p "$pid" 2>/dev/null)" in
    *qq-bot-autostart.sh*) continue ;;   # 排除调用本流程的包装进程
  esac
  SUP_ALIVE=1; break
done
if [ "$SUP_ALIVE" -eq 1 ]; then
  say "supervisor 已在运行，跳过"
else
  cd "$ROOT" || exit 1
  nohup bash launcher/supervisor.sh --loop >> "$LOG_DIR/supervisor.out.log" 2>&1 < /dev/null &
  disown
  say "已启动 supervisor"
fi

# 2) gateway：消息收发 + 调用 harness
#    注意：supervisor 的巡捡也会拉起 gateway，这里如果发现 gateway 不在就等它一下，
#    避免两边同时拉起导致双实例。
wait_gateway() {
  local i
  for i in $(seq 1 20); do
    if pgrep -f "gateway/src/main.ts" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}
if pgrep -f "gateway/src/main.ts" >/dev/null 2>&1; then
  say "gateway 已在运行，跳过"
else
  # 先给 supervisor 一个巡检周期去拉，它拉起来就不重复拉
  if wait_gateway; then
    say "gateway 已由 supervisor 拉起"
  else
    cd "$ROOT" || exit 1
    set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
    nohup node --experimental-strip-types gateway/src/main.ts >> "$LOG_DIR/gateway.out.log" 2>&1 < /dev/null &
    disown
    say "已启动 gateway"
  fi
fi

# 3) 探活 NapCat：不回 HTTP 就交给 supervisor 的恢复逻辑处理
nap_online() {
  local r
  r=$(curl -s -m 5 -X POST "http://127.0.0.1:3000/get_status" \
        -H 'Content-Type: application/json' -d '{}' 2>/dev/null) || return 1
  [ -n "$r" ] || return 1
  echo "$r" | grep -q '"online":true' && return 0
  return 2
}
if nap_online; then
  say "NapCat 已在线"
else
  say "NapCat 未就绪，交由 supervisor 自动拉起（约 30~60 秒）"
fi

say "=== 上线流程完成（登录需要 30~60 秒） ==="
exit 0
