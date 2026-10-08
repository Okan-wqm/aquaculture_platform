import { execFile } from 'child_process';
import { pbkdf2, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { promises as fs } from 'fs';
import { promisify } from 'util';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DeviceDirectoryService } from './device-directory.service';
import {
  type DeviceLifecycleState,
  type EdgeDevice,
  mayHoldBrokerSession,
} from './entities/edge-device.entity';

const execFileAsync = promisify(execFile);
// PBKDF2 at 600k iterations is ~0.5 s of CPU; on the event loop it stalls every
// request in the process for each CONNECT. The async form runs on libuv's pool.
const pbkdf2Async = promisify(pbkdf2);

/** Why a device CONNECT was refused — logged, never returned to the broker. */
type DeviceAuthDenial =
  | 'device_not_found'
  | 'lifecycle_state'
  | 'client_id_mismatch'
  | 'no_password_hash'
  | 'password_mismatch';

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

  // SENSOR-MEDIUM-004: negative-result cache for device lookups. A lookup that
  // misses the directory is recorded here (keyed `${column}:${value}`) for a
  // short window, so a flood of the same unknown identifier on the
  // unauthenticated CONNECT path is answered in memory. Short TTL so a freshly
  // provisioned device becomes resolvable quickly; bounded with LRU eviction so
  // the flood cannot itself grow memory unboundedly.
  //
  // There is deliberately NO positive cache: whether a device may connect or
  // publish depends on its lifecycle state, which an operator changes at any
  // moment (approve, decommission, reset). A cached "yes" would outlive that
  // change; every CONNECT and ACL check reads the device row.
  private readonly negativeLookupCache = new Map<string, number>(); // `${column}:${value}` → expiresAt
  private readonly NEGATIVE_LOOKUP_CACHE_TTL_MS = 30_000; // 30 seconds
  private static readonly NEGATIVE_LOOKUP_CACHE_MAX_SIZE = 10_000;

  constructor(
    private readonly configService: ConfigService,
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
  async verifyDeviceCredentials(
    username: string,
    password: string,
    clientId: string | undefined,
  ): Promise<boolean> {
    // Check service accounts first
    const serviceHash = this.serviceAccounts.get(username);
    if (serviceHash) {
      return this.verifyPassword(password, serviceHash);
    }

    const device = await this.findSessionDevice(username);
    if (device === 'not_found' || device === 'not_in_service') {
      return false;
    }

    // SENSOR-HIGH-144: a device may only connect under its username or the
    // exact client ID the edge gateway derives, `${username}-${deviceCode}`
    // (sens-api-gateway/src/mqtt.rs). Mosquitto evicts the existing session on
    // a duplicate client ID, so a looser rule (any `${username}-*`) would let a
    // device take a sibling's ID, and none at all would let it connect as
    // `aqua-sensor-service-main` and knock the ingestion listener off.
    if (!MqttAuthService.isOwnClientId(username, clientId, device.deviceCode)) {
      this.logAuthDenied('client_id_mismatch', username);
      return false;
    }
    if (!device.mqttPasswordHash) {
      this.logAuthDenied('no_password_hash', username, device.lifecycleState);
      return false;
    }

    const valid = await this.verifyPassword(password, device.mqttPasswordHash);
    if (!valid) {
      this.logAuthDenied('password_mismatch', username, device.lifecycleState);
    }
    return valid;
  }

  /** True when `clientId` is the username itself or exactly `${username}-${deviceCode}`. */
  private static isOwnClientId(
    username: string,
    clientId: string | undefined,
    deviceCode: string,
  ): boolean {
    return clientId === username || clientId === `${username}-${deviceCode}`;
  }

  /**
   * Resolve the device a broker principal names and admit it only if its
   * lifecycle state may hold a broker session (`mayHoldBrokerSession`, the one
   * allow-list CONNECT and ACL share). A PENDING_APPROVAL device holds a
   * password from self-registration; this is what keeps it off the broker
   * until it is approved.
   */
  private async findSessionDevice(
    username: string,
  ): Promise<EdgeDevice | 'not_found' | 'not_in_service'> {
    const device = await this.findDeviceAcrossSchemas('mqtt_client_id', username);
    if (!device) {
      this.logAuthDenied('device_not_found', username);
      return 'not_found';
    }
    if (!mayHoldBrokerSession(device.lifecycleState)) {
      this.logAuthDenied('lifecycle_state', username, device.lifecycleState);
      return 'not_in_service';
    }
    return device;
  }

  /**
   * The username on a refused CONNECT is attacker-supplied and arrives on every
   * attempt. Log a structured record at debug with a short, non-reversible
   * fingerprint instead of the raw value, so a flood can neither inject text
   * into nor fill the warn stream.
   */
  private logAuthDenied(
    reason: DeviceAuthDenial,
    username: string,
    lifecycleState?: DeviceLifecycleState,
  ): void {
    this.logger.debug({
      event: 'mqtt_device_auth_denied',
      reason,
      principal: MqttAuthService.principalFingerprint(username),
      ...(lifecycleState === undefined ? {} : { lifecycleState }),
    });
  }

  /** First 12 hex chars of sha256(username): correlatable, not reversible. */
  static principalFingerprint(username: string): string {
    return createHash('sha256').update(username).digest('hex').slice(0, 12);
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

      // The device must still be in service: the same allow-list as CONNECT,
      // re-read on every check. Mosquitto keeps an established session across
      // a decommission or a reset, so this is what stops it publishing.
      const device = await this.findSessionDevice(username);
      if (device === 'not_found' || device === 'not_in_service') {
        return false;
      }

      // Device can only access its own device namespace, named by its
      // mqttClientId (username) or its UUID.
      if (topicDeviceId !== username && topicDeviceId !== device.id) {
        return false;
      }

      // Timing-safe comparison of tenant IDs to prevent timing attacks
      const topicTenantHash = createHash('sha256').update(topicTenantId).digest();
      const deviceTenantHash = createHash('sha256').update(device.tenantId).digest();
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
        // backend_service: publish on tenant-scoped topics (cloud→edge
        // COMMANDS). SEC-MEDIUM-130 (2026-08-23 scan №75): the wildcard
        // tenants/# read grant (subscribe ALL tenant telemetry) is removed.
        if (isTenantTopic && (acc === 2 || acc === 3)) return true;
        // Ack/read: device responses on commands topics only
        if (isTenantTopic && acc === 1 && topic.includes('/commands')) return true;
        // Legacy topics during migration (publish only)
        if (acc === 2 && (topic.startsWith('sensor/') || topic.startsWith('edge/') || topic.startsWith('alerts/'))) return true;
        // $SYS read-only for monitoring
        if (topic.startsWith('$SYS/') && acc === 1) return true;
        return false;

      case 'sensor_service':
        // sensor_service: read/write on tenant-scoped sensor and device topics
        // SEC-MEDIUM-130 (№75): wildcard subscribe across ALL tenants
        // (tenants/+/...) removed — the service subscribes per-tenant.
        if (isTenantTopic) return true;
        // SENSOR-HIGH-118: Mosquitto 2.x + go-auth checks wildcard SUBSCRIBEs
        // with acc=4 (MOSQ_ACL_SUBSCRIBE). The listener subscribes one fixed,
        // enumerated filter set (SENSOR_SERVICE_SUBSCRIPTION_FILTERS in
        // mqtt-listener.service.ts); grant the subscribe bit — and a
        // filter-level read for go-auth variants that re-check acc=1 on the
        // filter — for exactly those tenant-device LEAF filters and the
        // temperature-array pattern. The broad `tenants/+/devices/+/#`
        // grant stays DENIED, preserving the SEC-MEDIUM-130 intent; the
        // parameterized unit test derives from the exported filter list so
        // this grant cannot drift from what the listener subscribes.
        if (
          (acc & 4 || acc === 1 || acc === 3) &&
          /^tenants\/\+\/devices\/\+\/(telemetry|status|response|responses|io_data|alarms|capabilities|lora_events)$/.test(topic)
        ) {
          return true;
        }
        if ((acc & 4 || acc === 1 || acc === 3) && topic === '+/+/+/temperature-array') {
          return true;
        }
        // Legacy topics during migration
        if (topic.startsWith('sensor/') || topic.startsWith('sensors/') || topic.startsWith('edge/')) return true;
        if (topic.startsWith('aquaculture/')) return true;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-Schema Device Lookup
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Resolve a device by a public identifier without tenant context.
   *
   * SENSOR-MEDIUM-004: DeviceDirectoryService.findDevice consults the O(1)
   * sensor.edge_device_directory and reads the owning tenant only; a miss is a
   * miss (every device is published to the directory when it is created). The
   * negative cache here bounds a flood of unknown identifiers on the
   * un-rate-limited MQTT-auth path.
   */
  private async findDeviceAcrossSchemas(
    column: 'mqtt_client_id' | 'id',
    value: string,
  ): Promise<EdgeDevice | null> {
    // SENSOR-MEDIUM-004: short-circuit recently-confirmed-absent identifiers so a
    // flood of the same unknown value (auth CONNECT, ACL) stays in memory.
    // Bounds the DoS on the unauthenticated path.
    const negativeKey = `${column}:${value}`;
    const now = Date.now();
    const negativeExpiry = this.negativeLookupCache.get(negativeKey);
    if (negativeExpiry !== undefined) {
      if (now < negativeExpiry) {
        return null;
      }
      this.negativeLookupCache.delete(negativeKey);
    }

    // SENSOR-CRITICAL-143: directory → owning tenant's boundary; never an
    // unscoped pooled read, which FORCE RLS answers with zero rows (every edge
    // CONNECT and ACL check was refused).
    const device = await this.deviceDirectory.findDevice(column, value);
    if (device) {
      return device;
    }

    // Confirmed absent from the directory: record a bounded,
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

  // ═══════════════════════════════════════════════════════════════════════════
  // Credential Generation & Verification (shared by both modes)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate MQTT credentials for a device.
   * Returns the plain password (to send to agent) and hash (to store in DB).
   */
  async generateCredentials(): Promise<{ password: string; hash: string }> {
    const password = randomBytes(16).toString('base64');
    const iterations = this.authMode === 'http'
      ? MqttAuthService.HTTP_MODE_ITERATIONS
      : MqttAuthService.FILE_MODE_ITERATIONS;
    const hash = await this.hashPassword(password, iterations);
    return { password, hash };
  }

  /**
   * Hash a password using PBKDF2-SHA512 (Mosquitto $7$ format).
   * Format: $7$iterations$base64salt$base64hash
   *
   * SENSOR-LOW-008: the default is the OWASP-grade HTTP-mode count; the weak
   * 101-iteration file-mode value must be passed explicitly by the legacy path.
   */
  async hashPassword(
    password: string,
    iterations: number = MqttAuthService.HTTP_MODE_ITERATIONS,
  ): Promise<string> {
    const salt = randomBytes(12);
    const keyLength = 24;
    const derivedKey = await pbkdf2Async(password, salt, iterations, keyLength, 'sha512');
    return `$7$${iterations}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
  }

  /**
   * Verify a password against a PBKDF2-SHA512 hash.
   * Uses timing-safe comparison to prevent timing attacks. Async so the
   * 600k-iteration derivation never blocks the event loop.
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
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

      const derivedKey = await pbkdf2Async(
        password,
        salt,
        iterations,
        expectedHash.length,
        'sha512',
      );

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
