import { execFile } from 'child_process';
import { pbkdf2Sync, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { promises as fs } from 'fs';
import { promisify } from 'util';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { getTenantSchemaName } from '@aquaculture/backend-common/database';

import { DeviceDirectoryService } from './device-directory.service';
import { EdgeDevice } from './entities/edge-device.entity';

const execFileAsync = promisify(execFile);

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

  // Service accounts with per-topic-pattern grants (no superuser access)
  private readonly serviceAccountNames = new Set(['backend_service', 'sensor_service', 'alert_service']);

  // PBKDF2 iteration counts per auth mode
  // HTTP mode: Mosquitto never parses the hash - our service verifies it, so use OWASP-recommended count
  // File mode: Mosquitto's password_file parser needs to handle the hash, keep at 101 for compatibility
  private static readonly HTTP_MODE_ITERATIONS = 600_000;
  private static readonly FILE_MODE_ITERATIONS = 101;

  // In-memory cache: mqttClientId → tenantId (prevents N+1 DB queries on ACL checks)
  // Max 10,000 entries with LRU-style eviction to prevent unbounded memory growth (LOW-02)
  private readonly tenantIdCache = new Map<string, { tenantId: string; expiresAt: number }>();
  private readonly TENANT_CACHE_TTL_MS = 300_000; // 5 minutes
  private static readonly TENANT_CACHE_MAX_SIZE = 10_000;

  // SENSOR-MEDIUM-004: negative-result cache for cross-schema device lookups.
  // A lookup that misses BOTH the O(1) directory and the fallback UNION-ALL scan
  // is recorded here (keyed `${column}:${value}`) for a short window, so a flood
  // of the same unknown identifier is not re-scanned across every tenant schema.
  // It lives in findDeviceAcrossSchemas so EVERY public entry point benefits —
  // the unauthenticated verifyDeviceCredentials (MQTT CONNECT) and the ACL
  // own-device check, not just getDeviceTenantId. Short TTL so a freshly
  // provisioned device becomes resolvable quickly; bounded with LRU eviction so
  // the flood cannot itself grow memory unboundedly.
  private readonly negativeLookupCache = new Map<string, number>(); // `${column}:${value}` → expiresAt
  private readonly NEGATIVE_LOOKUP_CACHE_TTL_MS = 30_000; // 30 seconds
  private static readonly NEGATIVE_LOOKUP_CACHE_MAX_SIZE = 10_000;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(EdgeDevice)
    private readonly deviceRepository: Repository<EdgeDevice>,
    private readonly dataSource: DataSource,
    private readonly deviceDirectory: DeviceDirectoryService,
  ) {
    // SENSOR-LOW-008: default to the DB-backed HTTP backend. File mode hashes
    // at only 101 PBKDF2 iterations (Mosquitto password_file parser limit),
    // orders of magnitude below OWASP guidance; HTTP mode uses 600k. Secure by
    // default (Tier-2) — legacy file mode must now be opted into explicitly.
    this.authMode = this.configService.get<string>('MQTT_AUTH_MODE', 'http') as 'http' | 'file';

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
    // SENSOR-LOW-008: fail closed on weak legacy file mode in production. The
    // 101-iteration file-mode hash is unacceptable for a production trust
    // boundary; starting in it must be an explicit, audited operator decision
    // (MQTT_ALLOW_LEGACY_FILE_MODE=true) during a migration window, never a
    // silent default.
    const isProduction = this.configService.get<string>('NODE_ENV') === 'production';
    const legacyFileModeAllowed =
      this.configService.get<string>('MQTT_ALLOW_LEGACY_FILE_MODE') === 'true';
    if (isProduction && this.authMode === 'file' && !legacyFileModeAllowed) {
      throw new Error(
        'SECURITY: MQTT_AUTH_MODE=file uses 101 PBKDF2 iterations and is refused in ' +
          'production. Use the DB-backed HTTP backend (MQTT_AUTH_MODE=http), or set ' +
          'MQTT_ALLOW_LEGACY_FILE_MODE=true to opt into the legacy mode for a migration window.',
      );
    }

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

    // Look up device by mqttClientId across all tenant schemas
    const device = await this.findDeviceAcrossSchemas('mqtt_client_id', username);

    if (!device) {
      this.logger.debug(`MQTT auth: device not found for ${username}`);
      return false;
    }
    if (!device.mqttPasswordHash) {
      this.logger.debug(`MQTT auth: no password hash for ${username} (state=${device.lifecycleState})`);
      return false;
    }

    // Don't allow revoked/decommissioned devices to connect
    if (device.lifecycleState === 'revoked' || device.lifecycleState === 'decommissioned') {
      this.logger.warn(`MQTT auth rejected for ${username}: device is ${device.lifecycleState}`);
      return false;
    }

    const valid = this.verifyPassword(password, device.mqttPasswordHash);
    if (!valid) {
      this.logger.debug(`MQTT auth: password mismatch for ${username} (state=${device.lifecycleState})`);
    }
    return valid;
  }

  /**
   * Check if username is a superuser.
   * Always returns false — no accounts bypass ACL.
   * All service accounts use per-topic-pattern grants instead.
   */
  isSuperuser(_username: string): boolean {
    return false;
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
   * @param acc - Access type: 1=read, 2=write/publish, 4=subscribe (MOSQ_ACL_SUBSCRIBE)
   */
  async checkTopicAccess(username: string, topic: string, acc: number): Promise<boolean> {
    // Service accounts: per-topic-pattern grants scoped to tenants. Handled
    // first so their intentional wildcard subscribe patterns still work.
    if (this.serviceAccountNames.has(username)) {
      return this.checkServiceAccountAccess(username, topic, acc);
    }

    // SENSOR-MEDIUM-005: subscribe (acc=4) is NO LONGER blanket-allowed for
    // device accounts. It flows through the same tenant-topic verification as
    // read (acc=1), so a device can only subscribe within its own
    // `tenants/{ownTenant}/devices/{ownDevice}/...` namespace. An over-broad
    // or cross-tenant filter (e.g. `tenants/+/devices/#`) fails the concrete
    // tenant/device match below and is denied — enforcement no longer depends
    // solely on the broker re-running the per-message read ACL.

    // $SYS/ topics: deny for all non-service accounts
    if (topic.startsWith('$SYS/')) {
      return false;
    }

    // Development topics: only allowed in non-production environments
    if (topic.startsWith('test/') || topic.startsWith('debug/')) {
      return this.configService.get('NODE_ENV') !== 'production';
    }

    // Tenant-scoped topics: tenants/{tenant_id}/devices/{device_identifier}/...
    // device_identifier can be either mqttClientId (e.g. "edge-c2447348-pi-a36c09d4")
    // or device UUID (e.g. "0cfb7dad-9d5d-4309-82b0-fe7c378caa8d").
    // The edge agent uses device UUID in topic paths while authenticating with mqttClientId.
    const tenantTopicMatch = topic.match(/^tenants\/([a-f0-9-]+)\/devices\/([^/]+)\//);
    if (tenantTopicMatch && tenantTopicMatch[1] && tenantTopicMatch[2]) {
      const topicTenantId = tenantTopicMatch[1];
      const topicDeviceId = tenantTopicMatch[2];

      // Device can only access its own device namespace.
      // Match by mqttClientId (username) OR by device UUID (looked up from DB).
      let isOwnDevice = topicDeviceId === username;
      if (!isOwnDevice) {
        // Topic uses device UUID — verify the UUID belongs to this mqttClientId
        const device = await this.findDeviceAcrossSchemas('mqtt_client_id', username);
        isOwnDevice = !!device && device.id === topicDeviceId;
      }

      if (!isOwnDevice) {
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
    // SENSOR-MEDIUM-006: these topics carry no tenant namespace. They are now
    // DENIED by default and only permitted during a migration window when
    // MQTT_LEGACY_EDGE_TOPICS_ENABLED=true (never in production). Once every
    // device is on tenants/{tenantId}/devices/{deviceCode}/... the flag (and
    // this branch) are removed.
    if (topic.startsWith('edge/')) {
      const legacyEnabled =
        this.configService.get('MQTT_LEGACY_EDGE_TOPICS_ENABLED') === 'true' &&
        this.configService.get('NODE_ENV') !== 'production';
      if (!legacyEnabled) {
        this.logger.warn(
          `[DENIED] Legacy edge/ topic ${topic} for ${username} — tenant-unscoped ` +
          'topics are disabled. Migrate to tenants/{tenantId}/devices/{deviceCode}/...',
        );
        return false;
      }
      const legacyMatch = topic.match(/^edge\/([^/]+)\//);
      const allowed = legacyMatch !== null && legacyMatch[1] === username;
      if (allowed) {
        this.logger.warn(
          `[DEPRECATED] ACL granted on legacy topic ${topic} for ${username} during ` +
          'the migration window. Migrate to tenants/{tenantId}/devices/{deviceCode}/...',
        );
      }
      return allowed;
    }

    // Deny everything else
    return false;
  }

  /**
   * Check service account access using per-topic-pattern grants.
   * Each service account is scoped to specific topic patterns instead of superuser.
   */
  private checkServiceAccountAccess(username: string, topic: string, acc: number): boolean {
    // Tenant-scoped topic pattern: tenants/{tenantId}/sensors/#, tenants/{tenantId}/devices/#
    const isTenantTopic = /^tenants\/[a-f0-9-]+\/(sensors|devices|alerts|commands)\//.test(topic);

    switch (username) {
      case 'backend_service':
        // backend_service: read/write on all tenant-scoped topics
        if (isTenantTopic) return true;
        // Legacy topics during migration
        if (topic.startsWith('sensor/') || topic.startsWith('edge/') || topic.startsWith('alerts/')) return true;
        // $SYS read-only for monitoring
        if (topic.startsWith('$SYS/') && acc === 1) return true;
        return false;

      case 'sensor_service':
        // sensor_service: read/write on tenant-scoped sensor and device topics
        if (isTenantTopic) return true;
        // Wildcard subscription patterns (acc=1 subscribe, acc=3 subscribe+publish)
        if ((acc === 1 || acc === 3) && /^tenants\/\+\/devices\/\+\//.test(topic)) return true;
        // Legacy topics during migration
        if (topic.startsWith('sensor/') || topic.startsWith('sensors/') || topic.startsWith('edge/')) return true;
        if (topic.startsWith('aquaculture/')) return true;
        // Wildcard subscription patterns for known topic prefixes
        if ((acc === 1 || acc === 3) && /^(sensors|edge|aquaculture|tenants)\//.test(topic)) return true;
        // $SYS read-only for monitoring
        if (topic.startsWith('$SYS/') && acc === 1) return true;
        return false;

      case 'alert_service':
        // alert_service: read sensor/device data, write alerts (tenant-scoped only)
        if (isTenantTopic && topic.includes('/alerts/') && acc === 2) return true;
        if (isTenantTopic && (topic.includes('/sensors/') || topic.includes('/devices/')) && acc === 1) return true;
        // Legacy topics: restricted to read-only, non-production only
        if (this.configService.get('NODE_ENV') !== 'production') {
          if ((topic.startsWith('sensor/') || topic.startsWith('edge/')) && acc === 1) return true;
          if (topic.startsWith('alerts/') && acc === 2) return true;
        }
        return false;

      default:
        return false;
    }
  }

  /**
   * Look up a device's tenantId, using an in-memory cache to avoid repeated DB queries.
   * ACL checks happen on every PUBLISH/SUBSCRIBE, so caching is critical.
   *
   * Security (LOW-02):
   * - Rejects client IDs that do not match the expected 'edge-{...}-{...}' format early,
   *   preventing repeated DB queries from random-client-ID floods.
   * - Enforces a maximum cache size with LRU-style eviction (delete oldest entry when full).
   */
  private async getDeviceTenantId(username: string): Promise<string | null> {
    // Early return for client IDs that cannot possibly be valid edge device identifiers
    // Expected format: edge-{uuid}-{deviceCode} or similar structured prefix
    if (!username.startsWith('edge-') && !this.serviceAccountNames.has(username)) {
      return null;
    }

    const now = Date.now();
    const cached = this.tenantIdCache.get(username);
    if (cached && now < cached.expiresAt) {
      // Move to end (most-recently-used) by re-inserting
      this.tenantIdCache.delete(username);
      this.tenantIdCache.set(username, cached);
      return cached.tenantId;
    }

    // SENSOR-MEDIUM-004: the negative-result cache now lives one level down in
    // findDeviceAcrossSchemas, so an unknown-username flood is bounded here AND
    // on the unauthenticated auth/own-device paths.
    const device = await this.findDeviceAcrossSchemas('mqtt_client_id', username);

    if (!device?.tenantId) {
      this.tenantIdCache.delete(username); // drop any stale positive entry
      return null;
    }

    // Enforce max cache size: evict the oldest entry (first inserted) before adding new one
    if (this.tenantIdCache.size >= MqttAuthService.TENANT_CACHE_MAX_SIZE) {
      const oldestKey = this.tenantIdCache.keys().next().value;
      if (oldestKey) {
        this.tenantIdCache.delete(oldestKey);
      }
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
    // Also clear any negative entry so a just-provisioned/revoked device is
    // re-resolved immediately rather than waiting out the negative TTL
    // (SENSOR-MEDIUM-004). The lookup key is column-qualified.
    this.negativeLookupCache.delete(`mqtt_client_id:${username}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-Schema Device Lookup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a device by a public identifier without tenant context.
   *
   * SENSOR-MEDIUM-004: consult the O(1) sensor.edge_device_directory first and,
   * on a hit, issue a single targeted query against the owning tenant's
   * edge_devices. Only a directory miss (or a stale entry) falls back to the
   * O(number-of-tenants) UNION-ALL scan, which then backfills the directory so
   * the next lookup is O(1). This removes the per-request cross-schema fan-out
   * that the un-rate-limited MQTT-auth path could be driven into as a DoS.
   */
  private async findDeviceAcrossSchemas(
    column: 'mqtt_client_id' | 'id',
    value: string,
  ): Promise<EdgeDevice | null> {
    // SENSOR-MEDIUM-004: short-circuit recently-confirmed-absent identifiers so a
    // flood of the same unknown value (auth CONNECT, ACL, own-device) does not
    // re-scan every tenant schema. Bounds the DoS on the unauthenticated path.
    const negativeKey = `${column}:${value}`;
    const now = Date.now();
    const negativeExpiry = this.negativeLookupCache.get(negativeKey);
    if (negativeExpiry !== undefined) {
      if (now < negativeExpiry) {
        return null;
      }
      this.negativeLookupCache.delete(negativeKey);
    }

    const tenantId = await this.deviceDirectory.lookupTenantId(column, value);
    if (tenantId) {
      const schema = getTenantSchemaName(tenantId);
      const rows = await this.dataSource.query(
        `SELECT * FROM "${schema}".edge_devices WHERE "${column}" = $1 LIMIT 1`,
        [value],
      );
      if (rows && rows.length > 0) {
        return this.mapRowToEdgeDevice(rows[0]);
      }
      // Directory pointed at a tenant that no longer holds the row (moved /
      // deleted): fall through to the authoritative scan.
    }

    const device = await this.scanDeviceAcrossSchemas(column, value);
    if (device) {
      await this.deviceDirectory.backfill({
        deviceId: device.id,
        deviceCode: device.deviceCode,
        mqttClientId: device.mqttClientId ?? null,
        tenantId: device.tenantId,
      });
      return device;
    }

    // Confirmed absent by both the directory and the scan: record a bounded,
    // short-lived negative so repeated lookups of this identifier stay O(1).
    if (this.negativeLookupCache.size >= MqttAuthService.NEGATIVE_LOOKUP_CACHE_MAX_SIZE) {
      const oldest = this.negativeLookupCache.keys().next().value;
      if (oldest !== undefined) {
        this.negativeLookupCache.delete(oldest);
      }
    }
    this.negativeLookupCache.set(negativeKey, now + this.NEGATIVE_LOOKUP_CACHE_TTL_MS);
    return null;
  }

  /**
   * Authoritative fallback: UNION-ALL scan of edge_devices across every tenant
   * schema. Used only when the directory misses.
   */
  private async scanDeviceAcrossSchemas(
    column: 'mqtt_client_id' | 'id',
    value: string,
  ): Promise<EdgeDevice | null> {
    const schemas: { schema_name: string }[] = await this.dataSource.query(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name ~ '^tenant_[a-f0-9]{16}$'`,
    );

    if (schemas.length === 0) {
      return null;
    }

    const unionParts = schemas.map(
      (s) => `SELECT * FROM "${s.schema_name}".edge_devices WHERE "${column}" = $1`,
    );
    const sql = `(${unionParts.join(' UNION ALL ')}) LIMIT 1`;

    const rows = await this.dataSource.query(sql, [value]);

    if (!rows || rows.length === 0) {
      return null;
    }

    return this.mapRowToEdgeDevice(rows[0]);
  }

  /**
   * Map a raw database row (snake_case) to an EdgeDevice entity (camelCase).
   */
  private mapRowToEdgeDevice(row: Record<string, any>): EdgeDevice {
    const device = new EdgeDevice();
    device.id = row['id'];
    device.tenantId = row['tenant_id'];
    device.deviceCode = row['device_code'];
    device.deviceName = row['device_name'];
    device.lifecycleState = row['lifecycle_state'];
    device.mqttClientId = row['mqtt_client_id'];
    device.mqttPasswordHash = row['mqtt_password_hash'];
    device.isOnline = row['is_online'];
    device.lastSeenAt = row['last_seen_at'] ? new Date(row['last_seen_at']) : undefined;
    return device;
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
   *
   * SENSOR-LOW-008: the default is the OWASP-grade HTTP-mode count; the weak
   * 101-iteration file-mode value must be passed explicitly by the legacy path.
   */
  hashPassword(password: string, iterations: number = MqttAuthService.HTTP_MODE_ITERATIONS): string {
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
    // SENSOR-MEDIUM-004: a device just gained credentials — drop any negative
    // lookup entry so its first CONNECT resolves immediately instead of being
    // rejected for the remainder of the negative TTL.
    this.negativeLookupCache.delete(`mqtt_client_id:${username}`);

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
          reject(err instanceof Error ? err : new Error(String(err)));
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
          reject(err instanceof Error ? err : new Error(String(err)));
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
      const device = await this.findDeviceAcrossSchemas('mqtt_client_id', username);
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

      // Atomic write: temp file → fsync → rename (restrictive permissions)
      const tmpPath = this.passwordFilePath + '.tmp';
      await fs.writeFile(tmpPath, newContent, { encoding: 'utf-8', mode: 0o600 });
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
      await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600 });
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
        // Use execFile with explicit args to avoid shell injection
        await execFileAsync('mosquitto_pid_reload', [], { timeout: 5000 }).catch(async () => {
          // Fallback: use pkill to send SIGHUP without shell interpolation
          await execFileAsync('pkill', ['-HUP', 'mosquitto'], { timeout: 5000 });
        });
        this.logger.log('Mosquitto reload signal sent');
      } catch {
        try {
          // Docker fallback: use execFile with explicit args (no shell)
          await execFileAsync('docker', ['exec', 'mosquitto', 'kill', '-HUP', '1'], { timeout: 5000 });
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
