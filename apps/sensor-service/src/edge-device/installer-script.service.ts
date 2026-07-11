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
  mqttTlsEnabled: boolean;
}

interface RemoteProvisioningConfig {
  provisioningApiUrl?: string;
  mqttBrokerHost?: string;
  mqttBrokerPort?: number;
  agentDefaultVersion?: string;
  mqttTlsEnabled?: boolean;
}

export interface SuderraOsInstallManifest {
  version: string;
  artifact_url: string;
  sha256: string;
  signature_url: string;
  binary_name: string;
  artifact_format: string;
  activation_token: string;
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
  private readonly MQTT_TLS_ENABLED: boolean;
  /** Pinned GitHub repo — never overridden by remote config to prevent supply-chain attacks */
  private readonly PINNED_GITHUB_REPO: string;

  private cachedConfig: ProvisioningConfig | null = null;
  private configCacheExpiry: Date = new Date(0);
  private readonly CONFIG_CACHE_TTL_MS = 60000; // 1 minute

  constructor(private readonly configService: ConfigService) {
    this.API_BASE_URL = this.configService.get<string>('PROVISIONING_API_BASE_URL', 'http://localhost:3000');
    this.AGENT_VERSION = this.configService.get<string>('AGENT_VERSION', '');
    // Public broker host for edge agents (external access). Falls back to MQTT_BROKER_HOST
    // which may be an internal Docker hostname — override with MQTT_PUBLIC_BROKER_HOST in production.
    const apiBaseUrl = this.configService.get<string>('PROVISIONING_API_BASE_URL', 'http://localhost:3000');
    const defaultPublicHost = (() => { try { return new URL(apiBaseUrl).hostname; } catch { return 'localhost'; } })();
    this.MQTT_BROKER = this.configService.get<string>('MQTT_PUBLIC_BROKER_HOST', defaultPublicHost);
    this.MQTT_PORT = Number(this.configService.get('MQTT_BROKER_PORT', 1883));
    this.MQTT_TLS_ENABLED = Number(this.configService.get('MQTT_BROKER_PORT', 1883)) === 8883;
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
        let configRaw: unknown;
        try {
          configRaw = await response.json();
        } catch {
          this.logger.warn('Failed to parse provisioning config response as JSON');
          throw new Error('Invalid JSON response');
        }
        const config = this.parseRemoteProvisioningConfig(configRaw);
        this.cachedConfig = {
          apiBaseUrl: config.provisioningApiUrl ?? this.API_BASE_URL,
          mqttBroker: config.mqttBrokerHost ?? this.MQTT_BROKER,
          mqttPort: config.mqttBrokerPort ?? this.MQTT_PORT,
          agentVersion: config.agentDefaultVersion ?? this.AGENT_VERSION,
          // Always use the pinned value — never trust the remote config for the repo URL
          githubRepo: this.PINNED_GITHUB_REPO,
          githubReleaseUrl: `https://github.com/${this.PINNED_GITHUB_REPO}/releases`,
          mqttTlsEnabled: config.mqttTlsEnabled ?? this.MQTT_TLS_ENABLED,
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
      mqttTlsEnabled: this.MQTT_TLS_ENABLED,
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

  private parseRemoteProvisioningConfig(value: unknown): RemoteProvisioningConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    const record = value as Record<string, unknown>;
    return {
      provisioningApiUrl: this.stringOrUndefined(record.provisioningApiUrl),
      mqttBrokerHost: this.stringOrUndefined(record.mqttBrokerHost),
      mqttBrokerPort: this.numberOrUndefined(record.mqttBrokerPort),
      agentDefaultVersion: this.stringOrUndefined(record.agentDefaultVersion),
      mqttTlsEnabled: this.booleanOrUndefined(record.mqttTlsEnabled),
    };
  }

  private stringOrUndefined(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private numberOrUndefined(value: unknown): number | undefined {
    return typeof value === 'number' ? value : undefined;
  }

  private booleanOrUndefined(value: unknown): boolean | undefined {
    return typeof value === 'boolean' ? value : undefined;
  }

  private assertExplicitAgentVersion(version: string): string {
    const trimmed = version.trim();
    if (!trimmed || trimmed === 'latest') {
      throw new Error('AGENT_VERSION cannot be latest; configure an explicit agent-v<exact Cargo semver> release tag.');
    }

    const canonical = trimmed.startsWith('agent-v') ? trimmed : `agent-v${trimmed}`;
    if (!/^agent-v\d+\.\d+\.\d+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$/.test(canonical)) {
      throw new Error(
        `Invalid AGENT_VERSION '${version}'. Expected agent-v<exact Cargo semver>, for example agent-v2.0.0-rc.4.`,
      );
    }

    return canonical;
  }

  /**
   * Build installer URL for a specific device.
   * SENSOR-MEDIUM-002: the token is NEVER placed in the URL — it travels in the
   * X-Provisioning-Token header (see buildInstallerCommand) so it cannot leak
   * into access logs.
   */
  async buildInstallerUrl(deviceCode: string): Promise<string> {
    const config = await this.getProvisioningConfig();
    return `${config.apiBaseUrl}/install/${deviceCode}`;
  }

  /**
   * Build installer command for a specific device.
   * The provisioning token is passed as a request header, not a URL query.
   */
  async buildInstallerCommand(deviceCode: string, token?: string): Promise<string> {
    const url = await this.buildInstallerUrl(deviceCode);
    const header = token
      ? `-H "X-Provisioning-Token: ${this.sanitizeForShell(token)}" `
      : '';
    return `curl -sSL ${header}"${url}" | sudo bash`;
  }

  /**
   * Build Suderra OS manifest URL for a specific device.
   * This is consumed by the forced-command provision user on Suderra OS.
   * SENSOR-MEDIUM-002: token is sent via the X-Provisioning-Token header.
   */
  async buildSuderraOsInstallerUrl(deviceCode: string): Promise<string> {
    const config = await this.getProvisioningConfig();
    return `${config.apiBaseUrl}/install/${deviceCode}/suderra-os`;
  }

  /**
   * Build the command the tenant panel can run against a freshly booted
   * Suderra OS target. The token is carried in the request header.
   */
  async buildSuderraOsInstallerCommand(deviceIp: string, deviceCode: string, token: string): Promise<string> {
    const url = await this.buildSuderraOsInstallerUrl(deviceCode);
    const safeDeviceIp = this.sanitizeForShell(deviceIp);
    const safeToken = this.sanitizeForShell(token);
    return `ssh provision@${safeDeviceIp} install-manifest-url ${url} X-Provisioning-Token:${safeToken}`;
  }

  /**
   * Render a Suderra OS JSON install manifest. Unlike the generic Linux path,
   * this does not emit a shell script and requires pre-signed Edge artifacts.
   */
  renderSuderraOsInstallManifest(variables: InstallerScriptVariables): SuderraOsInstallManifest {
    const artifactUrl = this.configService.get<string>('SUDERRA_OS_EDGE_ARTIFACT_URL', '');
    const sha256 = this.configService.get<string>('SUDERRA_OS_EDGE_ARTIFACT_SHA256', '');
    const signatureUrl = this.configService.get<string>(
      'SUDERRA_OS_EDGE_SIGNATURE_URL',
      artifactUrl ? `${artifactUrl}.sig` : '',
    );

    if (!artifactUrl || !sha256 || !signatureUrl) {
      throw new Error(
        'Suderra OS installer manifest requires SUDERRA_OS_EDGE_ARTIFACT_URL, ' +
          'SUDERRA_OS_EDGE_ARTIFACT_SHA256 and SUDERRA_OS_EDGE_SIGNATURE_URL',
      );
    }

    return {
      version: variables.agentVersion,
      artifact_url: artifactUrl,
      sha256,
      signature_url: signatureUrl,
      binary_name: this.configService.get<string>('SUDERRA_OS_EDGE_BINARY_NAME', 'suderra-agent'),
      artifact_format: this.configService.get<string>('SUDERRA_OS_EDGE_ARTIFACT_FORMAT', 'tar.gz'),
      activation_token: variables.provisioningToken,
    };
  }

  /**
   * Build tenant installer URL.
   * SENSOR-MEDIUM-002: the tenant token is NEVER embedded in the path — it
   * travels in the X-Tenant-Provisioning-Token header (see the command below),
   * so it cannot leak into nginx / proxy access logs.
   */
  async buildTenantInstallerUrl(): Promise<string> {
    const config = await this.getProvisioningConfig();
    return `${config.apiBaseUrl}/install/tenant`;
  }

  /**
   * Build tenant installer command. The tenant token is passed as a request
   * header, not a URL path segment.
   */
  async buildTenantInstallerCommand(tenantToken: string): Promise<string> {
    const url = await this.buildTenantInstallerUrl();
    const safeToken = this.sanitizeForShell(tenantToken);
    return `curl -sSL -H "X-Tenant-Provisioning-Token: ${safeToken}" ${url} | sudo bash`;
  }

  /**
   * Render installer script for a specific device (per-device provisioning)
   */
  renderInstallerScript(variables: InstallerScriptVariables, config?: ProvisioningConfig): string {
    const GITHUB_REPO = this.sanitizeForShell(config?.githubRepo || this.configService.get<string>('EDGE_AGENT_GITHUB_REPO', 'Okan-wqm/aquaculture_platform'));
    const now = new Date().toISOString();
    const safeDeviceCode = this.sanitizeForShell(variables.deviceCode);
    const safeAgentVersion = this.sanitizeForShell(this.assertExplicitAgentVersion(variables.agentVersion));
    const safeApiUrl = this.sanitizeForShell(variables.apiUrl);
    const safeDeviceId = this.sanitizeForShell(variables.deviceId);
    const safeProvisioningToken = this.sanitizeForShell(variables.provisioningToken);
    const safeMqttBroker = this.sanitizeForShell(String(variables.mqttBroker ?? ''));
    const safeMqttPort = this.sanitizeForShell(String(variables.mqttPort));
    const mqttTlsEnabled = variables.mqttTlsEnabled ? 'true' : 'false';

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
log "[4/9] Creating configuration..."
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
  tls:
    enabled: ${mqttTlsEnabled}
  keepalive_secs: 60
  clean_session: false

telemetry:
  interval_seconds: 30
  include_cpu: true
  include_memory: true
  include_disk: true
  include_temperature: true

firmware_update:
  mode: disabled

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
      this.renderDisplaySetup() +
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
    const safeAgentVersion = this.sanitizeForShell(this.assertExplicitAgentVersion(variables.agentVersion));
    const safeApiUrl = this.sanitizeForShell(variables.apiUrl);
    const safeTenantToken = this.sanitizeForShell(variables.tenantToken);
    const safeMqttBroker = this.sanitizeForShell(config?.mqttBroker || this.MQTT_BROKER);
    const safeMqttPort = this.sanitizeForShell(String(variables.mqttPort));
    const mqttTlsEnabled = variables.mqttTlsEnabled ? 'true' : 'false';

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
log "[4/9] Creating configuration (self-registration mode)..."
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
  tls:
    enabled: ${mqttTlsEnabled}
  keepalive_secs: 60
  clean_session: false

telemetry:
  interval_seconds: 30
  include_cpu: true
  include_memory: true
  include_disk: true
  include_temperature: true

firmware_update:
  mode: disabled

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
      this.renderDisplaySetup() +
      this.renderStartAndVerify() +
      verifyFooter
    );
  }

  /**
   * Build update URL for a specific device
   */
  async buildUpdateUrl(deviceCode: string): Promise<string> {
    const config = await this.getProvisioningConfig();
    return `${config.apiBaseUrl}/install/${deviceCode}/update`;
  }

  /**
   * Build update command for a specific device
   */
  async buildUpdateCommand(deviceCode: string): Promise<string> {
    const url = await this.buildUpdateUrl(deviceCode);
    return `curl -sSL "${url}" | sudo bash`;
  }

  /**
   * Render update script for upgrading the edge agent in-place
   * Preserves configuration, only replaces the binary.
   */
  renderUpdateScript(deviceCode?: string): string {
    const safeDeviceCode = deviceCode ? this.sanitizeForShell(deviceCode) : '';
    const GITHUB_REPO = this.sanitizeForShell(this.PINNED_GITHUB_REPO);
    const safeAgentVersion = this.sanitizeForShell(this.assertExplicitAgentVersion(this.AGENT_VERSION));
    const now = new Date().toISOString();

    return `#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
#  Suderra Edge Agent Updater
${safeDeviceCode ? `#  Device: ${safeDeviceCode}\n` : ''}#  Generated: ${now}
# ══════════════════════════════════════════════════════════════════════════════

GITHUB_REPO="${GITHUB_REPO}"
AGENT_VERSION="${safeAgentVersion}"
INSTALL_DIR="/opt/suderra"
SERVICE="suderra-agent"
BINARY="$INSTALL_DIR/edge-agent"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

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

WORK_DIR=$(mktemp -d /tmp/suderra-update.XXXXXX)
cleanup() { rm -rf "$WORK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

log "╔══════════════════════════════════════════════════════════════╗"
log "║           Suderra Edge Agent Updater                        ║"
log "╚══════════════════════════════════════════════════════════════╝"

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Prerequisites
# ─────────────────────────────────────────────────────────────────────────────
log "[1/6] Checking prerequisites..."
if [ "$(id -u)" -ne 0 ]; then
    log "ERROR: This script must be run as root"
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    log "ERROR: Agent not installed at $BINARY"
    log "Please run the installer first."
    exit 1
fi

CURRENT_VERSION=$("$BINARY" --version 2>/dev/null || echo "unknown")
log "Current version: $CURRENT_VERSION"

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Detect Architecture
# ─────────────────────────────────────────────────────────────────────────────
log "[2/6] Detecting architecture..."
ARCH=$(uname -m)
case $ARCH in
    x86_64)   TARGET_SLUG="x86_64-linux" ;;
    aarch64)  TARGET_SLUG="aarch64-linux" ;;
    armv7l)   TARGET_SLUG="armv7-linux" ;;
    *)
        log "ERROR: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac
log "Architecture: $ARCH -> $TARGET_SLUG"

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Download Explicit Release
# ─────────────────────────────────────────────────────────────────────────────
log "[3/6] Downloading pinned release from GitHub..."

case "$AGENT_VERSION" in
    agent-v*) ;;
    latest|"")
        log "ERROR: AGENT_VERSION cannot be latest or empty. Use an explicit agent-v<exact Cargo semver> release tag."
        exit 1
        ;;
    *)
        log "ERROR: AGENT_VERSION must use canonical agent-v<exact Cargo semver>, got $AGENT_VERSION"
        exit 1
        ;;
esac
RELEASE_TAG="$AGENT_VERSION"
RELEASE_VERSION="\${AGENT_VERSION#agent-v}"
if ! echo "$RELEASE_VERSION" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'; then
    log "ERROR: AGENT_VERSION must match agent-v<exact Cargo semver>, got $AGENT_VERSION"
    exit 1
fi

log "Release version: $RELEASE_TAG"

# Check if already up to date
if echo "$CURRENT_VERSION" | grep -q "$RELEASE_TAG" 2>/dev/null; then
    log "Agent is already up to date ($CURRENT_VERSION)"
    exit 0
fi

TARBALL="suderra-agent-\${RELEASE_VERSION}-\${TARGET_SLUG}.tar.gz"
CHECKSUM_FILE="\${TARBALL}.sha256"
DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/$RELEASE_TAG/\${TARBALL}"
CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/download/$RELEASE_TAG/\${CHECKSUM_FILE}"

log "Downloading $DOWNLOAD_URL ..."
download_with_retry "$DOWNLOAD_URL" "$WORK_DIR/\${TARBALL}"
download_with_retry "$CHECKSUM_URL" "$WORK_DIR/\${CHECKSUM_FILE}"

# Verify SHA256 checksum
log "Verifying SHA256 checksum..."
if (cd "$WORK_DIR" && sha256sum -c "$CHECKSUM_FILE"); then
    log "Checksum verified"
else
    log "ERROR: Checksum verification failed! Binary may be corrupted."
    exit 1
fi

# Extract to temp
tar -xzf "$WORK_DIR/\${TARBALL}" -C "$WORK_DIR/"

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Stop Service
# ─────────────────────────────────────────────────────────────────────────────
log "[4/6] Stopping agent service..."
if systemctl is-active "$SERVICE" &>/dev/null; then
    systemctl stop "$SERVICE"
    log "Service stopped"
else
    log "Service was not running"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Replace Binary
# ─────────────────────────────────────────────────────────────────────────────
log "[5/6] Updating binary..."

# Backup current binary
cp "$BINARY" "$BINARY.bak"
log "Backed up current binary to $BINARY.bak"

# Replace with new version
cp "$WORK_DIR/edge-agent" "$BINARY"
chmod +x "$BINARY"

NEW_VERSION=$("$BINARY" --version 2>/dev/null || echo "unknown")
log "New version: $NEW_VERSION"

# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Start & Verify
# ─────────────────────────────────────────────────────────────────────────────
log "[6/6] Starting agent service..."
systemctl start "$SERVICE"
sleep 3

STATUS=$(systemctl is-active "$SERVICE")
if [ "$STATUS" = "active" ]; then
    log "Agent is running"
    # Remove backup on success
    rm -f "$BINARY.bak"
else
    log "ERROR: Agent failed to start after update!"
    log "Rolling back to previous version..."
    cp "$BINARY.bak" "$BINARY"
    chmod +x "$BINARY"
    systemctl start "$SERVICE"
    sleep 2
    ROLLBACK_STATUS=$(systemctl is-active "$SERVICE")
    if [ "$ROLLBACK_STATUS" = "active" ]; then
        log "Rollback successful, running previous version"
    else
        log "CRITICAL: Rollback also failed! Check: journalctl -u $SERVICE -n 50"
    fi
    exit 1
fi

log ""
log "══════════════════════════════════════════════════════════════════════════════"
log "                    UPDATE COMPLETE!"
log "══════════════════════════════════════════════════════════════════════════════"
log ""
log "  Previous: $CURRENT_VERSION"
log "  Current:  $NEW_VERSION"
log "  Status:   $STATUS"
log "  Config:   /etc/suderra/config.yaml (preserved)"
log ""
`;
  }

  /**
   * Build uninstall URL for a specific device
   */
  async buildUninstallUrl(deviceCode: string): Promise<string> {
    const config = await this.getProvisioningConfig();
    return `${config.apiBaseUrl}/install/${deviceCode}/uninstall`;
  }

  /**
   * Build uninstall command for a specific device
   */
  async buildUninstallCommand(deviceCode: string): Promise<string> {
    const url = await this.buildUninstallUrl(deviceCode);
    return `curl -sSL "${url}" | sudo bash`;
  }

  /**
   * Render uninstall script for removing the edge agent from a device
   */
  renderUninstallScript(deviceCode?: string): string {
    const safeDeviceCode = deviceCode ? this.sanitizeForShell(deviceCode) : '';
    const now = new Date().toISOString();

    return `#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
#  Suderra Edge Agent Uninstaller
${safeDeviceCode ? `#  Device: ${safeDeviceCode}\n` : ''}#  Generated: ${now}
# ══════════════════════════════════════════════════════════════════════════════

INSTALL_DIR="/opt/suderra"
CONFIG_DIR="/etc/suderra"
DATA_DIR="/var/lib/suderra"
LOG_DIR="/var/log/suderra"
SERVICE="suderra-agent"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

log "╔══════════════════════════════════════════════════════════════╗"
log "║           Suderra Edge Agent Uninstaller                    ║"
log "╚══════════════════════════════════════════════════════════════╝"

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Root Check
# ─────────────────────────────────────────────────────────────────────────────
if [ "$(id -u)" -ne 0 ]; then
    log "ERROR: This script must be run as root"
    exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Stop and Disable Service
# ─────────────────────────────────────────────────────────────────────────────
log "[1/5] Stopping $SERVICE service..."
if systemctl is-active "$SERVICE" &>/dev/null; then
    systemctl stop "$SERVICE"
    log "Service stopped"
else
    log "Service was not running"
fi

if systemctl is-enabled "$SERVICE" &>/dev/null; then
    systemctl disable "$SERVICE"
    log "Service disabled"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Remove Service File
# ─────────────────────────────────────────────────────────────────────────────
log "[2/5] Removing systemd service..."
if [ -f "/etc/systemd/system/$SERVICE.service" ]; then
    rm -f "/etc/systemd/system/$SERVICE.service"
    systemctl daemon-reload
    log "Service file removed and daemon reloaded"
else
    log "Service file not found (already removed)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Remove Files and Directories
# ─────────────────────────────────────────────────────────────────────────────
log "[3/5] Removing files and directories..."

for dir in "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR" "$LOG_DIR"; do
    if [ -d "$dir" ]; then
        rm -rf "$dir"
        log "Removed $dir"
    fi
done

# Remove install log
if [ -f "/var/log/suderra-install.log" ]; then
    rm -f "/var/log/suderra-install.log"
    log "Removed install log"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Remove Service User
# ─────────────────────────────────────────────────────────────────────────────
log "[4/5] Removing suderra user..."
if id suderra &>/dev/null; then
    userdel suderra 2>/dev/null || true
    log "User 'suderra' removed"
else
    log "User 'suderra' not found (already removed)"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Done
# ─────────────────────────────────────────────────────────────────────────────
log "[5/5] Cleanup complete"

log ""
log "══════════════════════════════════════════════════════════════════════════════"
log "                    UNINSTALL COMPLETE!"
log "══════════════════════════════════════════════════════════════════════════════"
log ""
log "  The Suderra Edge Agent has been completely removed from this device."
log "  Removed: binary, config, data, logs, service, and user."
log ""
`;
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
log "[1/9] Checking prerequisites..."
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

# ─────────────────────────────────────────────────────────────────────────────
# Step 1b: Enable Hardware Interfaces (I2C, SPI, UART)
# ─────────────────────────────────────────────────────────────────────────────
log "Enabling hardware interfaces (I2C, SPI, UART)..."

# Install i2c-tools for bus scanning
if ! command -v i2cdetect &>/dev/null; then
    log "Installing i2c-tools..."
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq 2>/dev/null
    apt-get install -y -qq i2c-tools 2>/dev/null && log "i2c-tools installed" || log "WARNING: Could not install i2c-tools"
fi

# Load kernel modules for I2C and SPI
for mod in i2c-dev spidev; do
    modprobe "$mod" 2>/dev/null && log "Loaded $mod module" || true
done

# Ensure modules load on boot
for mod in i2c-dev spidev; do
    if ! grep -q "^$mod" /etc/modules 2>/dev/null; then
        echo "$mod" >> /etc/modules
    fi
done

# Raspberry Pi: enable I2C, SPI, UART in config.txt
NEEDS_REBOOT=false
for cfg in /boot/firmware/config.txt /boot/config.txt; do
    if [ -f "$cfg" ]; then
        log "Configuring hardware interfaces in $cfg..."
        # Enable I2C
        if grep -q "^#.*dtparam=i2c_arm" "$cfg" 2>/dev/null; then
            sed -i 's/^#.*dtparam=i2c_arm.*/dtparam=i2c_arm=on/' "$cfg"
            NEEDS_REBOOT=true
        elif ! grep -q "^dtparam=i2c_arm" "$cfg" 2>/dev/null; then
            echo "dtparam=i2c_arm=on" >> "$cfg"
            NEEDS_REBOOT=true
        fi
        # Enable SPI
        if grep -q "^#.*dtparam=spi" "$cfg" 2>/dev/null; then
            sed -i 's/^#.*dtparam=spi.*/dtparam=spi=on/' "$cfg"
            NEEDS_REBOOT=true
        elif ! grep -q "^dtparam=spi" "$cfg" 2>/dev/null; then
            echo "dtparam=spi=on" >> "$cfg"
            NEEDS_REBOOT=true
        fi
        # Enable UART
        if grep -q "^#.*enable_uart" "$cfg" 2>/dev/null; then
            sed -i 's/^#.*enable_uart.*/enable_uart=1/' "$cfg"
            NEEDS_REBOOT=true
        elif ! grep -q "^enable_uart" "$cfg" 2>/dev/null; then
            echo "enable_uart=1" >> "$cfg"
            NEEDS_REBOOT=true
        fi
        log "Hardware interfaces enabled in $cfg"
        break
    fi
done

# Create spi group if it doesn't exist
if ! getent group spi &>/dev/null; then
    groupadd -r spi 2>/dev/null || true
fi

# Add udev rules for hardware access
cat > /etc/udev/rules.d/99-suderra-hw.rules << 'UDEVEOF'
# Suderra Edge Agent — hardware interface access
SUBSYSTEM=="i2c-dev", GROUP="i2c", MODE="0660"
SUBSYSTEM=="spidev", GROUP="spi", MODE="0660"
KERNEL=="ttyAMA[0-9]*|ttyS[0-9]*|ttyUSB[0-9]*|ttyACM[0-9]*", GROUP="dialout", MODE="0660"
UDEVEOF
udevadm control --reload-rules 2>/dev/null || true
udevadm trigger 2>/dev/null || true

if [ "$NEEDS_REBOOT" = true ]; then
    log "NOTE: Hardware changes require a reboot to take full effect"
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
log "[2/9] Detecting architecture..."
ARCH=$(uname -m)
case $ARCH in
    x86_64)   TARGET_SLUG="x86_64-linux" ;;
    aarch64)  TARGET_SLUG="aarch64-linux" ;;
    armv7l)   TARGET_SLUG="armv7-linux" ;;
    *)
        log "ERROR: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac
log "Architecture: $ARCH -> $TARGET_SLUG"

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
log "[3/9] Downloading pinned edge-agent release from GitHub..."

AGENT_VERSION="${safeAgentVersion}"
case "$AGENT_VERSION" in
    agent-v*) ;;
    latest|"")
        log "ERROR: AGENT_VERSION cannot be latest or empty. Use an explicit agent-v<exact Cargo semver> release tag."
        exit 1
        ;;
    *)
        log "ERROR: AGENT_VERSION must use canonical agent-v<exact Cargo semver>, got $AGENT_VERSION"
        exit 1
        ;;
esac
RELEASE_TAG="$AGENT_VERSION"
RELEASE_VERSION="\${AGENT_VERSION#agent-v}"
if ! echo "$RELEASE_VERSION" | grep -Eq '^[0-9]+[.][0-9]+[.][0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$'; then
    log "ERROR: AGENT_VERSION must match agent-v<exact Cargo semver>, got $AGENT_VERSION"
    exit 1
fi

log "Version: $RELEASE_TAG"

TARBALL="suderra-agent-\${RELEASE_VERSION}-\${TARGET_SLUG}.tar.gz"
CHECKSUM_FILE="\${TARBALL}.sha256"
DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/$RELEASE_TAG/\${TARBALL}"
CHECKSUM_URL="https://github.com/$GITHUB_REPO/releases/download/$RELEASE_TAG/\${CHECKSUM_FILE}"

log "Download URL: $DOWNLOAD_URL"

download_with_retry "$DOWNLOAD_URL" "$WORK_DIR/\${TARBALL}"
download_with_retry "$CHECKSUM_URL" "$WORK_DIR/\${CHECKSUM_FILE}"

# Verify SHA256 checksum
log "Verifying SHA256 checksum..."
if (cd "$WORK_DIR" && sha256sum -c "$CHECKSUM_FILE"); then
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
log "[5/9] Installing systemd service..."

# Create dedicated service user
if ! id suderra &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin suderra
    log "Created suderra service user"
elif [ "$(id -u suderra)" -ge 1000 ]; then
    log "WARNING: suderra user exists as regular user (UID=$(id -u suderra)), securing..."
    usermod --shell /usr/sbin/nologin suderra
fi
for grp in dialout gpio i2c spi; do
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

# Create update helper script
cat > /opt/suderra/suderra-update.sh << 'UPDATEEOF'
#!/bin/bash
set -euo pipefail

# ══════════════════════════════════════════════════════════════════════════════
#  Suderra Edge Agent — Local Update Helper
#  Usage: sudo /opt/suderra/suderra-update.sh /path/to/new/edge-agent
# ══════════════════════════════════════════════════════════════════════════════

INSTALL_DIR="/opt/suderra"
SERVICE="suderra-agent"
BINARY="$INSTALL_DIR/edge-agent"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1"; }

if [ "$(id -u)" -ne 0 ]; then
    log "ERROR: This script must be run as root"
    exit 1
fi

if [ $# -lt 1 ]; then
    log "ERROR: Usage: $0 <path-to-new-binary>"
    exit 1
fi

NEW_BINARY="$1"

if [ ! -f "$NEW_BINARY" ]; then
    log "ERROR: File not found: $NEW_BINARY"
    exit 1
fi

if [ ! -f "$BINARY" ]; then
    log "ERROR: Current binary not found at $BINARY"
    exit 1
fi

CURRENT_VERSION=$("$BINARY" --version 2>/dev/null || echo "unknown")
log "Current version: $CURRENT_VERSION"

# Step 1: Backup current binary
log "Backing up current binary..."
cp "$BINARY" "$BINARY.bak"

# Step 2: Copy new binary
log "Installing new binary..."
cp "$NEW_BINARY" "$BINARY"
chmod +x "$BINARY"

NEW_VERSION=$("$BINARY" --version 2>/dev/null || echo "unknown")
log "New version: $NEW_VERSION"

# Step 3: Restart service
log "Restarting $SERVICE..."
systemctl restart "$SERVICE"
sleep 3

# Step 4: Verify
STATUS=$(systemctl is-active "$SERVICE")
if [ "$STATUS" = "active" ]; then
    log "Agent is running ($NEW_VERSION)"
    rm -f "$BINARY.bak"
    log "Update complete"
else
    log "ERROR: Agent failed to start after update!"
    log "Rolling back to previous version..."
    cp "$BINARY.bak" "$BINARY"
    chmod +x "$BINARY"
    systemctl restart "$SERVICE"
    sleep 2
    ROLLBACK_STATUS=$(systemctl is-active "$SERVICE")
    if [ "$ROLLBACK_STATUS" = "active" ]; then
        log "Rollback successful, running previous version ($CURRENT_VERSION)"
    else
        log "CRITICAL: Rollback also failed! Check: journalctl -u $SERVICE -n 50"
    fi
    exit 1
fi
UPDATEEOF
chmod +x /opt/suderra/suderra-update.sh
log "Update helper installed at /opt/suderra/suderra-update.sh"
`;
  }

  /**
   * Render Step 6: Detect display and install SCADA kiosk (cage + chromium)
   */
  private renderDisplaySetup(): string {
    return `
# ─────────────────────────────────────────────────────────────────────────────
# Step 6: SCADA Display Setup (auto-detect)
# ─────────────────────────────────────────────────────────────────────────────
log "[6/9] Checking for display hardware..."

DISPLAY_DETECTED=false

# Check for DRM/GPU device (HDMI/DSI display connected)
if [ -e /dev/dri/card0 ] || [ -d /sys/class/drm/card0 ]; then
    DISPLAY_DETECTED=true
    log "Display hardware detected (/dev/dri/card0)"
elif ls /sys/class/drm/card*/status 2>/dev/null | xargs grep -l "connected" &>/dev/null; then
    DISPLAY_DETECTED=true
    log "Display hardware detected (DRM connector)"
fi

if [ "$DISPLAY_DETECTED" = "true" ]; then
    log "Installing SCADA display packages..."

    # Install cage (Wayland compositor) and chromium
    apt-get update -qq
    apt-get install -y -qq cage chromium-browser fonts-noto-core 2>/dev/null || \\
    apt-get install -y -qq cage chromium fonts-noto-core 2>/dev/null || \\
    {
        log "WARNING: Could not install display packages (cage/chromium)."
        log "  Display kiosk will not be available."
        log "  You can install manually: apt-get install cage chromium-browser"
        DISPLAY_DETECTED=false
    }
fi

if [ "$DISPLAY_DETECTED" = "true" ]; then
    # Add suderra user to video group for DRM access
    usermod -aG video suderra 2>/dev/null || true
    usermod -aG render suderra 2>/dev/null || true

    # Create SCADA data directory
    mkdir -p /var/lib/suderra/scada
    chown suderra:suderra /var/lib/suderra/scada

    # Install display service
    cat > /etc/systemd/system/suderra-display.service << 'DISPLAYEOF'
[Unit]
Description=Suderra SCADA Display (Kiosk)
Documentation=https://docs.suderra.com/edge/display
After=suderra-agent.service network-online.target
Wants=suderra-agent.service network-online.target
ConditionPathExists=/dev/dri/card0

[Service]
Type=simple
User=suderra
Group=suderra
SupplementaryGroups=video render

# Wayland/DRM environment
RuntimeDirectory=suderra-display
Environment=XDG_RUNTIME_DIR=%t/suderra-display
Environment=WLR_LIBINPUT_NO_DEVICES=1
Environment=WLR_RENDERER=pixman

# Wait for agent HTTP to be ready
ExecStartPre=/bin/bash -c 'for i in $(seq 1 30); do /usr/bin/curl -sf http://localhost:6526/health > /dev/null 2>&1 && exit 0 || sleep 1; done; exit 1'

ExecStart=/usr/bin/cage -s -- chromium-browser \\
    --kiosk \\
    --noerrdialogs \\
    --disable-infobars \\
    --disable-translate \\
    --disable-features=TranslateUI \\
    --disable-session-crashed-bubble \\
    --disable-component-update \\
    --no-first-run \\
    --autoplay-policy=no-user-gesture-required \\
    --disable-pinch \\
    --disable-gpu \\
    --overscroll-history-navigation=0 \\
    --check-for-update-interval=31536000 \\
    --app=http://localhost:6526/scada

Restart=on-failure
RestartSec=5
TimeoutStartSec=60

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=%t/suderra-display /tmp
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictNamespaces=true
LockPersonality=true

# Resource limits
MemoryMax=512M
CPUQuota=80%

[Install]
WantedBy=multi-user.target
DISPLAYEOF

    systemctl daemon-reload
    systemctl enable suderra-display.service
    log "SCADA display service installed and enabled"
    log "  Display will start automatically after agent is ready"
else
    log "No display detected — skipping SCADA kiosk setup"
    log "  To install later: /opt/suderra/setup-display.sh install"
fi
`;
  }

  /**
   * Render Steps 7-9: Start service and verify installation
   */
  private renderStartAndVerify(): string {
    return `
# ─────────────────────────────────────────────────────────────────────────────
# Step 6: Start Service
# ─────────────────────────────────────────────────────────────────────────────
log "[7/9] Starting edge-agent service..."
systemctl daemon-reload
systemctl enable suderra-agent
systemctl start suderra-agent

# Wait for activation
sleep 5

# Start display service if installed
if systemctl list-unit-files suderra-display.service &>/dev/null && systemctl is-enabled suderra-display.service &>/dev/null; then
    log "[8/9] Starting SCADA display service..."
    systemctl start suderra-display.service || log "WARNING: Display service failed to start (agent may still be initializing)"
else
    log "[8/9] No display service installed, skipping..."
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 9: Verify Installation
# ─────────────────────────────────────────────────────────────────────────────
log "[9/9] Verifying installation..."

STATUS=$(systemctl is-active suderra-agent)
if [ "$STATUS" = "active" ]; then
    log "✅ Edge agent is running"
else
    log "❌ Edge agent failed to start"
    log "Check logs: journalctl -u suderra-agent -n 50"
    exit 1
fi

# Check display status
if systemctl is-active suderra-display.service &>/dev/null; then
    log "✅ SCADA display is running (http://localhost:6526/scada)"
elif systemctl is-enabled suderra-display.service &>/dev/null; then
    log "⏳ SCADA display service is enabled but not yet active"
    log "  It will start once the agent is ready and a process is deployed"
fi
`;
  }
}
