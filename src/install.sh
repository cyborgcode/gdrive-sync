#!/usr/bin/env bash
# Installs gdrive-sync: your starred Google Drive folders, on this computer, synced both ways.
set -euo pipefail

GDS_VERSION="1.1.0"
RCLONE_VERSION="1.75.1"
UUID="gdrive-sync@local"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REMOTE="gdrive"
SYNC_DIR="$HOME/GoogleDrive"
ACTION="install"
PURGE=0
ASSUME_YES=0

CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
STATE_HOME="${XDG_STATE_HOME:-$HOME/.local/state}"
BIN="$HOME/.local/bin/gdrive-sync"
APP_DIR="$DATA_HOME/gdrive-sync"
RCLONE="$APP_DIR/rclone"
UNIT_DIR="$CONFIG_HOME/systemd/user"
EXT_DIR="$DATA_HOME/gnome-shell/extensions/$UUID"
CONF_FILE="$CONFIG_HOME/gdrive-sync/config.ini"
BOOKMARKS="$CONFIG_HOME/gtk-3.0/bookmarks"
NEEDS_RELOGIN=0

if [ -t 1 ]; then BOLD=$'\033[1m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'; else BOLD=""; YELLOW=""; RED=""; RESET=""; fi
say() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
warn() { printf '%swarning:%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die() { printf '%serror:%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }
interactive() { [ -t 0 ] && [ "$ASSUME_YES" = 0 ]; }

usage() {
    cat <<EOF
gdrive-sync $GDS_VERSION: your starred Google Drive folders on this computer, synced both ways.

Usage: ${GDS_INSTALLER_NAME:-$(basename "$0")} [options]
  --dir DIR       where your starred folders are kept (default: ~/GoogleDrive)
  --remote NAME   rclone remote to use or create (default: gdrive)
  --yes           don't ask questions
  --uninstall     remove gdrive-sync (your files and Google sign-in are kept)
  --purge         with --uninstall, also remove settings and sync state
  -h, --help      show this help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) SYNC_DIR="${2:?--dir needs a folder}"; shift 2 ;;
        --remote) REMOTE="${2:?--remote needs a name}"; shift 2 ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --uninstall) ACTION="uninstall"; shift ;;
        --purge) PURGE=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "unknown option: $1 (see --help)" ;;
    esac
done

abspath() { python3 -c 'import os, sys; print(os.path.abspath(os.path.expanduser(sys.argv[1])))' "$1"; }

# Values end up inside systemd unit files and config files, so keep them free of quoting characters.
check_value() {
    case "$2" in
        *'"'*|*'\'*|*'$'*|*'%'*|*$'\n'*|"") die "$1 contains characters that aren't supported: $2" ;;
    esac
}

rclone_sha256() {
    case "$1" in
        amd64) echo "982b5aa772841168f8e380f139e9e787b2a105403e32b94da8676a0e1c0a13ab" ;;
        arm64) echo "03f2504174034b6d004152ed7369251c9a9ec1f7e0836eda420f5c7a5ec0dff9" ;;
        arm-v7) echo "33c683053b677d9a89d4a985e8a25cfed7c8a95dd8379e367a5c73d8745356c3" ;;
        386) echo "9250a48ace446b32ad3f3cb26e0744f9245efb65ef4f51dfb416288950b84285" ;;
    esac
}

preflight() {
    [ "$(id -u)" -ne 0 ] || die "run this as your normal user, without sudo"
    command -v python3 >/dev/null || die "python3 is required"
    python3 -c 'import sys; sys.exit(sys.version_info < (3, 8))' || die "Python 3.8 or newer is required"
    command -v systemctl >/dev/null || die "systemd is required"
    systemctl --user show-environment >/dev/null 2>&1 || die "no systemd user session: run this from your desktop session"
    case "$(uname -m)" in
        x86_64) ARCH="amd64" ;;
        aarch64|arm64) ARCH="arm64" ;;
        armv7*) ARCH="arm-v7" ;;
        i?86) ARCH="386" ;;
        *) die "unsupported processor: $(uname -m)" ;;
    esac
    if [ -r /etc/os-release ]; then
        local os_ids os_name
        os_ids=$(. /etc/os-release && echo " ${ID:-} ${ID_LIKE:-} ")
        os_name=$(. /etc/os-release && echo "${PRETTY_NAME:-unknown}")
        case "$os_ids" in
            *" ubuntu "*|*" debian "*) ;;
            *) warn "made for Ubuntu; trying anyway on $os_name" ;;
        esac
    fi
    [[ "$REMOTE" =~ ^[A-Za-z0-9_.-]+$ ]] || die "remote names may only use letters, digits, '.', '_' and '-'"
    SYNC_DIR=$(abspath "$SYNC_DIR")
    check_value "the folder" "$SYNC_DIR"
    check_value "your home folder" "$HOME"
    [ "$SYNC_DIR" != "$HOME" ] || die "the folder can't be your whole home folder"
    if mountpoint -q "$SYNC_DIR" 2>/dev/null; then
        die "something is mounted on $SYNC_DIR; unmount it first, or choose another folder with --dir"
    fi
    SHELL_MAJOR=""
    if command -v gnome-shell >/dev/null; then
        SHELL_MAJOR=$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -n 1 || true)
    fi
}

install_rclone() {
    if [ -x "$RCLONE" ] && [ "$("$RCLONE" version 2>/dev/null | head -n 1)" = "rclone v$RCLONE_VERSION" ]; then
        say "rclone v$RCLONE_VERSION is already installed"
        return
    fi
    say "Downloading rclone v$RCLONE_VERSION for $ARCH (checksum-verified)…"
    mkdir -p "$APP_DIR"
    python3 - "$RCLONE_VERSION" "$ARCH" "$(rclone_sha256 "$ARCH")" "$RCLONE" <<'PY' || die "could not download rclone; check your internet connection and try again"
import hashlib, io, os, sys, urllib.request, zipfile
version, arch, expected, dest = sys.argv[1:5]
url = "https://downloads.rclone.org/v%s/rclone-v%s-linux-%s.zip" % (version, version, arch)
request = urllib.request.Request(url, headers={"User-Agent": "gdrive-sync-installer"})
data = urllib.request.urlopen(request, timeout=300).read()
if hashlib.sha256(data).hexdigest() != expected:
    sys.exit("checksum mismatch for " + url)
with zipfile.ZipFile(io.BytesIO(data)) as archive:
    binary = archive.read(next(n for n in archive.namelist() if n.endswith("/rclone")))
with open(dest + ".tmp", "wb") as f:
    f.write(binary)
os.chmod(dest + ".tmp", 0o755)
os.replace(dest + ".tmp", dest)
PY
}

client_id_help() {
    cat <<'EOF'

Google is retiring rclone's shared sign-in ("client ID"). Your own one is free and takes ~5 minutes:
  1. Open https://console.cloud.google.com/ and create a project.
  2. APIs & Services > Library: enable "Google Drive API".
  3. Google Auth Platform (OAuth consent screen): choose External, add yourself as a test user,
     then press "Publish app" (otherwise the sign-in expires every 7 days).
  4. Clients > Create client > type "Desktop app", then copy the client ID and secret.

EOF
}

ask_client() {
    CLIENT_ID=""
    CLIENT_SECRET=""
    client_id_help
    read -r -p "$1" CLIENT_ID
    if [ -n "$CLIENT_ID" ]; then
        read -r -s -p "Client secret: " CLIENT_SECRET
        echo
        [ -n "$CLIENT_SECRET" ] || die "a client secret is needed together with the client ID"
    fi
}

configure_remote() {
    local conf backup
    conf=$("$RCLONE" config file 2>/dev/null | tail -n 1)
    if "$RCLONE" listremotes 2>/dev/null | grep -qxF "$REMOTE:"; then
        [ "$("$RCLONE" config show "$REMOTE" 2>/dev/null | sed -n 's/^type = //p')" = "drive" ] \
            || die "the rclone remote '$REMOTE' isn't Google Drive; choose another name with --remote"
        if "$RCLONE" config show "$REMOTE" 2>/dev/null | grep -qE '^client_id = .+'; then
            say "Using your Google Drive connection '$REMOTE' (with your own client ID)"
            return
        fi
        warn "'$REMOTE' signs in with rclone's shared client ID, which Google is retiring during 2026"
        if ! interactive; then
            warn "keeping it for now; run this installer again in a terminal to add your own client ID"
            return
        fi
        ask_client "Paste your client ID (or press Enter to keep the shared one for now): "
        if [ -z "$CLIENT_ID" ]; then
            warn "keeping the shared client ID for now"
            return
        fi
        backup="$conf.gdrive-sync-backup"
        cp -p "$conf" "$backup"
        say "Your browser will open: sign in to Google and allow access."
        if "$RCLONE" config update "$REMOTE" client_id "$CLIENT_ID" client_secret "$CLIENT_SECRET" \
                --non-interactive >/dev/null && "$RCLONE" config reconnect "$REMOTE:" --auto-confirm; then
            rm -f "$backup"
            say "Signed in with your own client ID"
        else
            cp -p "$backup" "$conf"
            rm -f "$backup"
            die "signing in failed, so your previous Google Drive connection was restored"
        fi
    else
        interactive || die "there's no rclone remote '$REMOTE' yet: run this installer in a terminal to sign in"
        say "Connecting to Google Drive"
        ask_client "Paste your client ID (recommended; press Enter to use the shared one for now): "
        local args=("scope=drive")
        if [ -n "$CLIENT_ID" ]; then
            args+=("client_id=$CLIENT_ID" "client_secret=$CLIENT_SECRET")
        else
            warn "using rclone's shared client ID for now; run this installer again later to switch"
        fi
        say "Your browser will open: sign in to Google and allow access."
        "$RCLONE" config create "$REMOTE" drive "${args[@]}" --auto-confirm >/dev/null \
            || die "could not connect to Google Drive"
    fi
}

verify_remote() {
    say "Checking the connection to Google Drive…"
    "$RCLONE" lsf --max-depth 1 --dirs-only "$REMOTE:" >/dev/null 2>&1 \
        || die "can't reach Google Drive with '$REMOTE'; check your internet connection, or run: $RCLONE config reconnect $REMOTE:"
}

write_config() {
    local interval=5
    if [ -f "$CONF_FILE" ]; then
        interval=$(sed -n 's/^interval_minutes *= *//p' "$CONF_FILE" | head -n 1)
        [[ "$interval" =~ ^[0-9]+$ ]] || interval=5
    fi
    mkdir -p "$(dirname "$CONF_FILE")"
    cat > "$CONF_FILE" <<EOF
[gdrive-sync]
remote = $REMOTE
folder = $SYNC_DIR
rclone = $RCLONE
interval_minutes = $interval
EOF
}

install_files() {
    say "Installing the sync service"
    install -D -m 755 "$HERE/gdrive-sync" "$BIN"
    mkdir -p "$UNIT_DIR"
    python3 - "$HERE/systemd/gdrive-sync.service.in" "$UNIT_DIR/gdrive-sync.service" "$BIN" <<'PY'
import sys
source, dest, binary = sys.argv[1:4]
text = open(source, encoding="utf-8").read().replace("@BIN@", binary)
open(dest, "w", encoding="utf-8").write(text)
PY
}

set_extension_enabled() {
    local current updated
    current=$(gsettings get org.gnome.shell enabled-extensions 2>/dev/null) || return 0
    updated=$(python3 - "$current" "$UUID" "$1" <<'PY'
import ast, sys
current, uuid, enable = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
items = ast.literal_eval(current.replace("@as ", "", 1))
items = [i for i in items if i != uuid] + ([uuid] if enable else [])
print(repr(items))
PY
)
    gsettings set org.gnome.shell enabled-extensions "$updated"
}

install_extension() {
    if [ -z "$SHELL_MAJOR" ]; then
        warn "GNOME Shell not found, so there's no panel indicator; use 'gdrive-sync status' instead"
        return
    fi
    if [ "$SHELL_MAJOR" -lt 45 ]; then
        warn "the panel indicator needs GNOME 45+ (Ubuntu 24.04 or newer); use 'gdrive-sync status' instead"
        return
    fi
    say "Installing the panel indicator"
    rm -rf "${EXT_DIR:?}"
    mkdir -p "$EXT_DIR"
    cp -r "$HERE/extension/." "$EXT_DIR/"
    set_extension_enabled 1
    if [ "$(gsettings get org.gnome.shell disable-user-extensions 2>/dev/null)" = "true" ]; then
        warn "user extensions are turned off; enable them in the Extensions app to see the indicator"
    fi
    NEEDS_RELOGIN=1
}

edit_bookmark() {
    python3 - "$BOOKMARKS" "$1" "$2" "$3" <<'PY'
import os, pathlib, sys
path, folder, label, add = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
uri = pathlib.Path(folder).as_uri()
lines = open(path, encoding="utf-8").read().splitlines() if os.path.exists(path) else []
kept = [l for l in lines if l.split(" ", 1)[0] != uri]
if add:
    kept.append("%s %s" % (uri, label))
if kept != lines:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    open(path, "w", encoding="utf-8").write("".join(l + "\n" for l in kept))
PY
}

wait_until() {
    local seconds=$1
    shift
    while [ "$seconds" -gt 0 ]; do
        "$@" && return 0
        sleep 1
        seconds=$((seconds - 1))
    done
    return 1
}

start_service() {
    say "Starting the sync service"
    systemctl --user daemon-reload
    systemctl --user enable gdrive-sync.service >/dev/null 2>&1
    systemctl --user restart gdrive-sync.service || die "the sync service didn't start; see: journalctl --user -u gdrive-sync"
    wait_until 15 systemctl --user is-active --quiet gdrive-sync.service \
        || die "the sync service didn't start; see: journalctl --user -u gdrive-sync"
}

install_all() {
    preflight
    install_rclone
    configure_remote
    verify_remote
    mkdir -p "$SYNC_DIR"
    write_config
    install_files
    install_extension
    edit_bookmark "$SYNC_DIR" "Google Drive" 1
    start_service

    cat <<EOF

${BOLD}gdrive-sync $GDS_VERSION is installed.${RESET}
  * Star one of your own folders in Google Drive (web or phone): within 5 minutes it appears in
      $SYNC_DIR
    and stays there, fully usable without internet, syncing both ways automatically.
  * Folders that others shared with you are never synced, even if starred.
  * Unstarring a folder syncs it one last time, then moves it from this computer to the Trash.
  * In a terminal: gdrive-sync status | gdrive-sync now
  * To uninstall: run this installer with --uninstall
EOF
    if [ "$NEEDS_RELOGIN" = 1 ]; then
        echo "  * ${BOLD}Log out and back in once${RESET} to see the cloud icon (live progress and Sync now) in the top bar."
    fi
}

uninstall_all() {
    local sync_dir=""
    [ -f "$CONF_FILE" ] && sync_dir=$(sed -n 's/^folder *= *//p' "$CONF_FILE" | head -n 1)
    say "Removing gdrive-sync"
    systemctl --user disable --now gdrive-sync.service >/dev/null 2>&1 || true
    rm -f "$UNIT_DIR/gdrive-sync.service"
    systemctl --user daemon-reload || true
    if command -v gsettings >/dev/null; then set_extension_enabled 0 || true; fi
    rm -rf "${EXT_DIR:?}"
    rm -f "$BIN"
    rm -rf "${APP_DIR:?}"
    rm -rf "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/gdrive-sync"
    [ -n "$sync_dir" ] && edit_bookmark "$sync_dir" "" 0
    if [ "$PURGE" = 1 ]; then
        rm -rf "${STATE_HOME:?}/gdrive-sync" "${CONFIG_HOME:?}/gdrive-sync"
        say "Removed settings and sync state"
    fi
    say "gdrive-sync was removed."
    [ -n "$sync_dir" ] && echo "    Your files are still in $sync_dir"
    echo "    Your Google Drive sign-in (rclone remote) was kept."
}

if [ "$ACTION" = "uninstall" ]; then
    uninstall_all
else
    install_all
fi
