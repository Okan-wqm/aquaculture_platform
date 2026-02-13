import { exec } from 'child_process';
import { pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { promises as fs } from 'fs';
import { promisify } from 'util';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { EdgeDevice } from './entities/edge-device.entity';

const execAsync = promisify(exec);

/**
 * MQTT Authentication Service
 *
 * Supports two modes (configured via MQTT_AUTH_MODE env var):
 *
 * 1. "http" (recommended for production) - DB-backed authentication
 *    Mosquitto calls HTTP endpoints (/mqtt/auth, /mqtt/acl, /mqtt/superuser)
 *    Credentials verified against edge_devices.mqtt_password_hash in database
 *    Cross-tenant ACL enforced by matching device's tenant_id against topic
 *    No file I/O, no locks, credentials participate in DB transactions
 *
 * 2. "file" (legacy) - File-based password_file authentication
 *    Credentials written to Mosquitto password file on disk
 *    Requires atomic writes, file locks, and SIGHUP reload
 *    ACL limited to Mosquitto's built-in pattern matching
 *
 * Service accounts (backend_service, sensor_service, alert_service) are
 * verified via environment variable hashes in both modes.
 */
@Injectable()
export class MqttAuthService implements OnModuleInit {
  private readonly logger = new Logger(MqttAuthService.name);

  // Auth mode: "http" (DB-backed) or "file" (legacy file-based)
  private readonly authMode: 'http' | 'file';

  // File-based mode settings (legacy)
  private readonly passwordFilePath: string;
  private readonly fileAuthEnabled: boolean;
  private writeLock: Promise<void> = Promise.resolve();

  // Service account credentials (hashes from env vars)
  private readonly serviceAccounts: Map<string, string> = new Map();

  // Superuser list (service accounts with full topic access)
  private readonly superusers = new Set(['backend_service', 'sensor_service']);

  // PBKDF2 iteration counts per auth mode
  // HTTP mode: Mosquitto never parses the hash - our service verifies it, so use OWASP-recommended count
  // File mode: Mosquitto's password_file parser needs to handle the hash, keep at 101 for compatibility
  private static readonly HTTP_MODE_ITERATIONS = 600_000;
  private static readonly FILE_MODE_ITERATIONS = 101;

  // In-memory cache: mqttClientId → tenantId (prevents N+1 DB queries on ACL checks)
  private readonly tenantIdCache = new Map<string, { tenantId: string; expiresAt: number }>();
  private readonly TENANT_CACHE_TTL_MS = 300_000; // 5 minutes

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(EdgeDevice)
    private readonly deviceRepository: Repository<EdgeDevice>,
  ) {
    this.authMode = this.configService.get<string>('MQTT_AUTH_MODE', 'file') as 'http' | 'file';

    // File-based settings
    this.passwordFilePath = this.configService.get<string>(
      'MOSQUITTO_PASSWORD_FILE',
      'infrastructure/simulators/mosquitto/config/passwd',
    );
    this.fileAuthEnabled = this.configService.get<boolean>('MQTT_AUTH_ENABLED', false);

    // Load service account hashes from env
    const serviceHashes: [string, string | undefined][] = [
      ['backend_service', this.configService.get<string>('MQTT_BACKEND_SERVICE_HASH')],
      ['sensor_service', this.configService.get<string>('MQTT_SENSOR_SERVICE_HASH')],
      ['alert_service', this.configService.get<string>('MQTT_ALERT_SERVICE_HASH')],
    ];
    for (const [name, hash] of serviceHashes) {
      if (hash) this.serviceAccounts.set(name, hash);
    }
  }

  async onModuleInit(): Promise<void> {
    this.logger.log(`MQTT Authentication Service initialized (mode: ${this.authMode})`);

    if (this.authMode === 'file' && this.fileAuthEnabled) {
      try {
        await fs.access(this.passwordFilePath);
        this.logger.debug('Password file accessible');
      } catch {
        this.logger.warn('Password file not found, credentials will not be persisted');
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DB-backed Authentication (HTTP mode)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Verify MQTT credentials against the database.
   * Called by MqttAuthController for HTTP auth backend.
   *
   * Checks service accounts first, then device credentials in DB.
   */
  async verifyDeviceCredentials(username: string, password: string): Promise<boolean> {
    // Check service accounts first
    const serviceHash = this.serviceAccounts.get(username);
    if (serviceHash) {
      return this.verifyPassword(password, serviceHash);
    }

    // Look up device by mqttClientId
    const device = await this.deviceRepository.findOne({
      where: { mqttClientId: username },
      select: ['id', 'mqttPasswordHash', 'lifecycleState'],
    });

    if (!device || !device.mqttPasswordHash) {
      return false;
    }

    // Don't allow revoked/decommissioned devices to connect
    if (device.lifecycleState === 'revoked' || device.lifecycleState === 'decommissioned') {
      this.logger.warn(`MQTT auth rejected for ${username}: device is ${device.lifecycleState}`);
      return false;
    }

    return this.verifyPassword(password, device.mqttPasswordHash);
  }

  /**
   * Check if username is a superuser (bypasses ACL).
   * Service accounts like backend_service and sensor_service are superusers.
   */
  isSuperuser(username: string): boolean {
    return this.superusers.has(username);
  }

  /**
   * Check topic access for a device (cross-tenant ACL enforcement).
   * Called by MqttAuthController for HTTP ACL backend.
   *
   * Topic format: tenants/{tenant_id}/devices/{mqtt_client_id}/...
   * Validates that the device's tenant_id matches the topic's tenant segment.
   *
   * @param username - MQTT username (mqtt_client_id)
   * @param topic - MQTT topic being accessed
   * @param acc - Access type: 1=subscribe, 2=publish
   */
  async checkTopicAccess(username: string, topic: string, acc: number): Promise<boolean> {
    // Superusers bypass ACL
    if (this.isSuperuser(username)) {
      return true;
    }

    // Service accounts with limited access
    if (username === 'alert_service') {
      return this.checkAlertServiceAccess(topic, acc);
    }

    // $SYS/ topics: superusers only (already handled above, deny for regular devices)
    if (topic.startsWith('$SYS/')) {
      return this.isSuperuser(username);
    }

    // Development topics: only allowed in non-production environments
    if (topic.startsWith('test/') || topic.startsWith('debug/')) {
      return this.configService.get('NODE_ENV') !== 'production';
    }

    // Tenant-scoped topics: tenants/{tenant_id}/devices/{device_username}/...
    const tenantTopicMatch = topic.match(/^tenants\/([a-f0-9-]+)\/devices\/([^/]+)\//);
    if (tenantTopicMatch && tenantTopicMatch[1] && tenantTopicMatch[2]) {
      const topicTenantId = tenantTopicMatch[1];
      const topicDeviceId = tenantTopicMatch[2];

      // Device can only access its own device namespace
      if (topicDeviceId !== username) {
        return false;
      }

      // Verify the tenant_id in the topic matches the device's actual tenant
      const deviceTenantId = await this.getDeviceTenantId(username);

      if (!deviceTenantId) {
        return false;
      }

      // Timing-safe comparison of tenant IDs to prevent timing attacks
      const topicTenantHash = createHash('sha256').update(topicTenantId).digest();
      const deviceTenantHash = createHash('sha256').update(deviceTenantId).digest();
      return timingSafeEqual(topicTenantHash, deviceTenantHash);
    }

    // Legacy edge topics: edge/{device_username}/...
    if (topic.startsWith('edge/')) {
      const legacyMatch = topic.match(/^edge\/([^/]+)\//);
      return legacyMatch !== null && legacyMatch[1] === username;
    }

    // Deny everything else
    return false;
  }

  /**
   * Check alert_service specific access rules
   */
  private checkAlertServiceAccess(topic: string, acc: number): boolean {
    // Read sensor and edge data
    if ((topic.startsWith('sensor/') || topic.startsWith('edge/')) && acc === 1) {
      return true;
    }
    // Write alerts
    if (topic.startsWith('alerts/') && acc === 2) {
      return true;
    }
    return false;
  }

  /**
   * Look up a device's tenantId, using an in-memory cache to avoid repeated DB queries.
   * ACL checks happen on every PUBLISH/SUBSCRIBE, so caching is critical.
   */
  private async getDeviceTenantId(username: string): Promise<string | null> {
    const now = Date.now();
    const cached = this.tenantIdCache.get(username);
    if (cached && now < cached.expiresAt) {
      return cached.tenantId;
    }

    const device = await this.deviceRepository.findOne({
      where: { mqttClientId: username },
      select: ['tenantId'],
    });

    if (!device?.tenantId) {
      // Remove stale cache entry if device no longer exists
      this.tenantIdCache.delete(username);
      return null;
    }

    this.tenantIdCache.set(username, {
      tenantId: device.tenantId,
      expiresAt: now + this.TENANT_CACHE_TTL_MS,
    });

    return device.tenantId;
  }

  /**
   * Invalidate the tenant cache for a device (call when device is revoked/decommissioned).
   */
  invalidateTenantCache(username: string): void {
    this.tenantIdCache.delete(username);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Credential Generation & Verification (shared by both modes)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate MQTT credentials for a device.
   * Returns the plain password (to send to agent) and hash (to store in DB).
   */
  generateCredentials(): { password: string; hash: string } {
    const password = randomBytes(16).toString('base64');
    const iterations = this.authMode === 'http'
      ? MqttAuthService.HTTP_MODE_ITERATIONS
      : MqttAuthService.FILE_MODE_ITERATIONS;
    const hash = this.hashPassword(password, iterations);
    return { password, hash };
  }

  /**
   * Hash a password using PBKDF2-SHA512 (Mosquitto $7$ format).
   * Format: $7$iterations$base64salt$base64hash
   */
  hashPassword(password: string, iterations: number = MqttAuthService.FILE_MODE_ITERATIONS): string {
    const salt = randomBytes(12);
    const keyLength = 24;
    const derivedKey = pbkdf2Sync(password, salt, iterations, keyLength, 'sha512');
    return `$7$${iterations}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
  }

  /**
   * Verify a password against a PBKDF2-SHA512 hash.
   * Uses timing-safe comparison to prevent timing attacks.
   */
  verifyPassword(password: string, hash: string): boolean {
    try {
      const parts = hash.split('$');
      if (parts.length !== 5 || parts[1] !== '7') {
        return false;
      }

      const iterationsStr = parts[2];
      const saltStr = parts[3];
      const hashStr = parts[4];

      if (!iterationsStr || !saltStr || !hashStr) {
        return false;
      }

      const iterations = parseInt(iterationsStr, 10);
      const salt = Buffer.from(saltStr, 'base64');
      const expectedHash = Buffer.from(hashStr, 'base64');

      const derivedKey = pbkdf2Sync(password, salt, iterations, expectedHash.length, 'sha512');

      // Timing-safe comparison
      return timingSafeEqual(derivedKey, expectedHash);
    } catch (error) {
      this.logger.error('Error verifying password:', error);
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // File-based Operations (legacy mode - used when MQTT_AUTH_MODE=file)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Add device credentials.
   * In HTTP mode: no-op (credentials stored in DB only).
   * In file mode: writes to Mosquitto password file.
   */
  async addDeviceCredentials(username: string, passwordHash: string): Promise<boolean> {
    if (this.authMode === 'http') {
      // In HTTP mode, credentials are stored in edge_devices table
      // Mosquitto verifies via HTTP callbacks to /mqtt/auth
      this.logger.debug(`MQTT credentials stored in DB for: ${username} (HTTP auth mode)`);
      return true;
    }

    // Legacy file-based mode
    return new Promise<boolean>((resolve, reject) => {
      this.writeLock = this.writeLock.then(async () => {
        try {
          const result = await this._addDeviceCredentialsFile(username, passwordHash);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Remove device credentials.
   * In HTTP mode: no-op (handled by DB state change).
   * In file mode: removes from Mosquitto password file.
   */
  async removeDeviceCredentials(username: string): Promise<boolean> {
    if (this.authMode === 'http') {
      this.logger.debug(`MQTT credentials removed from DB for: ${username} (HTTP auth mode)`);
      return true;
    }

    return new Promise<boolean>((resolve, reject) => {
      this.writeLock = this.writeLock.then(async () => {
        try {
          const result = await this._removeDeviceCredentialsFile(username);
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
    });
  }

  /**
   * Check if device credentials exist.
   * In HTTP mode: checks the database.
   * In file mode: checks the password file.
   */
  async hasCredentials(username: string): Promise<boolean> {
    if (this.authMode === 'http') {
      const device = await this.deviceRepository.findOne({
        where: { mqttClientId: username },
        select: ['id', 'mqttPasswordHash'],
      });
      return !!device?.mqttPasswordHash;
    }

    // Legacy file mode
    if (!this.fileAuthEnabled) return false;
    try {
      const content = await fs.readFile(this.passwordFilePath, 'utf-8');
      return content.split('\n').some((line) => {
        if (line.startsWith('#') || !line.trim()) return false;
        const colonIndex = line.indexOf(':');
        return colonIndex > 0 && line.substring(0, colonIndex) === username;
      });
    } catch {
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // File-based internal methods (legacy)
  // ─────────────────────────────────────────────────────────────────────────

  private async _addDeviceCredentialsFile(username: string, passwordHash: string): Promise<boolean> {
    if (!this.fileAuthEnabled) {
      this.logger.debug('MQTT file auth disabled, skipping credential storage');
      return true;
    }

    try {
      let content = '';
      try {
        content = await fs.readFile(this.passwordFilePath, 'utf-8');
      } catch {
        content = '';
      }

      const lines = content.split('\n').filter((line) => line.trim() && !line.startsWith('#'));
      const entries = new Map<string, string>();

      for (const line of lines) {
        const colonIndex = line.indexOf(':');
        if (colonIndex > 0) {
          entries.set(line.substring(0, colonIndex), line.substring(colonIndex + 1));
        }
      }

      entries.set(username, passwordHash);

      const header = `# ============================================\n# Mosquitto Password File\n# ============================================\n# Auto-generated - do not edit manually\n# Edge device credentials managed by sensor-service\n# ============================================\n\n`;

      const serviceAccountLines: string[] = [];
      for (const [name, hash] of this.serviceAccounts) {
        serviceAccountLines.push(`${name}:${hash}`);
      }
      const serviceSection = serviceAccountLines.length > 0
        ? `# Service Accounts\n${serviceAccountLines.join('\n')}\n\n# Edge Device Accounts\n`
        : '# Edge Device Accounts\n';

      const deviceEntries: string[] = [];
      for (const [user, hash] of entries) {
        if (!this.serviceAccounts.has(user)) {
          deviceEntries.push(`${user}:${hash}`);
        }
      }

      const newContent = header + serviceSection + deviceEntries.join('\n') + '\n';

      // Atomic write: temp file → fsync → rename
      const tmpPath = this.passwordFilePath + '.tmp';
      await fs.writeFile(tmpPath, newContent, 'utf-8');
      const fileHandle = await fs.open(tmpPath, 'r');
      await fileHandle.datasync();
      await fileHandle.close();
      await fs.rename(tmpPath, this.passwordFilePath);

      this.logger.log(`Added MQTT credentials for device: ${username}`);
      await this.reloadMosquitto();
      return true;
    } catch (error) {
      this.logger.error(`Failed to add MQTT credentials for ${username}:`, error);
      return false;
    }
  }

  private async _removeDeviceCredentialsFile(username: string): Promise<boolean> {
    if (!this.fileAuthEnabled) return true;

    try {
      let content = await fs.readFile(this.passwordFilePath, 'utf-8');
      const lines = content.split('\n');

      const filteredLines = lines.filter((line) => {
        if (!line.trim() || line.startsWith('#')) return true;
        const colonIndex = line.indexOf(':');
        return colonIndex > 0 ? line.substring(0, colonIndex) !== username : true;
      });

      content = filteredLines.join('\n');

      const tmpPath = this.passwordFilePath + '.tmp';
      await fs.writeFile(tmpPath, content, 'utf-8');
      const fileHandle = await fs.open(tmpPath, 'r');
      await fileHandle.datasync();
      await fileHandle.close();
      await fs.rename(tmpPath, this.passwordFilePath);

      this.logger.log(`Removed MQTT credentials for device: ${username}`);
      await this.reloadMosquitto();
      return true;
    } catch (error) {
      this.logger.error(`Failed to remove MQTT credentials for ${username}:`, error);
      return false;
    }
  }

  private async reloadMosquitto(): Promise<boolean> {
    try {
      try {
        await execAsync('kill -HUP $(pidof mosquitto) 2>/dev/null || true', { timeout: 5000 });
        this.logger.log('Mosquitto reload signal sent');
      } catch {
        try {
          await execAsync('docker exec mosquitto kill -HUP 1 2>/dev/null || true', { timeout: 5000 });
          this.logger.log('Mosquitto reload signal sent via Docker');
        } catch {
          this.logger.warn('Could not reload Mosquitto - may need manual restart');
        }
      }
      return true;
    } catch (error) {
      this.logger.warn(`Mosquitto reload failed: ${error instanceof Error ? error.message : 'unknown'}`);
      return false;
    }
  }
}
