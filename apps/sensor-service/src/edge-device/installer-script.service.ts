import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  InstallerScriptVariables,
  TenantInstallerScriptVariables,
} from './dto/provisioning.dto';

export interface ProvisioningConfig {
  apiBaseUrl: string;
  mqttBroker: string;
  mqttPort: number;
  agentVersion: string;
  githubRepo: string;
  githubReleaseUrl: string;
}

/**
 * Installer Script Service
 * Handles shell script generation for edge device provisioning.
 * Provides both per-device and tenant-level installer scripts.
 */
@Injectable()
export class InstallerScriptService {
  private readonly logger = new Logger(InstallerScriptService.name);

  private readonly API_BASE_URL: string;
  private readonly AGENT_VERSION: string;
  private readonly MQTT_BROKER: string;
  private readonly MQTT_PORT: number;
  /** Pinned GitHub repo — never overridden by remote config to prevent supply-chain attacks */
  private readonly PINNED_GITHUB_REPO: string;

  private cachedConfig: ProvisioningConfig | null = null;
  private configCacheExpiry: Date = new Date(0);
  private readonly CONFIG_CACHE_TTL_MS = 60000; // 1 minute

  constructor(private readonly configService: ConfigService) {
    this.API_BASE_URL = this.configService.get<string>('PROVISIONING_API_BASE_URL', 'http://localhost:3000');
    this.AGENT_VERSION = this.configService.get<string>('AGENT_VERSION', 'latest');
    this.MQTT_BROKER = this.configService.get<string>('MQTT_BROKER_HOST', 'localhost');
    this.MQTT_PORT = this.configService.get<number>('MQTT_BROKER_PORT', 1883);
    // Pin the GitHub repo from env var to prevent the admin API from redirecting
    // edge agent downloads to an attacker-controlled repository (MED-07)
    this.PINNED_GITHUB_REPO = this.configService.get<string>('EDGE_AGENT_GITHUB_REPO', 'Okan-wqm/aquaculture_platform');
  }

  /**
   * Get provisioning config from admin API with caching and env var fallback.
   * Cache TTL: 1 minute. If admin API is unreachable, falls back to env vars.
   *
   * Security: Uses a service-to-service bearer token to authenticate with the admin API.
   * The githubRepo field from the remote response is IGNORED — the pinned env var value is
   * always used to prevent supply-chain attacks via a compromised admin API.
   */
  async getProvisioningConfig(): Promise<ProvisioningConfig> {
    if (this.cachedConfig && this.configCacheExpiry > new Date()) {
      return this.cachedConfig;
    }

    try {
      const adminApiUrl = this.configService.get<string>('ADMIN_API_URL', 'http://localhost:3010');
      // Attach service-to-service bearer token so admin API rejects unauthenticated callers
      const serviceToken = this.configService.get<string>('INTERNAL_SERVICE_TOKEN', '');
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (serviceToken) {
        headers['Authorization'] = `Bearer ${serviceToken}`;
      }
      const response = await fetch(`${adminApiUrl}/system/settings/provisioning-config`, {
        signal: AbortSignal.timeout(5000),
        headers,
      });

      if (response.ok) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let config: any;
        try {
          config = await response.json();
        } catch {
          this.logger.warn('Failed to parse provisioning config response as JSON');
          throw new Error('Invalid JSON response');
        }
        this.cachedConfig = {
          apiBaseUrl: config.provisioningApiUrl ?? this.API_BASE_URL,
          mqttBroker: config.mqttBrokerHost ?? this.MQTT_BROKER,
          mqttPort: config.mqttBrokerPort ?? this.MQTT_PORT,
          agentVersion: config.agentDefaultVersion ?? this.AGENT_VERSION,
          // Always use the pinned value — never trust the remote config for the repo URL
          githubRepo: this.PINNED_GITHUB_REPO,
          githubReleaseUrl: `https://github.com/${this.PINNED_GITHUB_REPO}/releases`,
        };
        this.configCacheExpiry = new Date(Date.now() + this.CONFIG_CACHE_TTL_MS);
        return this.cachedConfig;
      }
    } catch (error) {
      this.logger.warn(`Failed to fetch provisioning config from admin API: ${error instanceof Error ? error.message : 'unknown error'}`);
    }

    // Cache fallback values with shorter TTL to prevent timeout storms
    const fallbackConfig: ProvisioningConfig = {
      apiBaseUrl: this.API_BASE_URL,
      mqttBroker: this.MQTT_BROKER,
      mqttPort: this.MQTT_PORT,
      agentVersion: this.AGENT_VERSION,
      // Always use the pinned repo, even in fallback path
      githubRepo: this.PINNED_GITHUB_REPO,
      githubReleaseUrl: `https://github.com/${this.PINNED_GITHUB_REPO}/releases`,
    };
    this.cachedConfig = fallbackConfig;
    this.configCacheExpiry = new Date(Date.now() + 15000); // 15s TTL for fallback
    return fallbackConfig;
  }

  /**
   * Sanitize a value for safe interpolation into shell scripts.
   * Removes or escapes characters that could enable shell injection.
   */
  private sanitizeForShell(value: string): string {
    // Only allow alphanumeric, dots, dashes, underscores, slashes, colons, and plus signs
    // This covers URLs, repo paths, version strings, device codes
    // Note: @ is intentionally excluded to prevent URL credential injection
    return value.replace(/[^a-zA-Z0-9._\-/:+]/g, '');
  }

  /**
   * Build installer URL for a specific device
   */
  async buildInstallerUrl(deviceCode: string, token?: string): Promise<string> {
    const config = await this.getProvisioningConfig();
    const base = `${config.apiBaseUrl}/install/${deviceCode}`;
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }

  /**
   * Build installer command for a specific device
   */
  async buildInstallerCommand(deviceCode: string, token?: string): Promise<string> {
    const url = await this.buildInstallerUrl(deviceCode, token);
    return `curl -sSL "${url}" | sudo bash`;
  }

  /**
   * Build tenant installer URL
   */
  async buildTenantInstallerUrl(tenantToken: string): Promise<string> {
    const config = await this.getProvisioningConfig();
    return `${config.apiBaseUrl}/install/t/${tenantToken}`;
  }

  /**
   * Build tenant installer command
   */
  async buildTenantInstallerCommand(tenantToken: string): Promise<string> {
    const url = await this.buildTenantInstallerUrl(tenantToken);
    return `curl -sSL ${url} | sudo bash`;
  }

  /**
   * Render installer script for a specific device (per-device provisioning)
   */
  renderInstallerScript(variables: InstallerScriptVariables, config?: ProvisioningConfig): string {
    const GITHUB_REPO = this.sanitizeForShell(config?.githubRepo || this.configService.get<string>('EDGE_AGENT_GITHUB_REPO', 'Okan-wqm/aquaculture_platform'));
    const now = new Date().toISOString();
    const safeDeviceCode = this.sanitizeForShell(variables.deviceCode);
    const safeAgentVersion = this.sanitizeForShell(variables.agentVersion);
    const safeApiUrl = this.sanitizeForShell(variables.apiUrl);
    const safeDeviceId = this.sanitizeForShell(variables.deviceId);
    const safeProvisioningToken = this.sanitizeForShell(variables.provisioningToken);
    const safeMqttBroker = this.sanitizeForShell(String(variables.mqttBroker ?? ''));
    const safeMqttPort = this.sanitizeForShell(String(variables.mqttPort));

    const header = `#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
#  Suderra Edge Agent Installer v2.0
#  Device: ${safeDeviceCode}
#  Generated: ${now}
# ══════════════════════════════════════════════════════════════════════════════
`;

    // Note: Single-quoted heredoc delimiter prevents bash variable expansion.
    // All ${} references below are TypeScript template literals resolved at generation time.
    const configStep = `
# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Create Configuration
# ─────────────────────────────────────────────────────────────────────────────
log "[4/7] Creating configuration..."
mkdir -p "$CONFIG_DIR"
mkdir -p "$DATA_DIR"

cat > "$CONFIG_DIR/config.yaml" << 'CONFIGEOF'
# Suderra Edge Agent Configuration
# Generated: ${now}

device_id: "${safeDeviceId}"
device_code: "${safeDeviceCode}"
api_url: "${safeApiUrl}"
provisioning_token: "${safeProvisioningToken}"

mqtt:
  broker: "${safeMqttBroker}"
  port: ${safeMqttPort}
  keepalive_secs: 60
  clean_session: false

telemetry:
  interval_seconds: 30
  include_cpu: true
  include_memory: true
  include_disk: true
  include_temperature: true

modbus: []

gpio: []
CONFIGEOF

# Set restrictive permissions on config
chmod 600 "$CONFIG_DIR/config.yaml"
log "Configuration created at $CONFIG_DIR/config.yaml"
`;

    const verifyFooter = `
log ""
log "══════════════════════════════════════════════════════════════════════════════"
log "                    INSTALLATION COMPLETE!"
log "══════════════════════════════════════════════════════════════════════════════"
log ""
log "  Device Code:    ${safeDeviceCode}"
log "  Service Status: $STATUS"
log "  Config File:    $CONFIG_DIR/config.yaml"
log "  Log Command:    journalctl -u suderra-agent -f"
log ""
log "  The device will appear online in the dashboard within 30 seconds."
log ""
`;

    return (
      header +
      this.renderScriptPreamble(GITHUB_REPO, safeDeviceCode) +
      this.renderBasePrerequisites() +
      this.renderArchDetectAndDownload(GITHUB_REPO, safeAgentVersion) +
      configStep +
      this.renderSystemdService() +
      this.renderStartAndVerify() +
      verifyFooter
    );
  }

  /**
   * Render tenant-level installer script (self-registration mode)
   */
  renderTenantInstallerScript(variables: TenantInstallerScriptVariables, config?: ProvisioningConfig): string {
    const GITHUB_REPO = this.sanitizeForShell(config?.githubRepo || this.configService.get<string>('EDGE_AGENT_GITHUB_REPO', 'Okan-wqm/aquaculture_platform'));
    const now = new Date().toISOString();
    const safeAgentVersion = this.sanitizeForShell(variables.agentVersion);
    const safeApiUrl = this.sanitizeForShell(variables.apiUrl);
    const safeTenantToken = this.sanitizeForShell(variables.tenantToken);
    const safeMqttBroker = this.sanitizeForShell(config?.mqttBroker || this.MQTT_BROKER);
    const safeMqttPort = this.sanitizeForShell(String(variables.mqttPort));

    const header = `#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
#  Suderra Edge Agent Installer v2.0 (Tenant Self-Registration)
#  Generated: ${now}
# ══════════════════════════════════════════════════════════════════════════════
`;

    // Note: Single-quoted heredoc delimiter prevents bash variable expansion.
    // All ${} references below are TypeScript template literals resolved at generation time.
    const configStep = `
# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Create Configuration (Tenant Self-Registration Mode)
# ─────────────────────────────────────────────────────────────────────────────
log "[4/7] Creating configuration (self-registration mode)..."
mkdir -p "$CONFIG_DIR"
mkdir -p "$DATA_DIR"

cat > "$CONFIG_DIR/config.yaml" << 'CONFIGEOF'
# Suderra Edge Agent Configuration
# Mode: Tenant Self-Registration (device_id assigned on first connect)
# Generated: ${now}

device_id: ""
device_code: ""
api_url: "${safeApiUrl}"
tenant_token: "${safeTenantToken}"

mqtt:
  broker: "${safeMqttBroker}"
  port: ${safeMqttPort}
  keepalive_secs: 60
  clean_session: false

telemetry:
  interval_seconds: 30
  include_cpu: true
  include_memory: true
  include_disk: true
  include_temperature: true

modbus: []

gpio: []
CONFIGEOF

# Set restrictive permissions on config
chmod 600 "$CONFIG_DIR/config.yaml"
log "Configuration created at $CONFIG_DIR/config.yaml"
`;

    const verifyFooter = `
log ""
log "══════════════════════════════════════════════════════════════════════════════"
log "                    INSTALLATION COMPLETE!"
log "══════════════════════════════════════════════════════════════════════════════"
log ""
log "  Mode:           Self-Registration (tenant-first)"
log "  Service Status: $STATUS"
log "  Config File:    $CONFIG_DIR/config.yaml"
log "  Log Command:    journalctl -u suderra-agent -f"
log ""
log "  The device will self-register and appear in the dashboard within 30 seconds."
log ""
`;

    return (
      header +
      this.renderScriptPreamble(GITHUB_REPO, undefined) +
      this.renderBasePrerequisites() +
      this.renderArchDetectAndDownload(GITHUB_REPO, safeAgentVersion) +
      configStep +
      this.renderSystemdService() +
      this.renderStartAndVerify() +
      verifyFooter
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Shared script fragment helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Render script preamble: variables, helper functions, log banner.
   * @param githubRepo - sanitized GitHub repo path
   * @param deviceCode - sanitized device code (undefined for tenant scripts)
   */
  private renderScriptPreamble(githubRepo: string, deviceCode?: string): string {
    const bannerLine2 = deviceCode
      ? `log "║           Suderra Edge Agent Installer v2.0                  ║"`
      : `log "║     Suderra Edge Agent Installer v2.0 (Self-Registration)   ║"`;
    let bannerLine3 = '';
    if (deviceCode) {
      const label = `Device: ${deviceCode}`;
      const padded = label.padEnd(56);
      bannerLine3 = `log "║  ${padded}║"`;
    }

    return `
GITHUB_REPO="${githubRepo}"
INSTALL_DIR="/opt/suderra"
CONFIG_DIR="/etc/suderra"
DATA_DIR="/var/lib/suderra"
LOG_FILE="/var/log/suderra-install.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE" 2>/dev/null; }

download_with_retry() {
    local url="$1" dest="$2" max_retries=5 retry=0
    while [ $retry -lt $max_retries ]; do
        if curl -fsSL --connect-timeout 30 --max-time 300 -o "$dest" "$url"; then
            return 0
        fi
        retry=$((retry + 1))
        wait_time=$((retry * retry * 5))
        log "Download failed, retry $retry/$max_retries in \${wait_time}s..."
        sleep "$wait_time"
    done
    log "ERROR: Download failed after $max_retries attempts: $url"
    return 1
}

WORK_DIR=$(mktemp -d /tmp/suderra-install.XXXXXX)
cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

log "╔══════════════════════════════════════════════════════════════╗"
${bannerLine2}
${bannerLine3 ? bannerLine3 + '\n' : ''}log "╚══════════════════════════════════════════════════════════════╝"
`;
  }

  /**
   * Render Steps 1: Prerequisites (root check, curl, existing installation, config backup)
   */
  private renderBasePrerequisites(): string {
    return `
# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Prerequisites
# ─────────────────────────────────────────────────────────────────────────────
log "[1/7] Checking prerequisites..."
if [ "$(id -u)" -ne 0 ]; then
    log "ERROR: This script must be run as root"
    exit 1
fi

if ! command -v curl &>/dev/null; then
    log "Installing curl..."
    export DEBIAN_FRONTEND=noninteractive
    for i in 1 2 3; do
        apt-get update -qq && apt-get install -y -qq curl && break
        log "apt-get failed, retrying in 10s... (attempt $i/3)"
        sleep 10
    done
    if ! command -v curl &>/dev/null; then
        log "ERROR: Failed to install curl"
        exit 1
    fi
fi

# Check for existing installation
if [ -f "$INSTALL_DIR/edge-agent" ] && systemctl is-active suderra-agent &>/dev/null; then
    log "WARNING: Suderra agent is already installed and running."
    log "Current version: $("$INSTALL_DIR/edge-agent" --version 2>/dev/null || echo "unknown")"
    log "To reinstall, first run: sudo systemctl stop suderra-agent"
    exit 2
fi

# Back up existing config if present
if [ -f "$CONFIG_DIR/config.yaml" ]; then
    cp "$CONFIG_DIR/config.yaml" "$CONFIG_DIR/config.yaml.bak.$(date +%s)"
    log "Backed up existing configuration"
fi
`;
  }

  /**
   * Render Steps 2-3: Architecture detection and GitHub download with checksum verification
   */
  private renderArchDetectAndDownload(githubRepo: string, safeAgentVersion: string): string {
    return `
# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Detect Architecture
# ─────────────────────────────────────────────────────────────────────────────
log "[2/7] Detecting architecture..."
ARCH=$(uname -m)
case $ARCH in
    x86_64)   ARCHIVE_NAME="suderra-agent-x86_64-linux" ;;
    aarch64)  ARCHIVE_NAME="suderra-agent-aarch64-linux" ;;
    armv7l)   ARCHIVE_NAME="suderra-agent-armv7-linux" ;;
    *)
        log "ERROR: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac
log "Architecture: $ARCH -> $ARCHIVE_NAME"

# Check available disk space
REQUIRED_MB=100
AVAILABLE_MB=$(df -Pm /opt 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "$AVAILABLE_MB" ] && [ "$AVAILABLE_MB" -lt "$REQUIRED_MB" ]; then
    log "ERROR: Insufficient disk space. Need \${REQUIRED_MB}MB, have \${AVAILABLE_MB}MB on /opt"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Download from GitHub Releases
# ─────────────────────────────────────────────────────────────────────────────
log "[3/7] Downloading edge-agent from GitHub..."

# Get latest release tag or use pinned version
AGENT_VERSION="${safeAgentVersion}"
if [ "$AGENT_VERSION" = "latest" ]; then
    LATEST_TAG=$(curl -s "https://api.github.com/repos/$GITHUB_REPO/releases/latest" | grep '"tag_name"' | cut -d '"' -f 4)
else
    # GitHub release tags use "agent-v" prefix (e.g., "agent-v1.0.0")
    case "$AGENT_VERSION" in
        agent-v*) LATEST_TAG="$AGENT_VERSION" ;;
        *)        LATEST_TAG="agent-v$AGENT_VERSION" ;;
    esac
fi

if [ -z "$LATEST_TAG" ]; then
    log "ERROR: Could not determine release version from GitHub API."
    log "This may be due to GitHub API rate limiting or network issues."
    log "Please specify an explicit agent version in the provisioning settings."
    exit 1
fi

log "Version: $LATEST_TAG"

TARBALL="\${ARCHIVE_NAME}.tar.gz"
CHECKSUM_FILE="\${TARBALL}.sha256"
DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/$LATEST_TAG/\${TARBALL}"
CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/download/$LATEST_TAG/\${CHECKSUM_FILE}"

log "Download URL: $DOWNLOAD_URL"

download_with_retry "$DOWNLOAD_URL" "$WORK_DIR/\${TARBALL}"
download_with_retry "$CHECKSUM_URL" "$WORK_DIR/\${CHECKSUM_FILE}"

# Verify SHA256 checksum
log "Verifying SHA256 checksum..."
if (cd "$WORK_DIR" && sha256sum -c "\$CHECKSUM_FILE"); then
    log "Checksum verified"
else
    log "ERROR: Checksum verification failed! Binary may be corrupted or tampered with."
    rm -f "$WORK_DIR/\${TARBALL}" "$WORK_DIR/\${CHECKSUM_FILE}"
    exit 1
fi

# Extract and install
mkdir -p "$INSTALL_DIR"
tar -xzf "$WORK_DIR/\${TARBALL}" -C "$INSTALL_DIR/"
chmod +x "$INSTALL_DIR/edge-agent"
rm -f "$WORK_DIR/\${TARBALL}" "$WORK_DIR/\${CHECKSUM_FILE}"

# Verify binary
if ! "$INSTALL_DIR/edge-agent" --version &> /dev/null; then
    log "WARNING: Could not verify binary version"
else
    VERSION=$("$INSTALL_DIR/edge-agent" --version 2>/dev/null || echo "unknown")
    log "Installed version: $VERSION"
fi
`;
  }

  /**
   * Render Step 5: Systemd service unit file creation and service user setup
   */
  private renderSystemdService(): string {
    return `
# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Create Systemd Service
# ─────────────────────────────────────────────────────────────────────────────
log "[5/7] Installing systemd service..."

# Create dedicated service user
if ! id suderra &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin suderra
    log "Created suderra service user"
elif [ "$(id -u suderra)" -ge 1000 ]; then
    log "WARNING: suderra user exists as regular user (UID=$(id -u suderra)), securing..."
    usermod --shell /usr/sbin/nologin suderra
fi
for grp in dialout gpio i2c; do
    getent group "$grp" &>/dev/null && usermod -aG "$grp" suderra 2>/dev/null || true
done
chown -R suderra:suderra "$DATA_DIR"
chown -R suderra:suderra "$CONFIG_DIR"
mkdir -p /var/log/suderra && chown suderra:suderra /var/log/suderra

cat > /etc/systemd/system/suderra-agent.service << 'SERVICEEOF'
[Unit]
Description=Suderra Edge Agent
Documentation=https://docs.suderra.com/edge-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=suderra
ExecStart=/opt/suderra/edge-agent
Restart=on-failure
RestartSec=10
StartLimitIntervalSec=300
StartLimitBurst=5

# Environment
Environment="RUST_LOG=info"
Environment="SUDERRA_DATA_DIR=/var/lib/suderra"

# Security hardening
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/suderra /etc/suderra /var/log/suderra /opt/suderra
NoNewPrivileges=true

# Resource limits
LimitNOFILE=65536
MemoryMax=256M
CPUQuota=80%

[Install]
WantedBy=multi-user.target
SERVICEEOF
`;
  }

  /**
   * Render Steps 6-7: Start service and verify installation
   */
  private renderStartAndVerify(): string {
    return `
# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Start Service
# ─────────────────────────────────────────────────────────────────────────────
log "[6/7] Starting edge-agent service..."
systemctl daemon-reload
systemctl enable suderra-agent
systemctl start suderra-agent

# Wait for activation
sleep 5

# ─────────────────────────────────────────────────────────────────────────────
# Step 7: Verify Installation
# ─────────────────────────────────────────────────────────────────────────────
log "[7/7] Verifying installation..."

STATUS=$(systemctl is-active suderra-agent)
if [ "$STATUS" = "active" ]; then
    log "✅ Edge agent is running"
else
    log "❌ Edge agent failed to start"
    log "Check logs: journalctl -u suderra-agent -n 50"
    exit 1
fi
`;
  }
}
