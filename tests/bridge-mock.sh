#!/usr/bin/env bash
# [2026-11-12] 测试用假桥接：模拟 dsh-bridge.sh 的参数与输出，验证 gateway 的 harness 模式
# 约定同 dsh --profile headless [--session-id X] [--approval-policy never] <task>
while [ $# -gt 0 ]; do
  case "$1" in
    --session-id|--approval-policy) shift 2 ;;
    *) TASK="$1"; shift ;;
  esac
done
echo "已收到：$(printf '%s' "$TASK" | tail -1)"
