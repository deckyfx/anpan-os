#!/usr/bin/env bash
# anpan-os local installer  —  Linux (systemd) and macOS (launchd)
#
# Builds the binary from the current working tree and installs it over the
# system service — the same layout install.sh produces, but from local source
# instead of a GitHub release. Use this to test changes in a real production
# run (root, the real service manager, the real Docker socket) rather than
# `bun run dev`.
#
# Usage:
#   ./install-local.sh                 # build host arch, install, restart, follow logs
#   ./install-local.sh --skip-build    # reinstall the binary already in ./binaries
#   ./install-local.sh --no-typecheck  # skip `tsc --noEmit` (faster iteration)
#   ./install-local.sh --no-follow     # do not tail the service logs at the end
#
# Run as your normal user — it calls sudo only for the privileged steps.
# Running the whole script under sudo is rejected because the build needs your
# user's bun installation and would leave root-owned files in the repo.

set -euo pipefail

INSTALL_DIR="/usr/local/bin"
SERVICE="anpan-os"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Helpers ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

# ── Port selection ────────────────────────────────────────────────────────────
#
# 5000 is not a safe default on macOS. AirPlay Receiver — part of Control Center, on by
# default on Apple Silicon — listens on 5000 and 7000, and its port cannot be configured.
# A fresh install that hardcoded 5000 therefore failed to bind, the service never came up,
# and the first thing a Mac user did reported failure for a reason nothing explained.
#
# Probing keeps 5000 as the default everywhere it is actually free, which is the normal
# case on Linux, and picks something usable where it is not — rather than silently failing
# or telling people to switch off a feature of their operating system.

DEFAULT_PORT=5000
# Tried in order. All are outside the range macOS assigns to AirPlay and AirDrop.
PORT_CANDIDATES="5000 5080 5001 8080 8000 9000"

# True when something is already listening on $1.
#
# Three tools because no single one is present everywhere: lsof ships with macOS, ss with
# modern Linux, netstat with almost everything older. If none of them can answer, the port
# is treated as free — a wrong guess there produces a clear bind error at startup, which is
# better than refusing to install over a question we could not resolve.
port_in_use() {
  local p="$1"
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1 && return 0
    return 1
  fi
  if command -v ss >/dev/null 2>&1; then
    ss -Htln "sport = :$p" 2>/dev/null | grep -q . && return 0
    return 1
  fi
  if command -v netstat >/dev/null 2>&1; then
    netstat -an 2>/dev/null | grep -qE "[.:]$p[[:space:]].*LISTEN" && return 0
    return 1
  fi
  return 1
}

# Names the process holding $1, for the message explaining why we moved.
port_holder() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$1" -sTCP:LISTEN -Fc 2>/dev/null | grep '^c' | head -n1 | cut -c2-
  fi
}

# Echoes the first free candidate. Empty when every one of them is taken.
choose_port() {
  local p
  for p in $PORT_CANDIDATES; do
    port_in_use "$p" || { echo "$p"; return 0; }
  done
  echo ""
}

# ── Flags ─────────────────────────────────────────────────────────────────────

SKIP_BUILD=0
TYPECHECK=1
FOLLOW=1

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build)   SKIP_BUILD=1 ;;
    --no-typecheck) TYPECHECK=0  ;;
    --no-follow)    FOLLOW=0     ;;
    -h|--help)      awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ── Preconditions ─────────────────────────────────────────────────────────────

if [ "$(id -u)" -eq 0 ]; then
  die "Do not run this script as root. Run it as your normal user — it will sudo where needed."
fi

command -v sudo >/dev/null || die "sudo not found."

# ── Platform ──────────────────────────────────────────────────────────────────

OS="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$ARCH_RAW" in
  x86_64|amd64)  ARCH="x64"   ;;
  # macOS says arm64 where Linux says aarch64.
  aarch64|arm64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH_RAW" ;;
esac

case "$OS" in
  Linux)
    PLATFORM="linux"
    CONFIG_DIR="/var/lib/anpan-os"
    SERVICE_FILE="/etc/systemd/system/${SERVICE}.service"
    command -v systemctl >/dev/null || die "systemctl not found — this script targets systemd hosts."
    ;;
  Darwin)
    PLATFORM="darwin"
    CONFIG_DIR="/usr/local/var/anpan-os"
    LAUNCHD_LABEL="io.anpan.anpan-os"
    SERVICE_FILE="/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist"
    command -v launchctl >/dev/null || die "launchctl not found."
    ;;
  *) die "Unsupported operating system: $OS" ;;
esac

BUILD_TARGET="bun-${PLATFORM}-${ARCH}"
BINARY="anpan-os-${PLATFORM}-${ARCH}"

# ── Service provider ──────────────────────────────────────────────────────────
#
# The same vocabulary as install.sh, over systemd or launchd.

svc_is_active() {
  if [ "$PLATFORM" = "linux" ]; then
    systemctl is-active --quiet "$SERVICE" 2>/dev/null
  else
    sudo launchctl print "system/${LAUNCHD_LABEL}" 2>/dev/null | grep -q "state = running"
  fi
}

svc_stop() {
  if [ "$PLATFORM" = "linux" ]; then
    sudo systemctl stop "$SERVICE"
  else
    sudo launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true
  fi
}

svc_restart() {
  if [ "$PLATFORM" = "linux" ]; then
    sudo systemctl daemon-reload
    sudo systemctl enable --now "$SERVICE"
    sudo systemctl restart "$SERVICE"
  else
    sudo launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true
    sudo launchctl bootstrap system "$SERVICE_FILE"
    sudo launchctl enable "system/${LAUNCHD_LABEL}" 2>/dev/null || true
    sudo launchctl kickstart -k "system/${LAUNCHD_LABEL}"
  fi
}

svc_logs() {
  if [ "$PLATFORM" = "linux" ]; then
    sudo journalctl -u "$SERVICE" -n "${1:-40}" --no-pager || true
  else
    sudo tail -n "${1:-40}" "${CONFIG_DIR}/anpan-os.log" "${CONFIG_DIR}/anpan-os.err" 2>/dev/null || true
  fi
}

svc_follow() {
  if [ "$PLATFORM" = "linux" ]; then
    sudo journalctl -u "$SERVICE" -n 30 -f --no-pager
  else
    sudo tail -n 30 -f "${CONFIG_DIR}/anpan-os.log" "${CONFIG_DIR}/anpan-os.err"
  fi
}

host_ip() {
  if [ "$PLATFORM" = "linux" ]; then
    hostname -I 2>/dev/null | awk '{print $1}'
  else
    for iface in $(route -n get default 2>/dev/null | awk '/interface:/{print $2}') en0 en1; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [ -n "$ip" ] && { echo "$ip"; return; }
    done
    echo "localhost"
  fi
}

BINARY_PATH="${REPO_DIR}/binaries/${BINARY}"
VERSION="$(grep -m1 '"version"' "${REPO_DIR}/package.json" | cut -d'"' -f4)"

info "Repo     : ${REPO_DIR}"
info "Version  : ${VERSION:-unknown}"
info "Platform : ${PLATFORM}/${ARCH}"
info "Target   : ${BUILD_TARGET}"

# Warn about a dev server holding the port — it would fight the service.
if pgrep -f "bun run src/index.ts" >/dev/null 2>&1 || pgrep -f "bun.*--hot.*src/index.ts" >/dev/null 2>&1; then
  warn "A local dev server (bun run dev) appears to be running."
  warn "Stop it first or it will keep the port bound and the service will fail to start."
fi

# ── Build ─────────────────────────────────────────────────────────────────────

if [ "$SKIP_BUILD" -eq 1 ]; then
  [ -f "$BINARY_PATH" ] || die "--skip-build given but ${BINARY_PATH} does not exist."
  info "Skipping build — reusing ${BINARY_PATH}"
else
  command -v bun >/dev/null || die "bun not found in PATH."

  if [ "$TYPECHECK" -eq 1 ]; then
    info "Type checking..."
    ( cd "$REPO_DIR" && bun run typecheck ) || die "Type check failed. Fix errors or rerun with --no-typecheck."
    success "Type check passed."
  else
    warn "Skipping type check (--no-typecheck)."
  fi

  info "Building ${BUILD_TARGET}..."
  ( cd "$REPO_DIR" && BUILD_TARGETS="$BUILD_TARGET" bun run build.ts ) || die "Build failed."
  [ -f "$BINARY_PATH" ] || die "Build reported success but ${BINARY_PATH} is missing."
fi

# ── Privileged steps ──────────────────────────────────────────────────────────

info "Requesting sudo for install steps..."
sudo -v || die "sudo authentication failed."

# Stop before replacing — overwriting a running executable gives "Text file busy".
if svc_is_active; then
  info "Stopping ${SERVICE}..."
  svc_stop
fi

sudo mkdir -p "$INSTALL_DIR"
sudo install -m 755 "$BINARY_PATH" "${INSTALL_DIR}/anpan-os"
# A locally built binary is not quarantined, but a previously downloaded one at this path
# may have been, and `install` preserves the destination's attributes in some cases.
[ "$PLATFORM" = "darwin" ] && sudo xattr -d com.apple.quarantine "${INSTALL_DIR}/anpan-os" 2>/dev/null || true
success "Binary installed at ${INSTALL_DIR}/anpan-os"

# ── Config directory (created once, never overwritten) ────────────────────────

if sudo test -f "${CONFIG_DIR}/config.toml"; then
  info "Config ${CONFIG_DIR}/config.toml exists — leaving it untouched."
else
  sudo mkdir -p "${CONFIG_DIR}/certs"

  CHOSEN_PORT="$(choose_port)"
  PORT_NOTE=""
  if [ -z "$CHOSEN_PORT" ]; then
    # Every candidate taken. Write the default and let the service report the bind error,
    # which names the port — more useful than an installer refusing to finish.
    CHOSEN_PORT="$DEFAULT_PORT"
    warn "Ports ${PORT_CANDIDATES} are all in use; defaulting to ${DEFAULT_PORT}."
    warn "Edit ${CONFIG_DIR}/config.toml before starting, or the service will fail to bind."
  elif [ "$CHOSEN_PORT" != "$DEFAULT_PORT" ]; then
    HOLDER="$(port_holder "$DEFAULT_PORT")"
    PORT_NOTE="# Port ${DEFAULT_PORT} was already in use${HOLDER:+ by ${HOLDER}} at install time, so ${CHOSEN_PORT} was chosen."
    warn "Port ${DEFAULT_PORT} is in use${HOLDER:+ by ${HOLDER}} — using ${CHOSEN_PORT} instead."
    if [ "$PLATFORM" = "darwin" ] && [ "$DEFAULT_PORT" = "5000" ]; then
      # Worth naming: this is the default configuration of the OS, not something the user
      # did, and it is not obvious that Control Center is a network service.
      warn "On macOS, ports 5000 and 7000 belong to AirPlay Receiver (System Settings →"
      warn "General → AirDrop & Handoff). Turn it off to free them, or keep ${CHOSEN_PORT}."
    fi
  fi

  {
    cat <<EOF
# anpan-os configuration
# Edit this file to change server settings.

[server]
${PORT_NOTE:+${PORT_NOTE}
}port = ${CHOSEN_PORT}
EOF
    cat <<'EOF'
bind = "public"   # "local" = 127.0.0.1 only | "public" = 0.0.0.0 (all interfaces)
# tls_cert = "certs/cert.pem"
# tls_key  = "certs/key.pem"

[auth]
passkey_allowed_origins = []
# session_same_site = "strict"   # "lax" for multi-hostname LAN access (default: strict)
# disable_login_method = ["form"]   # e.g. ["form"], ["passkey"], or ["form","passkey"]; "form" disables password login/setup, "passkey" disables passkey auth/registration

[compose]

[files]
root = "/"

[samba]
EOF
  } | sudo tee "${CONFIG_DIR}/config.toml" >/dev/null
  success "Config created at ${CONFIG_DIR}/config.toml (port ${CHOSEN_PORT})"
fi

# ── Systemd service ───────────────────────────────────────────────────────────

sudo mkdir -p "$(dirname "$SERVICE_FILE")"

if [ "$PLATFORM" = "linux" ]; then
  sudo tee "$SERVICE_FILE" >/dev/null <<EOF
[Unit]
Description=anpan-os Home Server OS
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${CONFIG_DIR}
ExecStart=${INSTALL_DIR}/anpan-os
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
else
  # KeepAlive stands in for Restart=on-failure. PATH is explicit because launchd gives a
  # daemon a minimal environment with neither Homebrew nor Docker Desktop on it.
  sudo tee "$SERVICE_FILE" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${INSTALL_DIR}/anpan-os</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${CONFIG_DIR}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
        <key>SuccessfulExit</key>
        <false/>
    </dict>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>${CONFIG_DIR}/anpan-os.log</string>
    <key>StandardErrorPath</key>
    <string>${CONFIG_DIR}/anpan-os.err</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF
  # launchd refuses a plist that is group- or world-writable.
  sudo chown root:wheel "$SERVICE_FILE"
  sudo chmod 644 "$SERVICE_FILE"
fi

svc_restart

# Give it a moment to either come up or crash, then report honestly.
sleep 2
if svc_is_active; then
  success "${SERVICE} is running."
else
  warn "${SERVICE} is NOT active. Recent logs:"
  svc_logs 40
  die "Service failed to start."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

PORT="$(sudo grep -m1 '^port' "${CONFIG_DIR}/config.toml" | tr -dc '0-9' || true)"
PORT="${PORT:-5000}"
IP="$(host_ip)"

echo ""
echo -e "${GREEN}✅ anpan-os ${VERSION} (local build) installed and running!${NC}"
echo ""
echo -e "   Config : ${CYAN}${CONFIG_DIR}/config.toml${NC}"
if [ "$PLATFORM" = "linux" ]; then
  echo -e "   Service: ${CYAN}systemctl status ${SERVICE}${NC}"
  echo -e "   Logs   : ${CYAN}journalctl -u ${SERVICE} -f${NC}"
else
  echo -e "   Service: ${CYAN}sudo launchctl print system/${LAUNCHD_LABEL}${NC}"
  echo -e "   Logs   : ${CYAN}tail -f ${CONFIG_DIR}/anpan-os.log${NC}"
fi
echo ""
echo -e "   Open ${CYAN}http://${IP}:${PORT}${NC} in your browser."
echo ""

if [ "$FOLLOW" -eq 1 ]; then
  info "Following logs (Ctrl-C to detach — the service keeps running)..."
  svc_follow
fi
