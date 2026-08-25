#!/usr/bin/env bash
# anpan-os installer / updater  —  Linux (systemd) and macOS (launchd)
#
# Usage: curl -fsSL https://raw.githubusercontent.com/deckyfx/anpan-os/main/install.sh | sudo bash
#
# Re-running this is cheap and safe. The remote checksum is fetched before the binary, so
# an already-current install downloads nothing, replaces nothing, and never restarts the
# service. Only a genuinely different binary — or a changed unit file — causes downtime.
#
# Options (append after `bash -s --`, e.g. `... | sudo bash -s -- --yes`):
#   -y, --yes           Never prompt; assume yes. Implied when there is no terminal to ask on.
#   -f, --force         Reinstall even when the installed binary is already identical.
#   -r, --release TAG   Install a specific release (e.g. v0.7.0) instead of the latest.
#                       Installing an older tag is a rollback and is confirmed separately.
#   -l, --list          List available releases and exit. Does not require root.
#   -h, --help          Show this help.

set -euo pipefail

REPO="deckyfx/anpan-os"
INSTALL_DIR="/usr/local/bin"

# ── Helpers ───────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; DIM='\033[2m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[ OK ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
die()     { echo -e "${RED}[FAIL]${NC}  $*" >&2; exit 1; }

# ── Platform detection ────────────────────────────────────────────────────────
#
# Everything below this point speaks through the svc_* functions and the variables set
# here, so the two platforms differ in one place rather than at every call site.

OS="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "$ARCH_RAW" in
  x86_64|amd64)   ARCH="x64"   ;;
  # macOS reports arm64 where Linux reports aarch64. Accepting only one of the two is
  # exactly what makes this script fail on Apple Silicon.
  aarch64|arm64)  ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH_RAW" ;;
esac

case "$OS" in
  Linux)
    PLATFORM="linux"
    CONFIG_DIR="/var/lib/anpan-os"
    SERVICE_FILE="/etc/systemd/system/anpan-os.service"
    # coreutils
    SHA_CMD="sha256sum"
    ;;
  Darwin)
    PLATFORM="darwin"
    # The macOS counterpart of /var/lib. Deliberately not a Homebrew prefix: that differs
    # between Apple Silicon (/opt/homebrew) and Intel (/usr/local), and state should not
    # move when a machine is replaced.
    CONFIG_DIR="/usr/local/var/anpan-os"
    LAUNCHD_LABEL="io.anpan.anpan-os"
    SERVICE_FILE="/Library/LaunchDaemons/${LAUNCHD_LABEL}.plist"
    # macOS has no sha256sum; shasum -a 256 prints the same "<hash>  <file>" format.
    SHA_CMD="shasum -a 256"
    ;;
  *) die "Unsupported operating system: $OS (this installer supports Linux and macOS)" ;;
esac

BINARY="anpan-os-${PLATFORM}-${ARCH}"

# ── Service provider ──────────────────────────────────────────────────────────
#
# systemd and launchd disagree about almost everything: launchd has no "enable" separate
# from "load", no "reload", and reports state through `print` rather than `is-active`.
# These wrappers give the install flow one vocabulary.

svc_is_active() {
  if [ "$PLATFORM" = "linux" ]; then
    systemctl is-active --quiet anpan-os 2>/dev/null
  else
    # `print` exits non-zero when the job is not loaded. A loaded job with a live PID is
    # the closest launchd equivalent of "active".
    launchctl print "system/${LAUNCHD_LABEL}" 2>/dev/null | grep -q "state = running"
  fi
}

svc_stop() {
  if [ "$PLATFORM" = "linux" ]; then
    systemctl stop anpan-os
  else
    launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true
  fi
}

svc_start() {
  if [ "$PLATFORM" = "linux" ]; then
    systemctl start anpan-os
  else
    launchctl bootstrap system "$SERVICE_FILE" 2>/dev/null || true
    launchctl kickstart "system/${LAUNCHD_LABEL}" 2>/dev/null || true
  fi
}

svc_restart() {
  if [ "$PLATFORM" = "linux" ]; then
    systemctl restart anpan-os
  else
    # -k kills the running instance first; bootstrap covers the not-yet-loaded case.
    launchctl bootstrap system "$SERVICE_FILE" 2>/dev/null || true
    launchctl kickstart -k "system/${LAUNCHD_LABEL}"
  fi
}

svc_enable() {
  if [ "$PLATFORM" = "linux" ]; then
    systemctl enable --quiet anpan-os 2>/dev/null || true
  else
    # RunAtLoad in the plist is what makes a LaunchDaemon start at boot; bootstrapping it
    # into the system domain is the whole of "enable" here.
    launchctl enable "system/${LAUNCHD_LABEL}" 2>/dev/null || true
  fi
}

svc_logs() {
  if [ "$PLATFORM" = "linux" ]; then
    journalctl -u anpan-os -n "${1:-20}" --no-pager || true
  else
    # launchd has no log store of its own; the plist redirects stdout/stderr to these.
    tail -n "${1:-20}" "${CONFIG_DIR}/anpan-os.log" "${CONFIG_DIR}/anpan-os.err" 2>/dev/null || true
  fi
}

# The unit/plist text, written only when it differs from what is already installed.
svc_unit_content() {
  if [ "$PLATFORM" = "linux" ]; then
    cat <<EOF
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
    # KeepAlive replaces Restart=on-failure. PATH is set explicitly because launchd hands a
    # daemon a minimal environment with neither Homebrew nor Docker Desktop on it, and
    # anpan-os shells out to both.
    cat <<EOF
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
  fi
}

# Local IP, for the "open this URL" line at the end.
host_ip() {
  if [ "$PLATFORM" = "linux" ]; then
    hostname -I 2>/dev/null | awk '{print $1}'
  else
    # macOS has no `hostname -I`. Ask the active interface, falling back across the usual
    # Wi-Fi/Ethernet names, then to localhost.
    for iface in $(route -n get default 2>/dev/null | awk '/interface:/{print $2}') en0 en1; do
      ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
      [ -n "$ip" ] && { echo "$ip"; return; }
    done
    echo "localhost"
  fi
}

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

ASSUME_YES="${ASSUME_YES:-0}"
FORCE=0
LIST=0
TARGET_TAG=""

while [ $# -gt 0 ]; do
  case "$1" in
    -y|--yes)   ASSUME_YES=1 ;;
    -f|--force) FORCE=1 ;;
    -l|--list)  LIST=1 ;;
    -r|--release)
      shift
      [ $# -gt 0 ] || die "--release needs a tag (e.g. --release v0.7.0). Try --list."
      TARGET_TAG="$1"
      # Accept "0.7.0" as readily as "v0.7.0"; the tags themselves carry the v.
      case "$TARGET_TAG" in v*) ;; *) TARGET_TAG="v${TARGET_TAG}" ;; esac
      ;;
    -h|--help)  awk 'NR>1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "$0"; exit 0 ;;
    *) die "Unknown option: $1 (try --help)" ;;
  esac
  shift
done

# True when $1 is an older version than $2. sort -V understands v-prefixed semver, so the
# smaller of the pair sorts first; equal versions are not "older".
#
# macOS `sort` has no -V. The fallback compares the three numeric fields directly, which is
# all these tags ever contain.
is_older() {
  [ "$1" = "$2" ] && return 1
  if printf 'v1.0.0\nv1.0.1\n' | sort -V >/dev/null 2>&1; then
    [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" = "$1" ]
  else
    awk -v a="${1#v}" -v b="${2#v}" 'BEGIN {
      split(a, x, "."); split(b, y, ".");
      for (i = 1; i <= 3; i++) {
        xi = x[i] + 0; yi = y[i] + 0;
        if (xi < yi) exit 0;
        if (xi > yi) exit 1;
      }
      exit 1
    }'
  fi
}

# This script is normally piped into bash, so stdin is the script itself — never a user.
# Prompts therefore have to come from the controlling terminal, and when there is none
# (CI, cloud-init, a self-update call) we proceed without asking.
# confirm "question" [default]   — default is "yes" unless "no" is passed.
confirm() {
  local default="${2:-yes}" reply hint
  [ "$ASSUME_YES" -eq 1 ] && return 0
  [ -r /dev/tty ] || return 0
  [ "$default" = "no" ] && hint="[y/N]" || hint="[Y/n]"
  printf "%b" "${CYAN}[ ?  ]${NC}  $1 ${hint} " > /dev/tty
  read -r reply < /dev/tty || reply=""
  if [ "$default" = "no" ]; then
    case "$reply" in [yY]*) return 0 ;; *) return 1 ;; esac
  else
    case "$reply" in [nN]*) return 1 ;; *) return 0 ;; esac
  fi
}

# Installed version, or "" when absent/unreadable. Scrapes the first vX.Y.Z anywhere in the
# output rather than a fixed field: the binary prints a "Run mode" banner before the version
# line, and that preamble may change again.
installed_version() {
  [ -x "${INSTALL_DIR}/anpan-os" ] || return 0
  "${INSTALL_DIR}/anpan-os" --version 2>/dev/null | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true
}

# ── --list ────────────────────────────────────────────────────────────────────
# Handled before the root check: listing what exists is a read-only question.

if [ "$LIST" -eq 1 ]; then
  RELEASES="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases?per_page=30")" \
    || die "Could not reach the GitHub release API."
  INSTALLED_NOW="$(installed_version)"

  echo ""
  echo -e "${CYAN}Available anpan-os releases:${NC}"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$RELEASES" | jq -r '.[] | "\(.tag_name)\t\(.published_at[0:10])\t\(.name // "")"'
  else
    printf '%s' "$RELEASES" | grep '"tag_name"' | cut -d'"' -f4 | sed 's/$/\t\t/'
  fi | {
    first=1
    while IFS=$'\t' read -r tag date name; do
      marker=""
      [ "$first" -eq 1 ] && { marker="${GREEN}(latest)${NC}"; first=0; }
      [ -n "$INSTALLED_NOW" ] && [ "$tag" = "$INSTALLED_NOW" ] && marker="${marker} ${CYAN}(installed)${NC}"
      printf "   %-10s ${DIM}%s${NC}  %b\n" "$tag" "$date" "$marker"
    done
  }
  echo ""
  echo -e "${DIM}   Install one with: ... | sudo bash -s -- --release <tag>${NC}"
  echo ""
  exit 0
fi

# ── Root check ────────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ] || die "This script must be run as root (use sudo)."

info "Platform: ${PLATFORM}/${ARCH}"

# ── Installed version ─────────────────────────────────────────────────────────

INSTALLED_BIN="${INSTALL_DIR}/anpan-os"
# Tolerate a binary too old or too broken to answer — an unreadable version is not a
# reason to refuse to install over it.
CURRENT_VERSION="$(installed_version)"

# ── Fetch the target release ──────────────────────────────────────────────────
#
# Everything up to the summary line below stays quiet: the interesting fact is the
# comparison, not the several lookups taken to reach it.

if [ -n "$TARGET_TAG" ]; then
  info "Fetching release ${TARGET_TAG}..."
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/tags/${TARGET_TAG}")" \
    || die "No such release: ${TARGET_TAG}. Run with --list to see what is available."
else
  info "Checking for updates..."
  RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")" \
    || die "Could not reach the GitHub release API."
fi

if command -v jq >/dev/null 2>&1; then
  LATEST="$(printf '%s' "$RELEASE_JSON" | jq -r '.tag_name // empty')"
  NOTES="$(printf '%s' "$RELEASE_JSON"  | jq -r '.body // empty')"
else
  LATEST="$(printf '%s' "$RELEASE_JSON" | grep '"tag_name"' | cut -d'"' -f4)"
  NOTES=""   # parsing Markdown out of JSON without jq is not worth the fragility
fi
[ -n "$LATEST" ] || die "Could not determine the release to install."

DOWNLOAD_URL="https://github.com/${REPO}/releases/download/${LATEST}/${BINARY}"

# Going backwards is legitimate — rolling back a bad release, or exercising this script —
# but it is never what someone wants by accident, so it is called out and confirmed
# separately from an ordinary upgrade.
ROLLBACK=0
if [ -n "$CURRENT_VERSION" ] && is_older "$LATEST" "$CURRENT_VERSION"; then
  ROLLBACK=1
fi

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
  if [ "$($SHA_CMD "$INSTALLED_BIN" | awk '{print $1}')" = "$EXPECTED_HASH" ]; then
    BINARY_UP_TO_DATE=1
  fi
elif [ -z "$EXPECTED_HASH" ] && [ -n "$CURRENT_VERSION" ] && [ "$CURRENT_VERSION" = "$LATEST" ]; then
  # Older releases predate the .sha256 assets; fall back to the version string.
  BINARY_UP_TO_DATE=1
fi

if [ "$BINARY_UP_TO_DATE" -eq 1 ] && [ "$FORCE" -eq 0 ]; then
  # Still make sure the unit exists and the service is up; a current binary that is not
  # running is exactly the state someone re-runs this script to fix.
  NEED_DOWNLOAD=0
else
  NEED_DOWNLOAD=1
fi

# One line saying where we stand, instead of narrating each lookup that got us here.
if [ -z "$CURRENT_VERSION" ] && [ ! -f "$INSTALLED_BIN" ]; then
  info "Installing ${LATEST} — no existing installation found."
elif [ "$NEED_DOWNLOAD" -eq 0 ]; then
  success "${LATEST} is already installed and identical — nothing to download."
elif [ "$ROLLBACK" -eq 1 ]; then
  warn "Rollback: ${CURRENT_VERSION} → ${LATEST}  (installing an OLDER release)"
  warn "Config and database are not downgraded; an older binary may not understand them."
elif [ "$BINARY_UP_TO_DATE" -eq 1 ]; then
  info "Reinstalling ${LATEST} (--force; installed binary is already identical)."
elif [ "$CURRENT_VERSION" = "$LATEST" ]; then
  info "Update: ${LATEST} — same version, different binary."
else
  info "Update: ${CURRENT_VERSION:-unknown} → ${LATEST}"
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

  if [ "$ROLLBACK" -eq 1 ]; then
    # Defaults to no: a downgrade is the one path here that can leave the service unable
    # to read state the newer version wrote.
    confirm "Really roll back ${CURRENT_VERSION} → ${LATEST}?" no \
      || { info "Aborted — nothing changed."; exit 0; }
  elif [ -n "$CURRENT_VERSION" ]; then
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
  curl -fL --progress-bar "$DOWNLOAD_URL" -o "$TMP" \
    || die "Download failed: $DOWNLOAD_URL (is there a ${PLATFORM}/${ARCH} build for ${LATEST}?)"

  if [ -n "$EXPECTED_HASH" ]; then
    info "Verifying SHA256 checksum..."
    ACTUAL_HASH="$($SHA_CMD "$TMP" | awk '{print $1}')"
    [ "$EXPECTED_HASH" = "$ACTUAL_HASH" ] \
      || { rm -f "$TMP"; die "SHA256 mismatch — download may be corrupted. Aborting."; }
    success "Checksum verified."
  else
    warn "No published checksum for ${LATEST} — skipping verification."
  fi

  # Stop the service before replacing the binary — overwriting a running executable gives
  # "Text file busy" on Linux, and on macOS leaves the old image mapped.
  if svc_is_active; then
    info "Stopping anpan-os service..."
    svc_stop
  fi

  mkdir -p "$INSTALL_DIR"
  chmod +x "$TMP"
  mv "$TMP" "$INSTALLED_BIN"

  if [ "$PLATFORM" = "darwin" ]; then
    # Gatekeeper quarantines anything curl wrote. An unsigned binary carrying the
    # quarantine attribute is killed on exec with no useful message, so it is stripped
    # here rather than left for the user to discover.
    xattr -d com.apple.quarantine "$INSTALLED_BIN" 2>/dev/null || true
  fi

  BINARY_CHANGED=1
  success "Binary installed at ${INSTALLED_BIN}"
fi

# ── Config directory ──────────────────────────────────────────────────────────

if [ -f "${CONFIG_DIR}/config.toml" ]; then
  warn "Config ${CONFIG_DIR}/config.toml already exists — skipping creation."
else
  mkdir -p "${CONFIG_DIR}/certs"

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
  } > "${CONFIG_DIR}/config.toml"
  success "Config created at ${CONFIG_DIR}/config.toml (port ${CHOSEN_PORT})"
fi

# ── Service unit ──────────────────────────────────────────────────────────────
#
# Written only when the contents actually differ, so an unchanged unit costs neither a
# reload nor a restart.

UNIT_CONTENT="$(svc_unit_content)"

UNIT_CHANGED=0
if [ ! -f "$SERVICE_FILE" ] || [ "$(cat "$SERVICE_FILE")" != "$UNIT_CONTENT" ]; then
  mkdir -p "$(dirname "$SERVICE_FILE")"
  printf '%s\n' "$UNIT_CONTENT" > "$SERVICE_FILE"
  if [ "$PLATFORM" = "linux" ]; then
    systemctl daemon-reload
  else
    # launchd refuses to load a plist that is group- or world-writable.
    chown root:wheel "$SERVICE_FILE"
    chmod 644 "$SERVICE_FILE"
    # A changed plist must be unloaded before the new one takes effect.
    launchctl bootout "system/${LAUNCHD_LABEL}" 2>/dev/null || true
  fi
  UNIT_CHANGED=1
  info "Service definition written to ${SERVICE_FILE}"
fi

svc_enable

if [ "$BINARY_CHANGED" -eq 1 ] || [ "$UNIT_CHANGED" -eq 1 ]; then
  svc_restart
  success "anpan-os service restarted."
elif ! svc_is_active; then
  svc_start
  success "anpan-os service started."
else
  success "anpan-os service already running — left untouched."
fi

# ── Done ──────────────────────────────────────────────────────────────────────

sleep 2
if ! svc_is_active; then
  warn "anpan-os is not active. Recent logs:"
  svc_logs 20
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
if [ "$PLATFORM" = "linux" ]; then
  echo -e "   Service: ${CYAN}systemctl status anpan-os${NC}"
  echo -e "   Logs   : ${CYAN}journalctl -u anpan-os -f${NC}"
else
  echo -e "   Service: ${CYAN}sudo launchctl print system/${LAUNCHD_LABEL}${NC}"
  echo -e "   Logs   : ${CYAN}tail -f ${CONFIG_DIR}/anpan-os.log${NC}"
fi
echo ""
echo -e "   Open ${CYAN}http://$(host_ip):${PORT}${NC} in your browser."
echo ""
