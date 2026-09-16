#!/usr/bin/env bash
# 本番サーバーに届いた端末ログ(/var/log/transrate/client.log)を表示する。
#   ./scripts/client-logs.sh              直近200行
#   ./scripts/client-logs.sh 500          直近500行
#   ./scripts/client-logs.sh -f           追記を追跡(Ctrl+C で終了)
#   ./scripts/client-logs.sh -g ERROR     文字列で絞り込み(直近2000行から)
# 前提: ~/.ssh/config に kagoya-vps-mizy が定義されていること。
set -euo pipefail

HOST=kagoya-vps-mizy
FILE=/var/log/transrate/client.log

case "${1:-}" in
  -f) exec ssh "$HOST" "tail -n 50 -F $FILE" ;;
  -g)
    [ -n "${2:-}" ] || { echo "usage: $0 -g <文字列>" >&2; exit 1; }
    ssh "$HOST" "tail -n 2000 $FILE | grep -F -- $(printf '%q' "$2")" ;;
  '') ssh "$HOST" "tail -n 200 $FILE" ;;
  *)
    [[ "$1" =~ ^[0-9]+$ ]] || { echo "usage: $0 [行数 | -f | -g <文字列>]" >&2; exit 1; }
    ssh "$HOST" "tail -n $1 $FILE" ;;
esac
