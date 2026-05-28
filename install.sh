#!/usr/bin/env bash
# anpan-os installer
# Usage: curl -fsSL https://raw.githubusercontent.com/deckyfx/anpan-os/main/install.sh | sudo bash

set -euo pipefail

REPO="deckyfx/anpan-os"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/var/lib/anpan-os"
SERVICE_FILE="/etc/systemd/system/anpan-os.service"

# ── Helpers ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

# ── Root check ────────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ] || die "This script must be run as root (use sudo)."

# ── Architecture detection ────────────────────────────────────────────────────

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64)  BINARY="anpan-os-linux-x64"   ;;
  aarch64) BINARY="anpan-os-linux-arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac

# ── Fetch latest release ──────────────────────────────────────────────────────

info "Fetching latest release from GitHub..."
LATEST=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"tag_name"' | cut -d'"' -f4)
[ -n "$LATEST" ] || die "Could not determine latest release."
info "Latest version: $LATEST"

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"

# ── Download binary ───────────────────────────────────────────────────────────

info "Downloading $BINARY..."
TMP="$(mktemp)"
curl -fsSL "$DOWNLOAD_URL" -o "$TMP" || die "Download failed: $DOWNLOAD_URL"

info "Verifying SHA256 checksum..."
SHA256_URL="${DOWNLOAD_URL}.sha256"
TMP_SHA256="$(mktemp)"
curl -fsSL "$SHA256_URL" -o "$TMP_SHA256" || die "Failed to download checksum: $SHA256_URL"
EXPECTED_HASH=$(awk '{print $1}' "$TMP_SHA256")
ACTUAL_HASH=$(sha256sum "$TMP" | awk '{print $1}')
rm -f "$TMP_SHA256"
[ "$EXPECTED_HASH" = "$ACTUAL_HASH" ] || die "SHA256 mismatch — download may be corrupted. Aborting."
success "Checksum verified."

chmod +x "$TMP"
mv "$TMP" "${INSTALL_DIR}/anpan-os"
success "Binary installed at ${INSTALL_DIR}/anpan-os"

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
# disable_login_method = []      # "form" disables password login/setup; "passkey" disables passkey auth/registration

[compose]

[files]
root = "/"

[samba]
EOF
  success "Config created at ${CONFIG_DIR}/config.toml"
fi

# ── Systemd service ───────────────────────────────────────────────────────────

cat > "$SERVICE_FILE" <<EOF
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

systemctl daemon-reload
systemctl enable --now anpan-os
success "anpan-os service enabled and started."

# ── Done ──────────────────────────────────────────────────────────────────────

echo ""
echo -e "${GREEN}✅ anpan-os ${LATEST} installed successfully!${NC}"
echo ""
echo -e "   Config : ${CYAN}${CONFIG_DIR}/config.toml${NC}"
echo -e "   Service: ${CYAN}systemctl status anpan-os${NC}"
echo -e "   Logs   : ${CYAN}journalctl -u anpan-os -f${NC}"
echo ""
echo -e "   Open ${CYAN}http://$(hostname -I | awk '{print $1}'):5000${NC} in your browser."
echo ""
