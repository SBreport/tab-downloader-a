#!/bin/sh
set -eu

LABEL="com.tabdownloadera.media-helper"
INSTALL_DIR="$HOME/Library/Application Support/TabDownloaderAMediaHelper"
PLIST_PATH="$HOME/Library/LaunchAgents/$LABEL.plist"
SERVER_PATH="$INSTALL_DIR/server.cjs"
CONFIG_PATH="$INSTALL_DIR/helper-config.json"
PORT="17385"

fail() {
  printf '오류: %s\n' "$1" >&2
  exit 1
}

stop_helper_at_directory() {
  directory="$1"
  pid_path="$directory/helper.pid"
  [ -f "$pid_path" ] || return 0
  helper_pid="$(cat "$pid_path" 2>/dev/null || true)"
  case "$helper_pid" in (*[!0-9]*|'') return 0 ;; esac
  command_line="$(ps -p "$helper_pid" -o command= 2>/dev/null || true)"
  case "$command_line" in
    *"$directory/server.cjs"*) kill "$helper_pid" >/dev/null 2>&1 || true ;;
  esac
}

if [ "$(uname -s)" != "Darwin" ]; then
  fail "이 설치 스크립트는 macOS 전용입니다."
fi

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
  stop_helper_at_directory "$INSTALL_DIR"
  rm -f "$PLIST_PATH"
  rm -rf "$INSTALL_DIR"
  printf 'Media Helper를 제거했습니다.\n'
  exit 0
fi

EXTENSION_ID="${1:-}"
printf '%s' "$EXTENSION_ID" | grep -Eq '^[a-p]{32}$' || {
  fail "사용법: ./native-helper/install-macos.sh <확장프로그램-ID> 또는 --uninstall"
}

NODE_PATH="$(command -v node || true)"
YT_DLP_PATH="$(command -v yt-dlp || true)"
FFMPEG_PATH="${TAB_DOWNLOADER_A_FFMPEG:-$(command -v ffmpeg || true)}"
[ -n "$NODE_PATH" ] || fail "Node.js가 없습니다. Homebrew로 node를 설치하세요."
[ -n "$YT_DLP_PATH" ] || fail "yt-dlp가 없습니다. Homebrew로 yt-dlp를 설치하세요."
CONVERTER_PATH="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/image-converter.cjs"
FFMPEG_PATH="$("$NODE_PATH" -e '
  try { console.log(require(process.argv[1]).selectWebpFfmpeg(process.argv[2])); }
  catch (error) { console.error(error.message); process.exit(1); }
' "$CONVERTER_PATH" "$FFMPEG_PATH")"

launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true
stop_helper_at_directory "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$HOME/Library/LaunchAgents"
cp "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/server.cjs" "$SERVER_PATH"
cp "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/platform.cjs" "$INSTALL_DIR/platform.cjs"
cp "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/image-policy.cjs" "$INSTALL_DIR/image-policy.cjs"
cp "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/image-converter.cjs" "$INSTALL_DIR/image-converter.cjs"
cp "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/youtube-transcripts.cjs" "$INSTALL_DIR/youtube-transcripts.cjs"

"$NODE_PATH" -e '
  const fs = require("fs");
  const [configPath, extensionId, nodePath, ytDlpPath, ffmpegPath, port] = process.argv.slice(1);
  fs.writeFileSync(configPath, `${JSON.stringify({
    extensionId,
    port: Number(port),
    nodePath,
    ytDlpPath,
    ffmpegPath,
  }, null, 2)}\n`, "utf8");
' "$CONFIG_PATH" "$EXTENSION_ID" "$NODE_PATH" "$YT_DLP_PATH" "$FFMPEG_PATH" "$PORT"

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}

NODE_XML="$(xml_escape "$NODE_PATH")"
SERVER_XML="$(xml_escape "$SERVER_PATH")"
CONFIG_XML="$(xml_escape "$CONFIG_PATH")"
STDOUT_XML="$(xml_escape "$INSTALL_DIR/helper.stdout.log")"
STDERR_XML="$(xml_escape "$INSTALL_DIR/helper.stderr.log")"

cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_XML</string>
    <string>$SERVER_XML</string>
    <string>$CONFIG_XML</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$STDOUT_XML</string>
  <key>StandardErrorPath</key><string>$STDERR_XML</string>
</dict>
</plist>
EOF

chmod 600 "$CONFIG_PATH" "$PLIST_PATH"
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

attempt=0
until curl -fsS "http://127.0.0.1:$PORT/hello" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 20 ] || fail "Media Helper가 시작되지 않았습니다. $INSTALL_DIR/helper.stderr.log를 확인하세요."
  sleep 0.25
done

printf 'Media Helper 설치 완료: %s\n' "$INSTALL_DIR"
