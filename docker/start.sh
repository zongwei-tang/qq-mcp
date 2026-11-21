#!/usr/bin/env bash
# Boot: persistent dirs on $DATA_DIR, OneBot config with a private token, Xvfb, then supervisord (qq, snowluma, qq-mcp).
set -euo pipefail

DATA_DIR="${DATA_DIR:-/data}"
export DISPLAY="${DISPLAY:-:1}"
export XDG_RUNTIME_DIR=/tmp/qq-runtime
export SNOWLUMA_HOOK_RUNTIME_DIR="$XDG_RUNTIME_DIR"
export SNOWLUMA_DATA="$DATA_DIR/snowluma"
DISPLAY_NUM="${DISPLAY#:}"; DISPLAY_NUM="${DISPLAY_NUM%%.*}"

if [ -z "${MCP_AUTH_TOKEN:-}" ]; then
  echo "MCP_AUTH_TOKEN is not set (need >= 24 random characters). Refusing to expose your QQ account." >&2
  exit 2
fi

mkdir -p "$DATA_DIR/qq-config" "$DATA_DIR/qq-share" "$SNOWLUMA_DATA/config" "$DATA_DIR/downloads" "$XDG_RUNTIME_DIR" /app/.cache /tmp/.X11-unix
# QQ keeps its login + databases under ~/.config/QQ and ~/.local/share; keep them on the volume
rm -rf /app/.config /app/.local/share; mkdir -p /app/.local
ln -sfn "$DATA_DIR/qq-config" /app/.config
ln -sfn "$DATA_DIR/qq-share" /app/.local/share

# OneBot access token shared by SnowLuma and the MCP server (generated once, kept on the volume)
TOKEN_FILE="$DATA_DIR/onebot-token"
[ -s "$TOKEN_FILE" ] || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n' > "$TOKEN_FILE"
export ONEBOT_ACCESS_TOKEN="$(cat "$TOKEN_FILE")"
export ONEBOT_WS_URL="ws://127.0.0.1:3001/"

node - <<'NODE'
const fs = require('fs'); const path = require('path');
const dir = path.join(process.env.SNOWLUMA_DATA, 'config');
const token = process.env.ONEBOT_ACCESS_TOKEN;
const ws = { name: 'ws-default', host: '127.0.0.1', port: 3001, path: '/', role: 'Universal', accessToken: token, messageFormat: 'array', reportSelfMessage: true };
const http = { name: 'http-default', host: '127.0.0.1', port: 3000, path: '/', enableWebSocket: false, enableSse: false, accessToken: token, messageFormat: 'array', reportSelfMessage: false };
const want = { networks: { httpServers: [http], httpClients: [], wsServers: [ws], wsClients: [] } };
// global config + every per-account config: force our local listeners/token, keep anything else the user changed
for (const f of ['onebot.json', ...fs.readdirSync(dir).filter((n) => /^onebot_\d+\.json$/.test(n))]) {
  const p = path.join(dir, f);
  let cur = {}; try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
  const next = { ...cur, networks: { ...(cur.networks || {}), httpServers: [http], wsServers: [ws] }, historySync: { enabled: true } };
  if (!cur.networks) Object.assign(next, want);
  fs.writeFileSync(p, JSON.stringify(next, null, 2));
}
const rt = path.join(dir, 'runtime.json');
let r = {}; try { r = JSON.parse(fs.readFileSync(rt, 'utf8')); } catch {}
r.webuiPort = Number(process.env.SNOWLUMA_WEBUI_PORT || 5099);
fs.writeFileSync(rt, JSON.stringify(r, null, 2));
NODE

chown -R qq:qq "$DATA_DIR" "$XDG_RUNTIME_DIR" 2>/dev/null || true; chown -h qq:qq /app/.config /app/.local /app/.local/share 2>/dev/null || true
chmod 700 "$XDG_RUNTIME_DIR"
chmod 1777 /tmp /tmp/.X11-unix || true
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}" /tmp/qq-launcher.pid
find "$XDG_RUNTIME_DIR" -maxdepth 1 -type s -name 'mojo.*.*.sock' -delete 2>/dev/null || true

mkdir -p /var/run/dbus && rm -f /run/dbus/pid
dbus-daemon --config-file=/usr/share/dbus-1/system.conf --fork || true
Xvfb "$DISPLAY" -screen 0 "${SNOWLUMA_SCREEN:-1280x800x24}" -nolisten tcp &
for _ in $(seq 1 100); do [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ] && break; sleep 0.1; done
su qq -s /bin/sh -c "DISPLAY=$DISPLAY fluxbox >/dev/null 2>&1 &"

export QQ_MCP_HOME="$DATA_DIR/qq-mcp" QQ_DOWNLOAD_DIR="$DATA_DIR/downloads"
exec supervisord -c /etc/supervisord.conf
