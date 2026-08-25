/**
 * MqttAuthService Unit Tests
 *
 * Covers critical security paths:
 * - Device authentication (valid, invalid, revoked)
 * - Cross-tenant ACL enforcement
 * - Legacy edge/ topic handling
 * - Service account patterns
 * - Timing-safe comparison
 * - Tenant ID cache behaviour
 */

import { createHash, timingSafeEqual, pbkdf2Sync, randomBytes } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { DataSource, Repository } from 'typeorm';

import { EdgeDevice, DeviceLifecycleState } from '../entities/edge-device.entity';
import { MqttAuthService } from '../mqtt-auth.service';

// ─── helpers ────────────────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DEVICE_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MQTT_CLIENT = 'edge-c2447348-pi-a36c09d4';

function makeDevice(overrides: Partial<EdgeDevice> = {}): EdgeDevice {
  const d = new EdgeDevice();
  d.id = DEVICE_UUID;
  d.tenantId = TENANT_A;
  d.deviceCode = 'pi-a36c09d4';
  d.deviceName = 'Test Device';
  d.lifecycleState = DeviceLifecycleState.ACTIVE;
  d.mqttClientId = MQTT_CLIENT;
  // The prod entity column is `string | null` (nullable column).
  // `undefined` is the historical default but TS rejects it; using
  // `null` matches the entity contract exactly and survives a
  // hypothetical future `noImplicitOverride` toggle.
  d.mqttPasswordHash = null;
  d.isOnline = true;
  Object.assign(d, overrides);
  return d;
}

/**
 * Generate a PBKDF2-SHA512 hash in Mosquitto $7$ format.
 * This mirrors MqttAuthService.hashPassword so we can craft known hashes for tests.
 */
function hashPassword(password: string, iterations = 101): string {
  const salt = randomBytes(12);
  const keyLength = 24;
  const derived = pbkdf2Sync(password, salt, iterations, keyLength, 'sha512');
  return `$7$${iterations}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

// ─── mocks ──────────────────────────────────────────────────────────────────

function createMockConfigService(overrides: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    MQTT_AUTH_MODE: 'http',
    MQTT_AUTH_ENABLED: false,
    MOSQUITTO_PASSWORD_FILE: '/tmp/passwd',
    NODE_ENV: 'production',
    MQTT_BACKEND_SERVICE_HASH: undefined,
    MQTT_SENSOR_SERVICE_HASH: undefined,
    MQTT_ALERT_SERVICE_HASH: undefined,
    MQTT_EXPORTER_HASH: undefined,
    ...overrides,
  };
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      defaults[key] !== undefined ? defaults[key] : defaultValue,
    ),
  } as unknown as ConfigService;
}

function createMockDataSource(): jest.Mocked<DataSource> {
  return {
    query: jest.fn(),
    getRepository: jest.fn(),
  } as unknown as jest.Mocked<DataSource>;
}

function createMockRepository(): jest.Mocked<Repository<EdgeDevice>> {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    save: jest.fn(),
  } as unknown as jest.Mocked<Repository<EdgeDevice>>;
}

function createService(
  opts: {
    configOverrides?: Record<string, unknown>;
    dataSource?: jest.Mocked<DataSource>;
    repository?: jest.Mocked<Repository<EdgeDevice>>;
  } = {},
) {
  const ds = opts.dataSource ?? createMockDataSource();
  const repo = opts.repository ?? createMockRepository();
  const cfg = createMockConfigService(opts.configOverrides);
  // Directory misses by default so tests exercise the authoritative scan path.
  const directory = {
    lookupTenantId: jest.fn().mockResolvedValue(null),
    backfill: jest.fn().mockResolvedValue(undefined),
    upsert: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new MqttAuthService(cfg, repo, ds, directory as never),
    dataSource: ds,
    repo,
    cfg,
    directory,
  };
}

// Helper: make the dataSource.query mock return a device for cross-schema lookup
function stubFindDevice(ds: jest.Mocked<DataSource>, device: EdgeDevice | null): void {
  // First call: schema list
  // Second call: UNION ALL query
  ds.query
    .mockResolvedValueOnce([{ schema_name: 'tenant_aaaaaaaaaaaaaaaa' }])
    .mockResolvedValueOnce(
      device
        ? [
            {
              id: device.id,
              tenant_id: device.tenantId,
              device_code: device.deviceCode,
              device_name: device.deviceName,
              lifecycle_state: device.lifecycleState,
              mqtt_client_id: device.mqttClientId,
              mqtt_password_hash: device.mqttPasswordHash,
              is_online: device.isOnline,
              last_seen_at: null,
            },
          ]
        : [],
    );
}

/**
 * Stub findDeviceAcrossSchemas to always return a given device.
 * Repeated calls will re-use the same data (using mockResolvedValue, not Once).
 */
function stubFindDeviceRepeated(ds: jest.Mocked<DataSource>, device: EdgeDevice | null): void {
  ds.query.mockImplementation((sql: string) => {
    if (typeof sql === 'string' && sql.includes('information_schema.schemata')) {
      return Promise.resolve([{ schema_name: 'tenant_aaaaaaaaaaaaaaaa' }]);
    }
    return Promise.resolve(
      device
        ? [
            {
              id: device.id,
              tenant_id: device.tenantId,
              device_code: device.deviceCode,
              device_name: device.deviceName,
              lifecycle_state: device.lifecycleState,
              mqtt_client_id: device.mqttClientId,
              mqtt_password_hash: device.mqttPasswordHash,
              is_online: device.isOnline,
              last_seen_at: null,
            },
          ]
        : [],
    );
  });
}

// ═══════════════════════════════════════════════════════════════════════════════

describe('MqttAuthService', () => {
  afterEach(() => jest.restoreAllMocks());

  // ─── verifyDeviceCredentials ────────────────────────────────────────────

  describe('verifyDeviceCredentials', () => {
    it('should accept valid device credentials', async () => {
      const password = 'my-secret-password';
      const hash = hashPassword(password);
      const device = makeDevice({ mqttPasswordHash: hash });
      const { service, dataSource } = createService();
      stubFindDevice(dataSource, device);

      const result = await service.verifyDeviceCredentials(MQTT_CLIENT, password);
      expect(result).toBe(true);
    });

    it('should reject invalid password', async () => {
      const hash = hashPassword('correct-password');
      const device = makeDevice({ mqttPasswordHash: hash });
      const { service, dataSource } = createService();
      stubFindDevice(dataSource, device);

      const result = await service.verifyDeviceCredentials(MQTT_CLIENT, 'wrong-password');
      expect(result).toBe(false);
    });

    it('should reject device not found', async () => {
      const { service, dataSource } = createService();
      stubFindDevice(dataSource, null);

      const result = await service.verifyDeviceCredentials('nonexistent-device', 'any');
      expect(result).toBe(false);
    });

    it('should reject revoked device', async () => {
      const password = 'my-secret';
      const hash = hashPassword(password);
      const device = makeDevice({
        mqttPasswordHash: hash,
        lifecycleState: DeviceLifecycleState.REVOKED,
      });
      const { service, dataSource } = createService();
      stubFindDevice(dataSource, device);

      const result = await service.verifyDeviceCredentials(MQTT_CLIENT, password);
      expect(result).toBe(false);
    });

    it('should reject decommissioned device', async () => {
      const password = 'my-secret';
      const hash = hashPassword(password);
      const device = makeDevice({
        mqttPasswordHash: hash,
        lifecycleState: DeviceLifecycleState.DECOMMISSIONED,
      });
      const { service, dataSource } = createService();
      stubFindDevice(dataSource, device);

      const result = await service.verifyDeviceCredentials(MQTT_CLIENT, password);
      expect(result).toBe(false);
    });

    it('should reject device without password hash', async () => {
      const device = makeDevice({ mqttPasswordHash: undefined });
      const { service, dataSource } = createService();
      stubFindDevice(dataSource, device);

      const result = await service.verifyDeviceCredentials(MQTT_CLIENT, 'any');
      expect(result).toBe(false);
    });

    it('should authenticate service account via env hash', async () => {
      const servicePassword = 'backend-secret-123';
      const serviceHash = hashPassword(servicePassword);
      const { service } = createService({
        configOverrides: { MQTT_BACKEND_SERVICE_HASH: serviceHash },
      });

      const result = await service.verifyDeviceCredentials('backend_service', servicePassword);
      expect(result).toBe(true);
    });

    it('should reject service account with wrong password', async () => {
      const serviceHash = hashPassword('correct-secret');
      const { service } = createService({
        configOverrides: { MQTT_BACKEND_SERVICE_HASH: serviceHash },
      });

      const result = await service.verifyDeviceCredentials('backend_service', 'wrong');
      expect(result).toBe(false);
    });
  });

  // ─── verifyPassword (timing-safe) ──────────────────────────────────────

  describe('verifyPassword (timing-safe)', () => {
    it('should return true for matching password', () => {
      const { service } = createService();
      const password = 'test-timing-safe';
      const hash = hashPassword(password);

      expect(service.verifyPassword(password, hash)).toBe(true);
    });

    it('should return false for non-matching password', () => {
      const { service } = createService();
      const hash = hashPassword('correct');

      expect(service.verifyPassword('incorrect', hash)).toBe(false);
    });

    it('should return false for malformed hash (missing parts)', () => {
      const { service } = createService();
      expect(service.verifyPassword('any', '$7$101$salt')).toBe(false);
    });

    it('should return false for hash with wrong prefix', () => {
      const { service } = createService();
      expect(service.verifyPassword('any', '$6$101$salt$hash')).toBe(false);
    });

    it('should return false for completely invalid hash', () => {
      const { service } = createService();
      expect(service.verifyPassword('any', 'not-a-hash')).toBe(false);
    });

    it('should not throw on corrupt base64 data', () => {
      const { service } = createService();
      // verifyPassword should catch and return false, not throw
      expect(service.verifyPassword('any', '$7$101$!!!$!!!')).toBe(false);
    });
  });

  // ─── checkTopicAccess: tenant-prefixed topics ──────────────────────────

  describe('checkTopicAccess (tenant-prefixed)', () => {
    it('should ALLOW own tenant topic using mqttClientId', async () => {
      const device = makeDevice({ tenantId: TENANT_A });
      const { service, dataSource } = createService();
      stubFindDeviceRepeated(dataSource, device);

      const topic = `tenants/${TENANT_A}/devices/${MQTT_CLIENT}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(true);
    });

    it('should ALLOW own tenant topic using device UUID', async () => {
      const device = makeDevice({ tenantId: TENANT_A, id: DEVICE_UUID });
      const { service, dataSource } = createService();
      stubFindDeviceRepeated(dataSource, device);

      const topic = `tenants/${TENANT_A}/devices/${DEVICE_UUID}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(true);
    });

    it('should DENY cross-tenant topic access (other tenant ID)', async () => {
      const device = makeDevice({ tenantId: TENANT_A });
      const { service, dataSource } = createService();
      stubFindDeviceRepeated(dataSource, device);

      const topic = `tenants/${TENANT_B}/devices/${MQTT_CLIENT}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(false);
    });

    it('should DENY when device not found in DB', async () => {
      const { service, dataSource } = createService();
      stubFindDeviceRepeated(dataSource, null);

      const topic = `tenants/${TENANT_A}/devices/${MQTT_CLIENT}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(false);
    });

    it('should DENY when device ID in topic does not match username or device UUID', async () => {
      const device = makeDevice({ tenantId: TENANT_A });
      const { service, dataSource } = createService();
      stubFindDeviceRepeated(dataSource, device);

      // Topic uses a different device identifier that is neither the mqttClientId nor the device UUID
      const topic = `tenants/${TENANT_A}/devices/other-device-id/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(false);
    });

    it('should DENY subscribe (acc=4) to an unrelated/non-owned topic', async () => {
      const { service } = createService();
      // SENSOR-MEDIUM-005: subscribe is no longer blanket-allowed — an
      // arbitrary/cross-tenant filter must be denied (was `true` before).
      const result = await service.checkTopicAccess(MQTT_CLIENT, 'any/topic', 4);
      expect(result).toBe(false);
    });
  });

  // ─── checkTopicAccess: legacy edge/ topics ─────────────────────────────

  describe('checkTopicAccess (legacy edge/ topics)', () => {
    it('should DENY legacy edge/ topic by default (SENSOR-MEDIUM-006)', async () => {
      // Tenant-unscoped edge/ topics are denied unless the migration flag is on.
      const { service } = createService({ configOverrides: { NODE_ENV: 'development' } });
      const topic = `edge/${MQTT_CLIENT}/data`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(false);
    });

    it('should ALLOW legacy edge/ topic for own username only when migration flag enabled', async () => {
      const { service } = createService({
        configOverrides: { NODE_ENV: 'development', MQTT_LEGACY_EDGE_TOPICS_ENABLED: 'true' },
      });
      const topic = `edge/${MQTT_CLIENT}/data`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(true);
    });

    it('should DENY legacy edge/ topic for other username', async () => {
      const { service } = createService();
      const topic = `edge/other-device/data`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(false);
    });
  });

  // ─── checkTopicAccess: service accounts ────────────────────────────────

  describe('checkTopicAccess (service accounts)', () => {
    it('backend_service should access tenant-scoped topics', async () => {
      const { service } = createService();
      const topic = `tenants/${TENANT_A}/devices/device1/telemetry`;
      const result = await service.checkTopicAccess('backend_service', topic, 2);
      expect(result).toBe(true);
    });

    it('backend_service should read $SYS/ topics', async () => {
      const { service } = createService();
      const result = await service.checkTopicAccess('backend_service', '$SYS/broker/uptime', 1);
      expect(result).toBe(true);
    });

    it('backend_service should NOT write $SYS/ topics', async () => {
      const { service } = createService();
      const result = await service.checkTopicAccess('backend_service', '$SYS/broker/uptime', 2);
      expect(result).toBe(false);
    });

    it('sensor_service should access tenant-scoped topics', async () => {
      const { service } = createService();
      const topic = `tenants/${TENANT_A}/sensors/s1/data`;
      const result = await service.checkTopicAccess('sensor_service', topic, 1);
      expect(result).toBe(true);
    });

    it('sensor_service should access legacy sensor/ topics', async () => {
      const { service } = createService();
      const result = await service.checkTopicAccess('sensor_service', 'sensor/data/1', 2);
      expect(result).toBe(true);
    });

    it('alert_service should write tenant-scoped alerts', async () => {
      const { service } = createService();
      const topic = `tenants/${TENANT_A}/alerts/high-temp`;
      const result = await service.checkTopicAccess('alert_service', topic, 2);
      expect(result).toBe(true);
    });

    it('alert_service should read tenant-scoped sensor data', async () => {
      const { service } = createService();
      const topic = `tenants/${TENANT_A}/sensors/s1/data`;
      const result = await service.checkTopicAccess('alert_service', topic, 1);
      expect(result).toBe(true);
    });

    it('alert_service should NOT write to sensor topics', async () => {
      const { service } = createService();
      const topic = `tenants/${TENANT_A}/sensors/s1/data`;
      const result = await service.checkTopicAccess('alert_service', topic, 2);
      expect(result).toBe(false);
    });

    it('mqtt_exporter should only read Mosquitto $SYS topics', async () => {
      const { service } = createService();

      await expect(
        service.checkTopicAccess('mqtt_exporter', '$SYS/broker/uptime', 1),
      ).resolves.toBe(true);
      await expect(
        service.checkTopicAccess('mqtt_exporter', '$SYS/broker/uptime', 2),
      ).resolves.toBe(false);
      await expect(
        service.checkTopicAccess('mqtt_exporter', `tenants/${TENANT_A}/sensors/s1/data`, 1),
      ).resolves.toBe(false);
    });

    it('unknown service account should be denied', async () => {
      const { service } = createService();
      const topic = `tenants/${TENANT_A}/devices/d1/data`;
      // 'unknown_service' is not in serviceAccountNames, so falls through to device logic
      // No device found -> denied
      const { service: s, dataSource: ds } = createService();
      stubFindDeviceRepeated(ds, null);
      const result = await s.checkTopicAccess('unknown_service', topic, 2);
      expect(result).toBe(false);
    });
  });

  // ─── checkTopicAccess: special topics ──────────────────────────────────

  describe('checkTopicAccess (special topics)', () => {
    it('should DENY $SYS/ for non-service accounts', async () => {
      const { service } = createService();
      const result = await service.checkTopicAccess(MQTT_CLIENT, '$SYS/broker/uptime', 1);
      expect(result).toBe(false);
    });

    it('should DENY test/ topics in production', async () => {
      const { service } = createService({ configOverrides: { NODE_ENV: 'production' } });
      const result = await service.checkTopicAccess(MQTT_CLIENT, 'test/debug-data', 2);
      expect(result).toBe(false);
    });

    it('should ALLOW test/ topics in development', async () => {
      const { service } = createService({ configOverrides: { NODE_ENV: 'development' } });
      const result = await service.checkTopicAccess(MQTT_CLIENT, 'test/debug-data', 2);
      expect(result).toBe(true);
    });

    it('should DENY debug/ topics in production', async () => {
      const { service } = createService({ configOverrides: { NODE_ENV: 'production' } });
      const result = await service.checkTopicAccess(MQTT_CLIENT, 'debug/something', 1);
      expect(result).toBe(false);
    });

    it('should DENY unrecognized topic patterns', async () => {
      const { service, dataSource } = createService();
      stubFindDeviceRepeated(dataSource, null);
      const result = await service.checkTopicAccess(MQTT_CLIENT, 'random/unknown/topic', 2);
      expect(result).toBe(false);
    });
  });

  // ─── isSuperuser ───────────────────────────────────────────────────────

  describe('isSuperuser', () => {
    it('should always return false', () => {
      const { service } = createService();
      expect(service.isSuperuser('backend_service')).toBe(false);
      expect(service.isSuperuser('any-user')).toBe(false);
    });
  });

  // ─── generateCredentials ───────────────────────────────────────────────

  describe('generateCredentials', () => {
    it('should return password and hash in $7$ format', () => {
      const { service } = createService();
      const { password, hash } = service.generateCredentials();

      expect(password).toBeDefined();
      expect(password.length).toBeGreaterThan(0);
      expect(hash).toMatch(/^\$7\$/);
    });

    it('should generate verifiable credentials', () => {
      const { service } = createService();
      const { password, hash } = service.generateCredentials();

      expect(service.verifyPassword(password, hash)).toBe(true);
    });

    it('should generate unique passwords each time', () => {
      const { service } = createService();
      const c1 = service.generateCredentials();
      const c2 = service.generateCredentials();

      expect(c1.password).not.toBe(c2.password);
      expect(c1.hash).not.toBe(c2.hash);
    });
  });

  // ─── tenant cache behavior ─────────────────────────────────────────────

  describe('tenant cache', () => {
    it('should invalidate cache entry', () => {
      const { service } = createService();
      // invalidateTenantCache should not throw
      expect(() => service.invalidateTenantCache('edge-test')).not.toThrow();
    });

    it('invalidates every cached MQTT identity owned by an erased tenant', async () => {
      const { service, dataSource } = createService();
      stubFindDeviceRepeated(dataSource, makeDevice({ tenantId: TENANT_A }));
      await expect(
        service.checkTopicAccess(
          MQTT_CLIENT,
          `tenants/${TENANT_A}/devices/${MQTT_CLIENT}/telemetry`,
          2,
        ),
      ).resolves.toBe(true);
      dataSource.query.mockClear();

      service.invalidateTenant(TENANT_A);
      await service.checkTopicAccess(
        MQTT_CLIENT,
        `tenants/${TENANT_A}/devices/${MQTT_CLIENT}/telemetry`,
        2,
      );

      expect(dataSource.query).toHaveBeenCalled();
    });
  });
});
