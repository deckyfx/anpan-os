#!/usr/bin/env bash
# anpan-os local installer
#
# Builds the binary from the current working tree and installs it over the
# system service — the same layout install.sh produces, but from local source
# instead of a GitHub release. Use this to test changes in a real production
# run (root, systemd, real Docker socket) rather than `bun run dev`.
#
# Usage:
#   ./install-local.sh                 # build host arch, install, restart, follow logs
#   ./install-local.sh --skip-build    # reinstall the binary already in ./binaries
#   ./install-local.sh --no-typecheck  # skip `tsc --noEmit` (faster iteration)
#   ./install-local.sh --no-follow     # do not tail journalctl at the end
#
# Run as your normal user — it calls sudo only for the privileged steps.
# Running the whole script under sudo is rejected because the build needs your
# user's bun installation and would leave root-owned files in the repo.

set -euo pipefail

INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/var/lib/anpan-os"
SERVICE_FILE="/etc/systemd/system/anpan-os.service"
SERVICE="anpan-os"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Helpers ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

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

command -v sudo       >/dev/null || die "sudo not found."
command -v systemctl  >/dev/null || die "systemctl not found — this script targets systemd hosts."

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  BUILD_TARGET="bun-linux-x64";   BINARY="anpan-os-linux-x64"   ;;
  aarch64) BUILD_TARGET="bun-linux-arm64"; BINARY="anpan-os-linux-arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

BINARY_PATH="${REPO_DIR}/binaries/${BINARY}"
VERSION="$(grep -m1 '"version"' "${REPO_DIR}/package.json" | cut -d'"' -f4)"

info "Repo    : ${REPO_DIR}"
info "Version : ${VERSION:-unknown}"
info "Target  : ${BUILD_TARGET}"

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
if systemctl is-active --quiet "$SERVICE" 2>/dev/null; then
  info "Stopping ${SERVICE}..."
  sudo systemctl stop "$SERVICE"
fi

sudo install -m 755 "$BINARY_PATH" "${INSTALL_DIR}/anpan-os"
success "Binary installed at ${INSTALL_DIR}/anpan-os"

# ── Config directory (created once, never overwritten) ────────────────────────

if sudo test -f "${CONFIG_DIR}/config.toml"; then
  info "Config ${CONFIG_DIR}/config.toml exists — leaving it untouched."
else
  sudo mkdir -p "${CONFIG_DIR}/certs"
  sudo tee "${CONFIG_DIR}/config.toml" >/dev/null <<'EOF'
# anpan-os configuration
# Edit this file to change server settings.

[server]
port = 5000
bind = "public"   # "local" = 127.0.0.1 only | "public" = 0.0.0.0 (all interfaces)
# tls_cert = "/var/lib/anpan-os/certs/cert.pem"
# tls_key  = "/var/lib/anpan-os/certs/key.pem"

[auth]
passkey_allowed_origins = []
# session_same_site = "strict"   # "lax" for multi-hostname LAN access (default: strict)
# disable_login_method = ["form"]   # e.g. ["form"], ["passkey"], or ["form","passkey"]; "form" disables password login/setup, "passkey" disables passkey auth/registration

[compose]

[files]
root = "/"

[samba]
EOF
  success "Config created at ${CONFIG_DIR}/config.toml"
fi

# ── Systemd service ───────────────────────────────────────────────────────────

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

sudo systemctl daemon-reload
sudo systemctl enable --now "$SERVICE"
sudo systemctl restart "$SERVICE"

# Give it a moment to either come up or crash, then report honestly.
sleep 2
if systemctl is-active --quiet "$SERVICE"; then
  success "${SERVICE} is running."
else
  warn "${SERVICE} is NOT active. Recent logs:"
  sudo journalctl -u "$SERVICE" -n 40 --no-pager || true
  die "Service failed to start."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

PORT="$(sudo grep -m1 '^port' "${CONFIG_DIR}/config.toml" | tr -dc '0-9' || true)"
PORT="${PORT:-5000}"
IP="$(hostname -I | awk '{print $1}')"

echo ""
echo -e "${GREEN}✅ anpan-os ${VERSION} (local build) installed and running!${NC}"
echo ""
echo -e "   Config : ${CYAN}${CONFIG_DIR}/config.toml${NC}"
echo -e "   Service: ${CYAN}systemctl status ${SERVICE}${NC}"
echo -e "   Logs   : ${CYAN}journalctl -u ${SERVICE} -f${NC}"
echo ""
echo -e "   Open ${CYAN}http://${IP}:${PORT}${NC} in your browser."
echo ""

if [ "$FOLLOW" -eq 1 ]; then
  info "Following logs (Ctrl-C to detach — the service keeps running)..."
  sudo journalctl -u "$SERVICE" -n 30 -f --no-pager
fi
