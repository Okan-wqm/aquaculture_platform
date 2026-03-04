#!/usr/bin/env bash
# Suderra SCADA Display - Setup Script
# Installs and manages the kiosk display service for edge devices.
#
# Usage:
#   sudo ./setup-display.sh install    - Install dependencies and enable service
#   sudo ./setup-display.sh enable     - Start the display service
#   sudo ./setup-display.sh disable    - Stop the display service
#   sudo ./setup-display.sh status     - Show service and display status
#   sudo ./setup-display.sh uninstall  - Remove the display service

set -euo pipefail

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_NAME="suderra-display"
SERVICE_FILE="${SCRIPT_DIR}/../systemd/${SERVICE_NAME}.service"
SYSTEM_SERVICE="/etc/systemd/system/${SERVICE_NAME}.service"
SUDERRA_USER="suderra"

# --- Helpers ---
info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*" >&2; }
die()   { err "$@"; exit 1; }

check_root() {
    if [[ $EUID -ne 0 ]]; then
        die "This script must be run as root (use sudo)"
    fi
}

# --- Subcommands ---

cmd_install() {
    info "Starting Suderra SCADA Display installation..."
    echo

    # 1. Check for GPU/display hardware
    info "Checking display hardware..."
    if [[ -e /dev/dri/card0 ]]; then
        ok "Display device found: /dev/dri/card0"
    else
        warn "No display device at /dev/dri/card0"
        warn "Service will not start without a display adapter (ConditionPathExists)"
    fi
    echo

    # 2. Install dependencies
    info "Installing packages: cage chromium-browser fonts-noto..."
    apt-get update -qq
    apt-get install -y --no-install-recommends cage chromium-browser fonts-noto
    ok "Packages installed"
    echo

    # 3. Verify suderra user exists
    info "Checking suderra user..."
    if id "${SUDERRA_USER}" &>/dev/null; then
        ok "User '${SUDERRA_USER}' exists"
    else
        info "Creating system user '${SUDERRA_USER}'..."
        useradd -r -s /usr/sbin/nologin -m "${SUDERRA_USER}"
        ok "User '${SUDERRA_USER}' created"
    fi

    # Add user to video group for DRM access
    if groups "${SUDERRA_USER}" | grep -q '\bvideo\b'; then
        ok "User already in 'video' group"
    else
        usermod -aG video "${SUDERRA_USER}"
        ok "User added to 'video' group"
    fi
    echo

    # 4. Verify required binaries
    info "Checking required binaries..."
    local missing=0
    for bin in cage chromium-browser curl; do
        if command -v "${bin}" &>/dev/null; then
            ok "${bin} found: $(command -v "${bin}")"
        else
            err "${bin} not found in PATH"
            missing=1
        fi
    done
    if [[ ${missing} -ne 0 ]]; then
        die "Required binaries missing. Check package installation."
    fi
    echo

    # 5. Install service file
    info "Installing systemd service..."
    if [[ ! -f "${SERVICE_FILE}" ]]; then
        die "Service file not found: ${SERVICE_FILE}"
    fi
    cp "${SERVICE_FILE}" "${SYSTEM_SERVICE}"
    chmod 644 "${SYSTEM_SERVICE}"
    ok "Service file installed to ${SYSTEM_SERVICE}"
    echo

    # 6. Reload and enable
    info "Enabling service..."
    systemctl daemon-reload
    systemctl enable "${SERVICE_NAME}"
    ok "Service enabled (will start on boot)"
    echo

    # 7. Summary
    echo -e "${GREEN}========================================${NC}"
    echo -e "${GREEN} Suderra SCADA Display - Installed${NC}"
    echo -e "${GREEN}========================================${NC}"
    echo
    info "Start now with:  sudo $0 enable"
    info "Check status:    sudo $0 status"
    echo
}

cmd_enable() {
    info "Starting ${SERVICE_NAME}..."
    systemctl start "${SERVICE_NAME}"
    ok "Service started"
    systemctl --no-pager status "${SERVICE_NAME}" || true
}

cmd_disable() {
    info "Stopping ${SERVICE_NAME}..."
    systemctl stop "${SERVICE_NAME}"
    ok "Service stopped"
}

cmd_status() {
    echo -e "${BLUE}=== Service Status ===${NC}"
    systemctl --no-pager status "${SERVICE_NAME}" 2>/dev/null || warn "Service not found or not running"
    echo

    echo -e "${BLUE}=== Agent Health ===${NC}"
    if curl -sf http://localhost:8080/health >/dev/null 2>&1; then
        ok "Agent HTTP health check: OK"
    else
        warn "Agent HTTP health check: FAILED (http://localhost:8080/health)"
    fi
    echo

    echo -e "${BLUE}=== Display Process ===${NC}"
    if pgrep -a cage >/dev/null 2>&1; then
        ok "cage compositor is running"
        pgrep -a cage
    else
        warn "cage compositor is not running"
    fi

    if pgrep -af "chromium.*kiosk" >/dev/null 2>&1; then
        ok "Chromium kiosk is running"
    else
        warn "Chromium kiosk is not running"
    fi
    echo

    echo -e "${BLUE}=== Display Hardware ===${NC}"
    if [[ -e /dev/dri/card0 ]]; then
        ok "Display device: /dev/dri/card0"
    else
        warn "No display device found"
    fi
}

cmd_uninstall() {
    info "Uninstalling ${SERVICE_NAME}..."
    echo

    # Stop if running
    if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
        info "Stopping service..."
        systemctl stop "${SERVICE_NAME}"
        ok "Service stopped"
    fi

    # Disable
    if systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
        info "Disabling service..."
        systemctl disable "${SERVICE_NAME}"
        ok "Service disabled"
    fi

    # Remove service file
    if [[ -f "${SYSTEM_SERVICE}" ]]; then
        info "Removing service file..."
        rm -f "${SYSTEM_SERVICE}"
        systemctl daemon-reload
        ok "Service file removed"
    fi

    echo
    ok "Suderra SCADA Display uninstalled"
    info "Packages (cage, chromium-browser) were not removed. Remove manually if needed."
}

# --- Main ---
check_root

case "${1:-}" in
    install)   cmd_install ;;
    enable)    cmd_enable ;;
    disable)   cmd_disable ;;
    status)    cmd_status ;;
    uninstall) cmd_uninstall ;;
    *)
        echo "Usage: $0 {install|enable|disable|status|uninstall}"
        exit 1
        ;;
esac
