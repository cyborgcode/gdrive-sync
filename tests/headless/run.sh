#!/bin/bash
# Runs an isolated headless GNOME Shell with the extension and a scenario driver.
# usage: run.sh OUTPUT_DIR SCENARIO [STATUS_DIR_TO_LINK]
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(mkdir -p "$1" && cd "$1" && pwd)
SCENARIO=$2
LINK=${3:-}
RT=$(mktemp -d /run/user/"$(id -u)"/gds.XXXX)
trap 'rm -rf "${RT:?}"' EXIT
mkdir -p "$OUT"/{config,cache,state,data/gnome-shell/extensions}
rm -rf "${OUT:?}/data/gnome-shell/extensions/gdrive-sync@local"
cp -r "$HERE/../../src/extension" "$OUT/data/gnome-shell/extensions/gdrive-sync@local"
cp -r "$HERE/test-helper@local" "$OUT/data/gnome-shell/extensions/"
if [ -n "$LINK" ]; then ln -s "$LINK" "$RT/gdrive-sync"; fi

env -i HOME="$HOME" USER="$USER" LOGNAME="$USER" PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
  XDG_CONFIG_HOME="$OUT/config" XDG_DATA_HOME="$OUT/data" XDG_CACHE_HOME="$OUT/cache" \
  XDG_STATE_HOME="$OUT/state" XDG_RUNTIME_DIR="$RT" \
  SHOTS="${SHOTS:-}" EVERY="${EVERY:-}" CLICK_SYNC="${CLICK_SYNC:-}" PREFIX="${PREFIX:-}" NO_TOGGLE="${NO_TOGGLE:-}" \
  dbus-run-session -- bash -c '
    dconf write /org/gnome/shell/enabled-extensions "[\"gdrive-sync@local\", \"test-helper@local\"]"
    dconf write /org/gnome/shell/disabled-extensions "[\"ubuntu-dock@ubuntu.com\", \"ding@rastersoft.com\", \"tiling-assistant@ubuntu.com\", \"snapd-prompting@canonical.com\", \"snapd-search-provider@canonical.com\", \"web-search-provider@ubuntu.com\", \"ubuntu-appindicators@ubuntu.com\"]"
    dconf write /org/gnome/shell/welcome-dialog-last-shown-version "\"999\""
    dconf write /org/gnome/desktop/interface/color-scheme "\"prefer-dark\""
    dconf write /org/gnome/desktop/interface/accent-color "\"orange\""
    dconf write /org/gnome/desktop/interface/icon-theme "\"Yaru-dark\""
    gnome-shell --headless --wayland --no-x11 --virtual-monitor 1280x900 --mode=ubuntu > "$0/shell.log" 2>&1 &
    SHELL_PID=$!
    python3 "$1" "$0" "$2" "$XDG_RUNTIME_DIR"
    kill "$SHELL_PID"; wait "$SHELL_PID" 2>/dev/null || true
  ' "$OUT" "$HERE/driver.py" "$SCENARIO"
grep -E "JS ERROR|JS WARNING|gdrive-sync" "$OUT/shell.log" || echo "no extension errors in shell log"
