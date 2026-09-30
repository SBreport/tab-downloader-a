#!/bin/sh
set -eu

LABEL="com.tabdownloadera.media-helper"
INSTALL_DIR="$HOME/Library/Application Support/TabDownloaderAMediaHelper"
CONFIG_PATH="$INSTALL_DIR/helper-config.json"
SERVER_PATH="$INSTALL_DIR/server.cjs"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="17385"

[ -f "$CONFIG_PATH" ] && [ -f "$SERVER_PATH" ] || {
  printf 'Media Helper가 설치되지 않았습니다. install-macos.sh를 먼저 실행하세요.\n' >&2
  exit 1
}

if curl -fsS "http://127.0.0.1:$PORT/hello" >/dev/null 2>&1; then
  printf 'Media Helper가 이미 실행 중입니다.\n'
  exit 0
fi

if [ -f "$PLIST_PATH" ]; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
else
  NODE_PATH="$(command -v node || true)"
  [ -n "$NODE_PATH" ] || { printf 'Node.js를 찾지 못했습니다.\n' >&2; exit 1; }
  nohup "$NODE_PATH" "$SERVER_PATH" "$CONFIG_PATH" \
    >> "$INSTALL_DIR/helper.stdout.log" 2>> "$INSTALL_DIR/helper.stderr.log" &
fi

attempt=0
until curl -fsS "http://127.0.0.1:$PORT/hello" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 20 ] || {
    printf 'Media Helper가 시작되지 않았습니다. helper.stderr.log를 확인하세요.\n' >&2
    exit 1
  }
  sleep 0.25
done

printf 'Media Helper 실행 완료\n'
