import { pbkdf2, randomBytes, timingSafeEqual, createHash } from 'crypto';
import { promisify } from 'util';

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { isDeviceCommandTopic } from '../shared-mqtt/device-command-topic';

import { DeviceDirectoryService } from './device-directory.service';
import { ProvisioningReservationService } from './provisioning-reservation.service';
import {
  type DeviceLifecycleState,
  type EdgeDevice,
  mayHoldBrokerSession,
} from './entities/edge-device.entity';

// PBKDF2 at 600k iterations is ~0.5 s of CPU; on the event loop it stalls every
// request in the process for each CONNECT. The async form runs on libuv's pool.
const pbkdf2Async = promisify(pbkdf2);

/**
 * The one principal that may publish an edge device's commands (ADR-048
 * DEC-9.3): sensor-service, whose only command path is EdgeCommandPublisher
 * (tests/invariants/edge-command-publish-chokepoint.spec.ts). No other service
 * account and no device — not even onto its own topic — writes a command.
 */
export const COMMAND_PUBLISHER_PRINCIPAL = 'sensor_service';

/** go-auth access bits: 1 read, 2 write (3 = both), 4 subscribe. */
const ACC_WRITE = 2;

/** Why a device CONNECT was refused — logged, never returned to the broker. */
type DeviceAuthDenial =
  | 'device_not_found'
  | 'lifecycle_state'
  | 'client_id_mismatch'
  | 'no_password_hash'
  | 'password_mismatch';

/**
 * MQTT Authentication Service — the broker's HTTP auth backend.
 *
 * Mosquitto calls /mqtt/auth, /mqtt/acl and /mqtt/superuser; credentials are
 * verified against edge_devices.mqtt_password_hash and the ACL matches the
 * device's tenant against the topic. Service accounts (backend_service,
 * sensor_service, alert_service) are verified against hashes from the
 * environment.
 *
 * This is the only backend. The legacy Mosquitto password-file mode
 * (MQTT_AUTH_MODE=file) is refused at boot in every environment: the
 * two-phase provisioning token is committed only when a device's own
 * credential authenticates a CONNECT here (ADR-048 DEC-5.7), and in file mode
 * Mosquitto never asks, so no activation could ever commit — on either agent
 * channel — and a live credential would look never-activated.
 */
@Injectable()
export class MqttAuthService implements OnModuleInit {
  private readonly logger = new Logger(MqttAuthService.name);

  /** A configured MQTT_AUTH_MODE other than `http`, refused at boot. */
  private readonly refusedAuthMode: string | null;

  // Service account credentials (hashes from env vars)
  private readonly serviceAccounts: Map<string, string> = new Map();

  // Service accounts with per-topic-pattern grants (no superuser access)
  private readonly serviceAccountNames = new Set([
    'backend_service',
    'sensor_service',
    'alert_service',
  ]);

  // PBKDF2 iterations: Mosquitto never parses the hash — this service
  // verifies it — so the OWASP-recommended count (SENSOR-LOW-008).
  private static readonly HTTP_MODE_ITERATIONS = 600_000;

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
    private readonly reservations: ProvisioningReservationService,
  ) {
    const mode = this.configService.get<string>('MQTT_AUTH_MODE', 'http');
    this.refusedAuthMode = mode === 'http' ? null : mode;

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
    if (this.refusedAuthMode !== null) {
      throw new Error(
        `MQTT_AUTH_MODE=${this.refusedAuthMode} is not supported: the broker must use the ` +
          'HTTP auth backend (MQTT_AUTH_MODE=http, mosquitto go-auth calling /mqtt/auth). ' +
          'A device activation commits only when its credential authenticates a CONNECT there ' +
          '(ADR-048 DEC-5.7); the legacy password-file mode would never commit one.',
      );
    }
    this.logger.log('MQTT Authentication Service initialized (HTTP auth backend)');
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
      return false;
    }
    // ADR-048 DEC-5.7: the first CONNECT authenticated by the device's own
    // credential commits the activation and spends the single-use token. A
    // commit that fails (it throws) refuses this CONNECT; the token stays
    // unspent and the device's reconnect retries the commit.
    if (device.tokenUsedAt === null && device.credentialsIssuedAt !== null) {
      await this.reservations.commitFirstSession(device, new Date());
    }
    return true;
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
    // ADR-048 DEC-9.3: nobody but the command principal writes a command,
    // whatever a later grant says; the principal still needs its own grant.
    if (
      (acc & ACC_WRITE) !== 0 &&
      isDeviceCommandTopic(topic) &&
      username !== COMMAND_PUBLISHER_PRINCIPAL
    ) {
      return false;
    }

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
    // device_identifier is one of the device's own identities: its mqttClientId
    // (e.g. "edge-c2447348-pi-a36c09d4"), its UUID (e.g.
    // "0cfb7dad-9d5d-4309-82b0-fe7c378caa8d") or its device code (e.g.
    // "PI-A36C09D4", unique per tenant schema). The edge agent authenticates
    // with mqttClientId, names most topics by UUID and the HMI watch stream by
    // device code (SENSOR-MEDIUM-221).
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

      // Device can only access its own device namespace, named by one of
      // its own identities.
      if (
        topicDeviceId !== username &&
        topicDeviceId !== device.id &&
        topicDeviceId !== device.deviceCode
      ) {
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
        // backend_service: publish on tenant-scoped topics, never a device's
        // commands (ADR-048 DEC-9.3; refused above). SEC-MEDIUM-130
        // (2026-08-23 scan №75): the wildcard tenants/# read grant (subscribe
        // ALL tenant telemetry) is removed.
        if (isTenantTopic && (acc === 2 || acc === 3)) return true;
        // Ack/read: device responses on commands topics only
        if (isTenantTopic && acc === 1 && topic.includes('/commands')) return true;
        // Legacy topics during migration (publish only)
        if (
          acc === 2 &&
          (topic.startsWith('sensor/') || topic.startsWith('edge/') || topic.startsWith('alerts/'))
        )
          return true;
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
          /^tenants\/\+\/devices\/\+\/(telemetry|status|response|responses|io_data|alarms|capabilities|lora_events)$/.test(
            topic,
          )
        ) {
          return true;
        }
        if ((acc & 4 || acc === 1 || acc === 3) && topic === '+/+/+/temperature-array') {
          return true;
        }
        // Legacy topics during migration
        if (
          topic.startsWith('sensor/') ||
          topic.startsWith('sensors/') ||
          topic.startsWith('edge/')
        )
          return true;
        if (topic.startsWith('aquaculture/')) return true;
        // $SYS read-only for monitoring
        if (topic.startsWith('$SYS/') && acc === 1) return true;
        return false;

      case 'alert_service':
        // alert_service: read sensor/device data, write alerts (tenant-scoped only)
        if (isTenantTopic && topic.includes('/alerts/') && acc === 2) return true;
        if (
          isTenantTopic &&
          (topic.includes('/sensors/') || topic.includes('/devices/')) &&
          acc === 1
        )
          return true;
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
  // Credential Generation & Verification
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Generate MQTT credentials for a device.
   * Returns the plain password (to send to agent) and hash (to store in DB).
   */
  async generateCredentials(): Promise<{ password: string; hash: string }> {
    const password = randomBytes(16).toString('base64');
    const hash = await this.hashPassword(password);
    return { password, hash };
  }

  /**
   * Hash a password using PBKDF2-SHA512 (Mosquitto $7$ format).
   * Format: $7$iterations$base64salt$base64hash
   *
   * SENSOR-LOW-008: the default is the OWASP-grade count. verifyPassword
   * reads the count from the hash, so a stored hash of any count verifies.
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
  // Credential lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * A device was just issued a broker credential (stored on its row, which
   * /mqtt/auth reads). SENSOR-MEDIUM-004: drop any negative lookup entry so
   * its first CONNECT resolves immediately instead of being refused for the
   * rest of the negative TTL. Revoking a credential is the row's
   * mqtt_password_hash becoming NULL; nothing else holds one.
   */
  noteCredentialsIssued(username: string): void {
    this.negativeLookupCache.delete(`mqtt_client_id:${username}`);
  }
}
