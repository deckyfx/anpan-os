#!/usr/bin/env bash
# anpan-os installer / updater
#
# Usage: curl -fsSL https://raw.githubusercontent.com/deckyfx/anpan-os/main/install.sh | sudo bash
#
# Re-running this is cheap and safe. The remote checksum is fetched before the binary, so
# an already-current install downloads nothing, replaces nothing, and never restarts the
# service. Only a genuinely different binary — or a changed unit file — causes downtime.
#
# Options (append after `bash -s --`, e.g. `... | sudo bash -s -- --yes`):
#   -y, --yes     Never prompt; assume yes. Implied when there is no terminal to ask on.
#   -f, --force   Reinstall even when the installed binary is already identical.
#   -h, --help    Show this help.

set -euo pipefail

REPO="deckyfx/anpan-os"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/var/lib/anpan-os"
SERVICE_FILE="/etc/systemd/system/anpan-os.service"

# ── Helpers ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

ASSUME_YES="${ASSUME_YES:-0}"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)   ASSUME_YES=1 ;;
    -f|--force) FORCE=1 ;;
    -h|--help)  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

# This script is normally piped into bash, so stdin is the script itself — never a user.
# Prompts therefore have to come from the controlling terminal, and when there is none
# (CI, cloud-init, a self-update call) we proceed without asking.
confirm() {
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ -r /dev/tty ] || return 0
  local reply
  printf "%b" "${CYAN}[ ?  ]${NC}  $1 [Y/n] " > /dev/tty
  read -r reply < /dev/tty || return 0
  case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
}

# ── Root check ────────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ] || die "This script must be run as root (use sudo)."

# ── Architecture detection ────────────────────────────────────────────────────

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  BINARY="anpan-os-linux-x64"   ;;
  aarch64) BINARY="anpan-os-linux-arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

# ── Installed version ─────────────────────────────────────────────────────────

INSTALLED_BIN="${INSTALL_DIR}/anpan-os"
CURRENT_VERSION=""
if [ -x "$INSTALLED_BIN" ]; then
  # `anpan-os --version` prints "anpan-os vX.Y.Z". Tolerate a binary too old or too broken
  # to answer — an unreadable version is not a reason to refuse to install over it.
  CURRENT_VERSION="$("$INSTALLED_BIN" --version 2>/dev/null | awk '{print $2}' || true)"
  info "Installed version: ${CURRENT_VERSION:-unknown}"
else
  info "No existing installation found."
fi

# ── Fetch latest release ──────────────────────────────────────────────────────

info "Fetching latest release from GitHub..."
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")" \
  || die "Could not reach the GitHub release API."

if command -v jq >/dev/null 2>&1; then
  LATEST="$(printf '%s' "$RELEASE_JSON" | jq -r '.tag_name // empty')"
  NOTES="$(printf '%s' "$RELEASE_JSON"  | jq -r '.body // empty')"
else
  LATEST="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | cut -d'"' -f4)"
  NOTES=""   # parsing Markdown out of JSON without jq is not worth the fragility
fi
[ -n "$LATEST" ] || die "Could not determine latest release."
info "Latest version: $LATEST"

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"

# ── Decide whether anything needs to change ───────────────────────────────────
#
# The checksum file is ~85 bytes against a ~95 MB binary, so fetching it first turns
# "am I current?" into a near-free question. Comparing hashes rather than version strings
# also covers dev builds and hand-copied binaries, whose version tells you nothing.

EXPECTED_HASH=""
if TMP_SHA="$(mktemp)" && curl -fsSL "${DOWNLOAD_URL}.sha256" -o "$TMP_SHA" 2>/dev/null; then
  EXPECTED_HASH="$(awk '{print $1}' "$TMP_SHA")"
fi
rm -f "${TMP_SHA:-}"

BINARY_UP_TO_DATE=0
if [ -n "$EXPECTED_HASH" ] && [ -f "$INSTALLED_BIN" ]; then
  if [ "$(sha256sum "$INSTALLED_BIN" | awk '{print $1}')" = "$EXPECTED_HASH" ]; then
    BINARY_UP_TO_DATE=1
  fi
elif [ -z "$EXPECTED_HASH" ] && [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$LATEST" ]; then
  # Older releases predate the .sha256 assets; fall back to the version string.
  BINARY_UP_TO_DATE=1
fi

if [ "$BINARY_UP_TO_DATE" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
  success "Already running ${LATEST} — binary is identical, nothing to download."
  # Still make sure the unit exists and the service is up; a current binary that is not
  # running is exactly the state someone re-runs this script to fix.
  NEED_DOWNLOAD=0
else
  NEED_DOWNLOAD=1
fi

# ── Changelog + confirmation ──────────────────────────────────────────────────

if [ "$NEED_DOWNLOAD" -eq 1 ]; then
  if [ -n "$NOTES" ]; then
    echo ""
    echo -e "${CYAN}What's new in ${LATEST}:${NC}"
    # Cap it: release notes run to dozens of lines and this is the middle of an install.
    # printf rather than sed: the colour vars hold "\033[..." as text, which sed would
    # insert literally instead of as an escape sequence. printf expands it in the format.
    printf '%s\n' "$NOTES" | sed 's/\r$//' | head -n 30 | while IFS= read -r line; do
      printf "${DIM}   %s${NC}\n" "$line"
    done
    if [ "$(printf '%s\n' "$NOTES" | wc -l)" -gt 30 ]; then
      echo -e "${DIM}   …${NC}"
      echo -e "${DIM}   Full notes: https://github.com/${REPO}/releases/tag/${LATEST}${NC}"
    fi
    echo ""
  elif ! command -v jq >/dev/null 2>&1; then
    echo -e "${DIM}   Release notes: https://github.com/${REPO}/releases/tag/${LATEST}  (install jq to show them here)${NC}"
  fi

  if [ -n "$CURRENT_VERSION" ]; then
    PROMPT="Update anpan-os ${CURRENT_VERSION} → ${LATEST}?"
    [ "$FORCE" -eq 1 ] && [ "$BINARY_UP_TO_DATE" -eq 1 ] && PROMPT="Reinstall anpan-os ${LATEST} (identical binary)?"
    confirm "$PROMPT" || { info "Aborted — nothing changed."; exit 0; }
  fi
fi

# ── Download + install ────────────────────────────────────────────────────────

BINARY_CHANGED=0
if [ "$NEED_DOWNLOAD" -eq 1 ]; then
  info "Downloading $BINARY ($LATEST)..."
  TMP="$(mktemp)"
  # --progress-bar shows a visual bar; -f fails on HTTP errors; -L follows redirects
  curl -fL --progress-bar "$DOWNLOAD_URL" -o "$TMP" || die "Download failed: $DOWNLOAD_URL"

  if [ -n "$EXPECTED_HASH" ]; then
    info "Verifying SHA256 checksum..."
    ACTUAL_HASH="$(sha256sum "$TMP" | awk '{print $1}')"
    [ "$EXPECTED_HASH" = "$ACTUAL_HASH" ] \
      || { rm -f "$TMP"; die "SHA256 mismatch — download may be corrupted. Aborting."; }
    success "Checksum verified."
  else
    warn "No published checksum for ${LATEST} — skipping verification."
  fi

  # Stop the service before replacing the binary — overwriting a running
  # executable causes "Text file busy" on Linux.
  if systemctl is-active --quiet anpan-os 2>/dev/null; then
    info "Stopping anpan-os service..."
    systemctl stop anpan-os
  fi

  chmod +x "$TMP"
  mv "$TMP" "$INSTALLED_BIN"
  BINARY_CHANGED=1
  success "Binary installed at ${INSTALLED_BIN}"
fi

# ── Config directory ──────────────────────────────────────────────────────────

if [ -f "${CONFIG_DIR}/config.toml" ]; then
  warn "Config ${CONFIG_DIR}/config.toml already exists — skipping creation."
else
  mkdir -p "${CONFIG_DIR}/certs"
  cat > "${CONFIG_DIR}/config.toml" <<'EOF'
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
#
# Written only when the contents actually differ, so an unchanged unit costs neither a
# daemon-reload nor a restart.

UNIT_CONTENT="$(cat <<EOF
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
)"

UNIT_CHANGED=0
if [ ! -f "$SERVICE_FILE" ] || [ "$(cat "$SERVICE_FILE")" != "$UNIT_CONTENT" ]; then
  printf '%s\n' "$UNIT_CONTENT" > "$SERVICE_FILE"
  systemctl daemon-reload
  UNIT_CHANGED=1
  info "Systemd unit written."
fi

systemctl enable --quiet anpan-os 2>/dev/null || true

if [ "$BINARY_CHANGED" -eq 1 ] || [ "$UNIT_CHANGED" -eq 1 ]; then
  systemctl restart anpan-os
  success "anpan-os service restarted."
elif ! systemctl is-active --quiet anpan-os; then
  systemctl start anpan-os
  success "anpan-os service started."
else
  success "anpan-os service already running — left untouched."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

sleep 1
if ! systemctl is-active --quiet anpan-os; then
  warn "anpan-os is not active. Recent logs:"
  journalctl -u anpan-os -n 20 --no-pager || true
  die "Service failed to start."
fi

PORT="$(grep -m1 '^port' "${CONFIG_DIR}/config.toml" 2>/dev/null | tr -dc '0-9' || true)"
PORT="${PORT:-5000}"

echo ""
if [ "$BINARY_CHANGED" -eq 1 ]; then
  echo -e "${GREEN}✅ anpan-os ${LATEST} installed successfully!${NC}"
else
  echo -e "${GREEN}✅ anpan-os ${LATEST} is up to date.${NC}"
fi
echo ""
echo -e "   Config : ${CYAN}${CONFIG_DIR}/config.toml${NC}"
echo -e "   Service: ${CYAN}systemctl status anpan-os${NC}"
echo -e "   Logs   : ${CYAN}journalctl -u anpan-os -f${NC}"
echo ""
echo -e "   Open ${CYAN}http://$(hostname -I | awk '{print $1}'):${PORT}${NC} in your browser."
echo ""
