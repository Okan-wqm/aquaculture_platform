import { randomBytes } from 'crypto';

import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  CreateProvisionedDeviceInput,
  ProvisionedDeviceResponse,
  RegenerateTokenResponse,
  DeviceActivationRequest,
  DeviceActivationResponse,
  ActivationErrorCode,
  InstallerScriptVariables,
} from './dto/provisioning.dto';
import {
  EdgeDevice,
  DeviceLifecycleState,
  DeviceModel,
} from './entities/edge-device.entity';
import { MqttAuthService } from './mqtt-auth.service';

/**
 * Provisioning Service
 * Handles zero-touch device provisioning workflow
 */
@Injectable()
export class ProvisioningService {
  private readonly logger = new Logger(ProvisioningService.name);
  private readonly TOKEN_TTL_HOURS: number;
  private readonly API_BASE_URL: string;
  private readonly AGENT_VERSION: string;
  private readonly MQTT_BROKER: string;
  private readonly MQTT_PORT: number;

  constructor(
    @InjectRepository(EdgeDevice)
    private readonly deviceRepository: Repository<EdgeDevice>,
    private readonly configService: ConfigService,
    private readonly mqttAuthService: MqttAuthService,
  ) {
    this.TOKEN_TTL_HOURS = this.configService.get<number>('PROVISIONING_TOKEN_TTL_HOURS', 24);
    this.API_BASE_URL = this.configService.get<string>('PROVISIONING_API_BASE_URL', 'http://localhost:3000');
    this.AGENT_VERSION = this.configService.get<string>('AGENT_VERSION', '1.0.0');
    this.MQTT_BROKER = this.configService.get<string>('MQTT_BROKER_HOST', 'localhost');
    this.MQTT_PORT = this.configService.get<number>('MQTT_BROKER_PORT', 1883);
  }

  /**
   * Generate a cryptographically secure provisioning token
   */
  generateProvisioningToken(): string {
    return randomBytes(32).toString('hex');
  }

  /**
   * Generate device code from model and random suffix
   */
  generateDeviceCode(model?: DeviceModel): string {
    const prefix = this.getDeviceCodePrefix(model);
    const suffix = randomBytes(4).toString('hex').toUpperCase();
    return `${prefix}-${suffix}`;
  }

  /**
   * Get device code prefix based on model
   */
  private getDeviceCodePrefix(model?: DeviceModel): string {
    switch (model) {
      case DeviceModel.REVOLUTION_PI_CONNECT_4:
      case DeviceModel.REVOLUTION_PI_COMPACT:
        return 'RPI';
      case DeviceModel.RASPBERRY_PI_4:
      case DeviceModel.RASPBERRY_PI_5:
        return 'PI';
      case DeviceModel.INDUSTRIAL_PC:
        return 'IPC';
      default:
        return 'EDGE';
    }
  }

  /**
   * Create a new device with provisioning token
   */
  async createProvisionedDevice(
    tenantId: string,
    input: CreateProvisionedDeviceInput,
    createdBy?: string,
  ): Promise<ProvisionedDeviceResponse> {
    // Generate unique device code
    let deviceCode = this.generateDeviceCode(input.deviceModel);

    // Ensure device code is unique
    let attempts = 0;
    while (await this.deviceRepository.findOne({ where: { deviceCode } })) {
      deviceCode = this.generateDeviceCode(input.deviceModel);
      attempts++;
      if (attempts > 10) {
        throw new ConflictException('Unable to generate unique device code');
      }
    }

    // Generate provisioning token
    const provisioningToken = this.generateProvisioningToken();
    const tokenExpiresAt = new Date(Date.now() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000);

    // Generate MQTT client ID
    const mqttClientId = `edge-${tenantId.substring(0, 8)}-${deviceCode}`.toLowerCase();

    // Create device
    const device = this.deviceRepository.create({
      tenantId,
      deviceCode,
      deviceName: input.deviceName || deviceCode,
      deviceModel: input.deviceModel || DeviceModel.CUSTOM,
      serialNumber: input.serialNumber,
      description: input.description,
      siteId: input.siteId,
      lifecycleState: DeviceLifecycleState.REGISTERED,
      provisioningToken,
      tokenExpiresAt,
      mqttClientId,
      isOnline: false,
      securityLevel: 2,
      createdBy,
    });

    const saved = await this.deviceRepository.save(device);
    this.logger.log(`Created provisioned device ${deviceCode} for tenant ${tenantId}`);

    return this.buildProvisioningResponse(saved, provisioningToken);
  }

  /**
   * Regenerate provisioning token for an existing device
   */
  async regenerateToken(
    deviceId: string,
    tenantId: string,
  ): Promise<RegenerateTokenResponse> {
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId, tenantId },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceId} not found`);
    }

    // Only allow regeneration for devices that haven't been activated
    if (device.tokenUsedAt) {
      throw new ConflictException('Cannot regenerate token for already activated device');
    }

    // Don't allow regeneration for decommissioned devices
    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      throw new BadRequestException('Cannot regenerate token for decommissioned device');
    }

    // Generate new token
    const provisioningToken = this.generateProvisioningToken();
    const tokenExpiresAt = new Date(Date.now() + this.TOKEN_TTL_HOURS * 60 * 60 * 1000);

    device.provisioningToken = provisioningToken;
    device.tokenExpiresAt = tokenExpiresAt;

    const saved = await this.deviceRepository.save(device);
    this.logger.log(`Regenerated token for device ${device.deviceCode}`);

    return {
      deviceId: saved.id,
      deviceCode: saved.deviceCode,
      installerUrl: this.buildInstallerUrl(saved.deviceCode),
      installerCommand: this.buildInstallerCommand(saved.deviceCode),
      tokenExpiresAt,
    };
  }

  /**
   * Generate installer script for a device
   */
  async generateInstallerScript(deviceCode: string): Promise<string> {
    // Find device by code (cross-tenant lookup for public endpoint)
    const device = await this.deviceRepository.findOne({
      where: { deviceCode },
    });

    if (!device) {
      throw new NotFoundException(`Device ${deviceCode} not found`);
    }

    // Check if token is valid
    if (!device.provisioningToken) {
      throw new BadRequestException('Device has no provisioning token');
    }

    if (device.tokenUsedAt) {
      throw new ConflictException('Device has already been activated');
    }

    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      throw new UnauthorizedException('Provisioning token has expired');
    }

    const variables: InstallerScriptVariables = {
      deviceId: device.id,
      deviceCode: device.deviceCode,
      provisioningToken: device.provisioningToken,
      apiUrl: this.API_BASE_URL,
      agentVersion: this.AGENT_VERSION,
      mqttBroker: this.MQTT_BROKER,
      mqttPort: this.MQTT_PORT,
    };

    return this.renderInstallerScript(variables);
  }

  /**
   * Activate a device (called by agent)
   */
  async activateDevice(
    request: DeviceActivationRequest,
  ): Promise<DeviceActivationResponse> {
    const { deviceId, token, fingerprint, agentVersion } = request;

    // Find device
    const device = await this.deviceRepository.findOne({
      where: { id: deviceId },
    });

    if (!device) {
      this.logger.warn(`Activation failed: device ${deviceId} not found`);
      throw new NotFoundException({
        success: false,
        error: 'Device not found',
        errorCode: ActivationErrorCode.DEVICE_NOT_FOUND,
      });
    }

    // Check if device is decommissioned
    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      throw new BadRequestException({
        success: false,
        error: 'Device has been decommissioned',
        errorCode: ActivationErrorCode.DEVICE_DECOMMISSIONED,
      });
    }

    // Check if token is already used
    if (device.tokenUsedAt) {
      this.logger.warn(`Activation failed: token already used for device ${device.deviceCode}`);
      throw new ConflictException({
        success: false,
        error: 'Device has already been activated',
        errorCode: ActivationErrorCode.TOKEN_ALREADY_USED,
      });
    }

    // Validate token
    if (!device.provisioningToken || device.provisioningToken !== token) {
      this.logger.warn(`Activation failed: invalid token for device ${device.deviceCode}`);
      throw new UnauthorizedException({
        success: false,
        error: 'Invalid provisioning token',
        errorCode: ActivationErrorCode.INVALID_TOKEN,
      });
    }

    // Check token expiry
    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      this.logger.warn(`Activation failed: token expired for device ${device.deviceCode}`);
      throw new UnauthorizedException({
        success: false,
        error: 'Provisioning token has expired',
        errorCode: ActivationErrorCode.TOKEN_EXPIRED,
      });
    }

    // Generate MQTT credentials
    const { password: mqttPassword, hash: mqttPasswordHash } = this.generateMqttCredentials();

    // Update device
    device.tokenUsedAt = new Date();
    device.fingerprint = fingerprint;
    device.agentVersion = agentVersion;
    device.mqttPasswordHash = mqttPasswordHash;
    device.lifecycleState = DeviceLifecycleState.PROVISIONING;
    device.isOnline = false; // Will be set to true when MQTT heartbeat arrives

    // Clear the token from database (single-use)
    device.provisioningToken = undefined;

    await this.deviceRepository.save(device);

    // Add MQTT credentials to password file (for Mosquitto auth)
    const mqttClientId = device.mqttClientId ?? '';
    await this.mqttAuthService.addDeviceCredentials(mqttClientId, mqttPasswordHash);

    this.logger.log(`Device ${device.deviceCode} activated successfully`);

    // Return snake_case response (v1.1 spec)
    return {
      success: true,
      mqtt_broker: this.MQTT_BROKER,
      mqtt_port: this.MQTT_PORT,
      mqtt_username: mqttClientId,
      mqtt_password: mqttPassword,
      tenant_id: device.tenantId,
      device_code: device.deviceCode,
      config: device.config,
    };
  }

  /**
   * Generate MQTT credentials for a device
   * Uses MqttAuthService for consistent password hashing
   */
  generateMqttCredentials(): { password: string; hash: string } {
    return this.mqttAuthService.generateCredentials();
  }

  /**
   * Build installer URL
   */
  private buildInstallerUrl(deviceCode: string): string {
    return `${this.API_BASE_URL}/install/${deviceCode}`;
  }

  /**
   * Build installer command
   */
  private buildInstallerCommand(deviceCode: string): string {
    return `curl -sSL ${this.buildInstallerUrl(deviceCode)} | sudo sh`;
  }

  /**
   * Build provisioning response
   */
  private buildProvisioningResponse(
    device: EdgeDevice,
    token: string,
  ): ProvisionedDeviceResponse {
    return {
      deviceId: device.id,
      deviceCode: device.deviceCode,
      installerUrl: this.buildInstallerUrl(device.deviceCode),
      installerCommand: this.buildInstallerCommand(device.deviceCode),
      tokenExpiresAt: device.tokenExpiresAt!,
      status: device.lifecycleState,
    };
  }

  /**
   * Render installer script from template
   * Downloads edge-agent from GitHub Releases
   */
  private renderInstallerScript(variables: InstallerScriptVariables): string {
    const GITHUB_REPO = this.configService.get<string>('EDGE_AGENT_GITHUB_REPO', 'Okan-wqm/sens');
    const now = new Date().toISOString();

    return `#!/bin/bash
set -e

# ══════════════════════════════════════════════════════════════════════════════
#  Suderra Edge Agent Installer v2.0
#  Device: ${variables.deviceCode}
#  Generated: ${now}
# ══════════════════════════════════════════════════════════════════════════════

GITHUB_REPO="${GITHUB_REPO}"
INSTALL_DIR="/opt/suderra"
CONFIG_DIR="/etc/suderra"
DATA_DIR="/var/lib/suderra"
LOG_FILE="/var/log/suderra-install.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

log "╔══════════════════════════════════════════════════════════════╗"
log "║           Suderra Edge Agent Installer v2.0                  ║"
log "║              Device: ${variables.deviceCode}                              ║"
log "╚══════════════════════════════════════════════════════════════╝"

# ─────────────────────────────────────────────────────────────────────────────
# Step 1: Prerequisites
# ─────────────────────────────────────────────────────────────────────────────
log "[1/7] Checking prerequisites..."
if [ "$(id -u)" -ne 0 ]; then
    log "ERROR: This script must be run as root"
    exit 1
fi

if ! command -v curl &> /dev/null; then
    log "Installing curl..."
    apt-get update && apt-get install -y curl
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 2: Detect Architecture
# ─────────────────────────────────────────────────────────────────────────────
log "[2/7] Detecting architecture..."
ARCH=$(uname -m)
case $ARCH in
    x86_64)   BINARY_NAME="edge-agent-x86_64-unknown-linux-gnu"  ;;
    aarch64)  BINARY_NAME="edge-agent-aarch64-unknown-linux-gnu" ;;
    armv7l)   BINARY_NAME="edge-agent-armv7-unknown-linux-gnueabihf" ;;
    *)
        log "ERROR: Unsupported architecture: $ARCH"
        exit 1
        ;;
esac
log "Architecture: $ARCH -> $BINARY_NAME"

# ─────────────────────────────────────────────────────────────────────────────
# Step 3: Download from GitHub Releases
# ─────────────────────────────────────────────────────────────────────────────
log "[3/7] Downloading edge-agent from GitHub..."

# Get latest release tag
LATEST_TAG=$(curl -s "https://api.github.com/repos/$GITHUB_REPO/releases/latest" | grep '"tag_name"' | cut -d '"' -f 4)

if [ -z "$LATEST_TAG" ]; then
    log "WARNING: Could not get latest release, using 'latest'"
    LATEST_TAG="latest"
fi

log "Latest version: $LATEST_TAG"

DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/$LATEST_TAG/$BINARY_NAME"
log "Download URL: $DOWNLOAD_URL"

mkdir -p "$INSTALL_DIR"
curl -L --progress-bar -o "$INSTALL_DIR/edge-agent" "$DOWNLOAD_URL"
chmod +x "$INSTALL_DIR/edge-agent"

# Verify binary
if ! "$INSTALL_DIR/edge-agent" --version &> /dev/null; then
    log "WARNING: Could not verify binary version"
else
    VERSION=$("$INSTALL_DIR/edge-agent" --version 2>/dev/null || echo "unknown")
    log "Installed version: $VERSION"
fi

# ─────────────────────────────────────────────────────────────────────────────
# Step 4: Create Configuration
# ─────────────────────────────────────────────────────────────────────────────
log "[4/7] Creating configuration..."
mkdir -p "$CONFIG_DIR"
mkdir -p "$DATA_DIR"

cat > "$CONFIG_DIR/config.yaml" << 'CONFIGEOF'
# Suderra Edge Agent Configuration
# Generated: ${now}

device_id: "${variables.deviceId}"
device_code: "${variables.deviceCode}"
api_url: "${variables.apiUrl}"
provisioning_token: "${variables.provisioningToken}"

mqtt:
  port: ${variables.mqttPort}
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

# ─────────────────────────────────────────────────────────────────────────────
# Step 5: Create Systemd Service
# ─────────────────────────────────────────────────────────────────────────────
log "[5/7] Installing systemd service..."

cat > /etc/systemd/system/suderra-agent.service << 'SERVICEEOF'
[Unit]
Description=Suderra Edge Agent
Documentation=https://docs.suderra.com/edge-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
ExecStart=/opt/suderra/edge-agent
Restart=always
RestartSec=10
WatchdogSec=120

# Environment
Environment="RUST_LOG=info"
Environment="SUDERRA_DATA_DIR=/var/lib/suderra"

# Security hardening
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/suderra /etc/suderra /var/log
NoNewPrivileges=true

# Resource limits
LimitNOFILE=65536
MemoryMax=256M
CPUQuota=50%

[Install]
WantedBy=multi-user.target
SERVICEEOF

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

log ""
log "══════════════════════════════════════════════════════════════════════════════"
log "                    INSTALLATION COMPLETE!"
log "══════════════════════════════════════════════════════════════════════════════"
log ""
log "  Device Code:    ${variables.deviceCode}"
log "  Service Status: $STATUS"
log "  Config File:    $CONFIG_DIR/config.yaml"
log "  Log Command:    journalctl -u suderra-agent -f"
log ""
log "  The device will appear online in the dashboard within 30 seconds."
log ""
`;
  }

  /**
   * Get device by code (for installer endpoint)
   */
  async getDeviceByCode(deviceCode: string): Promise<EdgeDevice | null> {
    return this.deviceRepository.findOne({
      where: { deviceCode },
    });
  }

  /**
   * Check if device is ready for activation
   */
  async isDeviceReadyForActivation(deviceCode: string): Promise<{
    ready: boolean;
    reason?: string;
    errorCode?: ActivationErrorCode;
  }> {
    const device = await this.getDeviceByCode(deviceCode);

    if (!device) {
      return { ready: false, reason: 'Device not found', errorCode: ActivationErrorCode.DEVICE_NOT_FOUND };
    }

    if (device.lifecycleState === DeviceLifecycleState.DECOMMISSIONED) {
      return { ready: false, reason: 'Device decommissioned', errorCode: ActivationErrorCode.DEVICE_DECOMMISSIONED };
    }

    if (device.tokenUsedAt) {
      return { ready: false, reason: 'Already activated', errorCode: ActivationErrorCode.TOKEN_ALREADY_USED };
    }

    if (!device.provisioningToken) {
      return { ready: false, reason: 'No token', errorCode: ActivationErrorCode.INVALID_TOKEN };
    }

    if (device.tokenExpiresAt && device.tokenExpiresAt < new Date()) {
      return { ready: false, reason: 'Token expired', errorCode: ActivationErrorCode.TOKEN_EXPIRED };
    }

    return { ready: true };
  }
}
