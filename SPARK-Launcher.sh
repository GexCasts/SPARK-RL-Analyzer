#!/usr/bin/env bash
set -euo pipefail

ROOT="$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="$ROOT/tools"
TMP_DIR="$ROOT/.tmp"
APP_URL="http://127.0.0.1:8765/"
NODE_VERSION="v22.11.0"
NODE_FOLDER="node-$NODE_VERSION-linux-x64"
NODE_TARBALL="$TOOLS_DIR/node/$NODE_FOLDER.tar.xz"
NODE_EXE="$TOOLS_DIR/node/$NODE_FOLDER/bin/node"
RRROCKET_VERSION="0.11.3"
RRROCKET_FOLDER="rrrocket-$RRROCKET_VERSION-x86_64-unknown-linux-musl"
RRROCKET_TARBALL="$TOOLS_DIR/rrrocket/$RRROCKET_FOLDER.tar.gz"
RRROCKET_EXE="$TOOLS_DIR/rrrocket/$RRROCKET_FOLDER/rrrocket"

status(){
  printf '[SPARK] %s\n' "$1"
}

download(){
  local url="$1"
  local out="$2"
  mkdir -p "$(dirname "$out")"
  if command -v curl >/dev/null 2>&1; then
    curl -L --fail --show-error --output "$out" "$url"
  elif command -v wget >/dev/null 2>&1; then
    wget -O "$out" "$url"
  else
    status "Install curl or wget so SPARK can download runtime dependencies."
    exit 1
  fi
}

server_ready(){
  if command -v curl >/dev/null 2>&1; then
    curl -fsS "$APP_URL" >/dev/null 2>&1
  elif command -v wget >/dev/null 2>&1; then
    wget -q --spider "$APP_URL" >/dev/null 2>&1
  else
    return 1
  fi
}

open_browser(){
  if command -v xdg-open >/dev/null 2>&1; then
    xdg-open "$APP_URL" >/dev/null 2>&1 &
  elif command -v gio >/dev/null 2>&1; then
    gio open "$APP_URL" >/dev/null 2>&1 &
  else
    status "Open this URL in your browser: $APP_URL"
  fi
}

resolve_node(){
  if command -v node >/dev/null 2>&1; then
    command -v node
    return
  fi

  if [ ! -x "$NODE_EXE" ]; then
    status "Node.js was not found. Installing portable Node.js into tools/node..."
    rm -rf "$TOOLS_DIR/node/$NODE_FOLDER"
    download "https://nodejs.org/dist/$NODE_VERSION/$NODE_FOLDER.tar.xz" "$NODE_TARBALL"
    tar -xJf "$NODE_TARBALL" -C "$TOOLS_DIR/node"
    rm -f "$NODE_TARBALL"
  fi

  printf '%s\n' "$NODE_EXE"
}

ensure_rrrocket(){
  if [ -x "$RRROCKET_EXE" ]; then
    return
  fi

  status "rrrocket parser was not found. Installing Linux parser into tools/rrrocket..."
  rm -rf "$TOOLS_DIR/rrrocket/$RRROCKET_FOLDER"
  download "https://github.com/nickbabcock/rrrocket/releases/download/v$RRROCKET_VERSION/$RRROCKET_FOLDER.tar.gz" "$RRROCKET_TARBALL"
  tar -xzf "$RRROCKET_TARBALL" -C "$TOOLS_DIR/rrrocket"
  rm -f "$RRROCKET_TARBALL"
  chmod +x "$RRROCKET_EXE"
}

version_gt(){
  local left="${1#v}"
  local right="${2#v}"
  local IFS=.
  local -a left_parts right_parts
  read -ra left_parts <<< "$left"
  read -ra right_parts <<< "$right"
  local length="${#left_parts[@]}"
  if [ "${#right_parts[@]}" -gt "$length" ]; then length="${#right_parts[@]}"; fi
  for ((i=0; i<length; i++)); do
    local l="${left_parts[$i]:-0}"
    local r="${right_parts[$i]:-0}"
    if ((10#$l > 10#$r)); then return 0; fi
    if ((10#$l < 10#$r)); then return 1; fi
  done
  return 1
}

check_rrrocket_version_warning(){
  local latest=""
  if command -v curl >/dev/null 2>&1; then
    latest="$(curl -fsS -H 'User-Agent: SPARK Launcher' https://api.github.com/repos/nickbabcock/rrrocket/releases/latest 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1 || true)"
  elif command -v wget >/dev/null 2>&1; then
    latest="$(wget -qO- --header='User-Agent: SPARK Launcher' https://api.github.com/repos/nickbabcock/rrrocket/releases/latest 2>/dev/null | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1 || true)"
  fi

  if [ -z "$latest" ]; then
    status "Could not check latest rrrocket parser version."
    return
  fi

  if version_gt "$latest" "$RRROCKET_VERSION"; then
    status "SPARK currently includes rrrocket $RRROCKET_VERSION, but rrrocket $latest is available. SPARK will not install that parser until it is included in SPARK's GitHub release. New Rocket League replays may not process correctly until SPARK is updated."
  else
    status "rrrocket parser is current for SPARK ($RRROCKET_VERSION)."
  fi
}

mkdir -p "$TOOLS_DIR/node" "$TOOLS_DIR/rrrocket" "$TMP_DIR"
check_rrrocket_version_warning
ensure_rrrocket
NODE_EXE_RESOLVED="$(resolve_node)"

if server_ready; then
  status "Local server is already running."
else
  status "Starting local server on 127.0.0.1:8765..."
  SPARK_RRROCKET_PATH="$RRROCKET_EXE" nohup "$NODE_EXE_RESOLVED" "$ROOT/static-download-server.mjs" >"$TMP_DIR/server.log" 2>&1 &

  for _ in $(seq 1 40); do
    if server_ready; then
      break
    fi
    sleep 0.25
  done

  if ! server_ready; then
    status "The local server did not respond. Last server log lines:"
    tail -n 20 "$TMP_DIR/server.log" || true
    exit 1
  fi
fi

status "Opening SPARK..."
open_browser
status "Ready. The local server shuts itself down after all SPARK tabs and overlay sources are closed."
