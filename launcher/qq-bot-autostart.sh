#!/usr/bin/env bash
# [2026-11-12] QQ 机器人统一自启入口（唯一入口）
#
# 职责收窄：只做两件事
#   1) 确保 supervisor.sh 常驻（--loop 模式，唯一的实例管理与恢复执行者）
#   2) 确保 gateway 常驻（消息收发与 harness 调用）
#
# 明确不再做的事（曾经是双实例与互抢的根源）：
#   - 不直接拉起 NapCat 实例（交给 supervisor.sh 统一管理）
#   - 不单独起 guard.sh / monitor-daemon.sh（其职责已并入 supervisor.sh）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
say() { echo "[$(date '+%F %T')] [autostart] $*" >> "$LOG_DIR/autostart.log"; }

# 用真实可执行文件判定，避免匹配到命令行里含关键字的本脚本
running_exe() {
  local pat="$1" pid
  for pid in $(pgrep -f "$pat" 2>/dev/null); do
    [ "$pid" = "$$" ] && continue
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      *qq-bot-autostart.sh*) continue ;;
    esac
    return 0
  done
  return 1
}

say "自启流程开始"

if running_exe "launcher/supervisor.sh --loop"; then
  say "supervisor 已在运行"
else
  cd "$ROOT"
  nohup bash launcher/supervisor.sh --loop >> "$LOG_DIR/supervisor.out.log" 2>&1 < /dev/null &
  disown
  say "已启动 supervisor（唯一实例管理入口）"
fi

if pgrep -f "gateway/src/main.ts" >/dev/null 2>&1; then
  say "gateway 已在运行"
else
  # [2026-11-17] 互斥：两个 autostart 同时执行时，pgrep 与 nohup 之间有空窗，
  # 会各拉一个 gateway（2026-11-17 09:17:57 实测双实例同毫秒启动）。
  # 用 mkdir 原子锁把"判定+拉起"整体串行化；gateway 自身还有 state/gateway.lock 兜底。
  LAUNCH_LOCK="$ROOT/state/autostart-gateway.lock"
  if mkdir "$LAUNCH_LOCK" 2>/dev/null; then
    cd "$ROOT"
    set -a; [ -f "$ROOT/.env" ] && . "$ROOT/.env"; set +a
    nohup node --experimental-strip-types gateway/src/main.ts >> "$LOG_DIR/gateway.out.log" 2>&1 < /dev/null &
    disown
    say "已启动 gateway"
    sleep 2
    rmdir "$LAUNCH_LOCK" 2>/dev/null || true
  else
    say "另一 autostart 正在拉起 gateway，跳过"
  fi
fi

say "自启流程完成"
