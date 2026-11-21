#!/usr/bin/env bash
# [2026-11-16] 表情包定时整理入口（供 dsh 定时任务每周调用）
#
# 为什么单独一个脚本：
#   dsh 定时任务只给一条命令，需要它自己解决三件事——
#     1. 加载 .env（视觉接口密钥 CREC_API_KEY，缺了就白跑）
#     2. 用固定的 node 与工作目录（不依赖调用方的 PATH/cwd）
#     3. 记录退出码与耗时，方便定时任务侧判断成功失败
#
# 用法：
#   bash launcher/organize-weekly.sh          # 跑一轮（有积压就跑完）
#   bash launcher/organize-weekly.sh --drain  # 一直跑到队列清空（默认就是 drain）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
say() { echo "[$(date '+%F %T')] [organize-weekly] $*" >> "$LOG_DIR/organize-weekly.log"; }

cd "$ROOT" || { say "无法进入目录 $ROOT"; exit 1; }

# 载入环境变量（密钥在里面）
if [ -f "$ROOT/.env" ]; then
  set -a; . "$ROOT/.env"; set +a
fi
if [ -z "${CREC_API_KEY:-}" ]; then
  say "缺少 CREC_API_KEY，整理任务无法进行（原件仍会照常保存，修好密钥后会补整理）"
  exit 2
fi

# 找到可用的 node
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  say "找不到 node，任务无法执行"
  exit 3
fi

say "开始整理（node=${NODE_BIN}）"
START=$(date +%s)

# --drain：一次跑到底，直到没有待下载/待整理的项
OUT="$("$NODE_BIN" --experimental-strip-types gateway/src/main.ts --organize --drain 2>&1)"
CODE=$?
# 只把结构化结果那行（JSON）取出来记日志，其余是运行日志
JSON_LINE="$(printf '%s\n' "$OUT" | grep -E '^\{"ok"' | tail -1)"
ELAPSED=$(( $(date +%s) - START ))

if [ $CODE -eq 0 ]; then
  say "完成，耗时 ${ELAPSED}s，结果：${JSON_LINE:-（无结构化输出）}"
else
  say "失败（exit=${CODE}），耗时 ${ELAPSED}s，输出尾部："
  printf '%s\n' "$OUT" | tail -5 | while IFS= read -r line; do say "  $line"; done
fi

# 始终把结构化 JSON 打到 stdout：dsh 定时任务能直接看到结果
[ -n "$JSON_LINE" ] && echo "$JSON_LINE"
exit $CODE
