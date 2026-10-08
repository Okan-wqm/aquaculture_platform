/**
 * MqttAuthService Unit Tests
 *
 * Covers critical security paths:
 * - Device authentication (valid, invalid, lifecycle allow-list, client ID)
 * - Cross-tenant ACL enforcement
 * - Legacy edge/ topic handling
 * - Service account patterns
 * - Timing-safe comparison
 */

import { createHash, timingSafeEqual, pbkdf2Sync, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { EdgeDevice, DeviceLifecycleState } from '../entities/edge-device.entity';
import { collaborator } from '@aquaculture/testing';

import { DeviceDirectoryService } from '../device-directory.service';
import { MqttAuthService } from '../mqtt-auth.service';

// ─── helpers ────────────────────────────────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';
const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DEVICE_UUID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const MQTT_CLIENT = 'edge-c2447348-pi-a36c09d4';
const DEVICE_CODE = 'PI-A36C09D4';
/** The client ID the edge gateway derives: `${username}-${deviceCode}`. */
const OWN_CLIENT_ID = `${MQTT_CLIENT}-${DEVICE_CODE}`;

/** Lifecycle states that may hold a broker session, and those that may not. */
const IN_SERVICE_STATES = [
  DeviceLifecycleState.ACTIVE,
  DeviceLifecycleState.OFFLINE,
  DeviceLifecycleState.MAINTENANCE,
  DeviceLifecycleState.ERROR,
];
const NOT_IN_SERVICE_STATES = Object.values(DeviceLifecycleState).filter(
  (state) => !IN_SERVICE_STATES.includes(state),
);

function makeDevice(overrides: Partial<EdgeDevice> = {}): EdgeDevice {
  const d = new EdgeDevice();
  d.id = DEVICE_UUID;
  d.tenantId = TENANT_A;
  d.deviceCode = DEVICE_CODE;
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
    ...overrides,
  };
  return {
    get: jest.fn((key: string, defaultValue?: unknown) =>
      defaults[key] !== undefined ? defaults[key] : defaultValue,
    ),
  } as unknown as ConfigService;
}

function createService(
  opts: {
    configOverrides?: Record<string, unknown>;
  } = {},
) {
  const cfg = createMockConfigService(opts.configOverrides);
  // Device resolution lives in DeviceDirectoryService.findDevice
  // (SENSOR-CRITICAL-143); it misses by default.
  const directory = {
    findDevice: jest.fn().mockResolvedValue(null),
  };
  return {
    service: new MqttAuthService(
      cfg,
      collaborator<DeviceDirectoryService>(directory, 'DeviceDirectoryService'),
    ),
    cfg,
    directory,
  };
}

type DirectoryStub = ReturnType<typeof createService>['directory'];

/** The next device lookup resolves to `device`. */
function stubFindDevice(directory: DirectoryStub, device: EdgeDevice | null): void {
  directory.findDevice.mockResolvedValueOnce(device);
}

/** Every device lookup resolves to `device`. */
function stubFindDeviceRepeated(directory: DirectoryStub, device: EdgeDevice | null): void {
  directory.findDevice.mockResolvedValue(device);
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
      const { service, directory } = createService();
      stubFindDevice(directory, device);

      const result = await service.verifyDeviceCredentials(MQTT_CLIENT, password, OWN_CLIENT_ID);
      expect(result).toBe(true);
    });

    it('accepts the bare username as client ID', async () => {
      const password = 'my-secret-password';
      const { service, directory } = createService();
      stubFindDevice(directory, makeDevice({ mqttPasswordHash: hashPassword(password) }));

      await expect(
        service.verifyDeviceCredentials(MQTT_CLIENT, password, MQTT_CLIENT),
      ).resolves.toBe(true);
    });

    it.each([
      ['the ingestion listener', 'aqua-sensor-service-main'],
      ['another gateway', 'edge-otherdev-RPI-01'],
      ['a sibling suffix of its own username', `${MQTT_CLIENT}-PI-OTHER01`],
      ['its username with a trailing dash', `${MQTT_CLIENT}-`],
      ['a missing client ID', undefined],
    ])(
      'rejects valid credentials under %s client ID (SENSOR-HIGH-144)',
      async (_label, clientId) => {
        const password = 'my-secret-password';
        const device = makeDevice({ mqttPasswordHash: hashPassword(password) });
        const { service, directory } = createService();
        stubFindDevice(directory, device);

        await expect(
          service.verifyDeviceCredentials(MQTT_CLIENT, password, clientId),
        ).resolves.toBe(false);
      },
    );

    it.each(IN_SERVICE_STATES)('accepts a %s device with valid credentials', async (state) => {
      const password = 'my-secret';
      const { service, directory } = createService();
      stubFindDevice(
        directory,
        makeDevice({ mqttPasswordHash: hashPassword(password), lifecycleState: state }),
      );

      await expect(
        service.verifyDeviceCredentials(MQTT_CLIENT, password, OWN_CLIENT_ID),
      ).resolves.toBe(true);
    });

    it.each(NOT_IN_SERVICE_STATES)(
      'rejects a %s device even with a valid password (lifecycle allow-list)',
      async (state) => {
        const password = 'my-secret';
        const { service, directory } = createService();
        stubFindDevice(
          directory,
          makeDevice({ mqttPasswordHash: hashPassword(password), lifecycleState: state }),
        );

        await expect(
          service.verifyDeviceCredentials(MQTT_CLIENT, password, OWN_CLIENT_ID),
        ).resolves.toBe(false);
      },
    );

    it('logs a refused CONNECT at debug with a username fingerprint, never the raw username', async () => {
      const { service, directory } = createService();
      stubFindDevice(directory, null);
      const debug = jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const hostile = 'edge-x\n[FAKE] admin login ok';

      await service.verifyDeviceCredentials(hostile, 'pw', hostile);

      expect(warn).not.toHaveBeenCalled();
      expect(debug).toHaveBeenCalledWith({
        event: 'mqtt_device_auth_denied',
        reason: 'device_not_found',
        principal: MqttAuthService.principalFingerprint(hostile),
      });
      expect(JSON.stringify(debug.mock.calls)).not.toContain('FAKE');
    });

    it('should reject invalid password', async () => {
      const hash = hashPassword('correct-password');
      const device = makeDevice({ mqttPasswordHash: hash });
      const { service, directory } = createService();
      stubFindDevice(directory, device);

      const result = await service.verifyDeviceCredentials(
        MQTT_CLIENT,
        'wrong-password',
        OWN_CLIENT_ID,
      );
      expect(result).toBe(false);
    });

    it('should reject device not found', async () => {
      const { service, directory } = createService();
      stubFindDevice(directory, null);

      const result = await service.verifyDeviceCredentials(
        'nonexistent-device',
        'any',
        'nonexistent-device',
      );
      expect(result).toBe(false);
    });

    it('should reject device without password hash', async () => {
      const device = makeDevice({ mqttPasswordHash: undefined });
      const { service, directory } = createService();
      stubFindDevice(directory, device);

      const result = await service.verifyDeviceCredentials(MQTT_CLIENT, 'any', OWN_CLIENT_ID);
      expect(result).toBe(false);
    });

    it('should authenticate service account via env hash', async () => {
      const servicePassword = 'backend-secret-123';
      const serviceHash = hashPassword(servicePassword);
      const { service } = createService({
        configOverrides: { MQTT_BACKEND_SERVICE_HASH: serviceHash },
      });

      const result = await service.verifyDeviceCredentials(
        'backend_service',
        servicePassword,
        'aqua-backend-01',
      );
      expect(result).toBe(true);
    });

    it('should reject service account with wrong password', async () => {
      const serviceHash = hashPassword('correct-secret');
      const { service } = createService({
        configOverrides: { MQTT_BACKEND_SERVICE_HASH: serviceHash },
      });

      const result = await service.verifyDeviceCredentials(
        'backend_service',
        'wrong',
        'aqua-backend-01',
      );
      expect(result).toBe(false);
    });
  });

  // ─── verifyPassword (timing-safe) ──────────────────────────────────────

  describe('verifyPassword (timing-safe)', () => {
    it('should return true for matching password', async () => {
      const { service } = createService();
      const password = 'test-timing-safe';
      const hash = hashPassword(password);

      await expect(service.verifyPassword(password, hash)).resolves.toBe(true);
    });

    it('should return false for non-matching password', async () => {
      const { service } = createService();
      const hash = hashPassword('correct');

      await expect(service.verifyPassword('incorrect', hash)).resolves.toBe(false);
    });

    it('should return false for malformed hash (missing parts)', async () => {
      const { service } = createService();
      await expect(service.verifyPassword('any', '$7$101$salt')).resolves.toBe(false);
    });

    it('should return false for hash with wrong prefix', async () => {
      const { service } = createService();
      await expect(service.verifyPassword('any', '$6$101$salt$hash')).resolves.toBe(false);
    });

    it('should return false for completely invalid hash', async () => {
      const { service } = createService();
      await expect(service.verifyPassword('any', 'not-a-hash')).resolves.toBe(false);
    });

    it('should not throw on corrupt base64 data', async () => {
      const { service } = createService();
      // verifyPassword should catch and return false, not throw
      await expect(service.verifyPassword('any', '$7$101$!!!$!!!')).resolves.toBe(false);
    });
  });

  // ─── checkTopicAccess: tenant-prefixed topics ──────────────────────────

  describe('checkTopicAccess (tenant-prefixed)', () => {
    it('should ALLOW own tenant topic using mqttClientId', async () => {
      const device = makeDevice({ tenantId: TENANT_A });
      const { service, directory } = createService();
      stubFindDeviceRepeated(directory, device);

      const topic = `tenants/${TENANT_A}/devices/${MQTT_CLIENT}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(true);
    });

    it('should ALLOW own tenant topic using device UUID', async () => {
      const device = makeDevice({ tenantId: TENANT_A, id: DEVICE_UUID });
      const { service, directory } = createService();
      stubFindDeviceRepeated(directory, device);

      const topic = `tenants/${TENANT_A}/devices/${DEVICE_UUID}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(true);
    });

    it('should DENY cross-tenant topic access (other tenant ID)', async () => {
      const device = makeDevice({ tenantId: TENANT_A });
      const { service, directory } = createService();
      stubFindDeviceRepeated(directory, device);

      const topic = `tenants/${TENANT_B}/devices/${MQTT_CLIENT}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(false);
    });

    it.each(NOT_IN_SERVICE_STATES)(
      'should DENY its own tenant topic to a %s device (same allow-list as CONNECT)',
      async (state) => {
        const { service, directory } = createService();
        stubFindDeviceRepeated(
          directory,
          makeDevice({ tenantId: TENANT_A, lifecycleState: state }),
        );

        for (const deviceSegment of [MQTT_CLIENT, DEVICE_UUID]) {
          await expect(
            service.checkTopicAccess(
              MQTT_CLIENT,
              `tenants/${TENANT_A}/devices/${deviceSegment}/telemetry`,
              2,
            ),
          ).resolves.toBe(false);
        }
      },
    );

    it('re-reads the device on every ACL check, so a state change applies to the next message', async () => {
      const { service, directory } = createService();
      directory.findDevice
        .mockResolvedValueOnce(makeDevice({ tenantId: TENANT_A }))
        .mockResolvedValueOnce(
          makeDevice({ tenantId: TENANT_A, lifecycleState: DeviceLifecycleState.DECOMMISSIONED }),
        );
      const topic = `tenants/${TENANT_A}/devices/${DEVICE_UUID}/telemetry`;

      await expect(service.checkTopicAccess(MQTT_CLIENT, topic, 2)).resolves.toBe(true);
      await expect(service.checkTopicAccess(MQTT_CLIENT, topic, 2)).resolves.toBe(false);
      expect(directory.findDevice).toHaveBeenCalledTimes(2);
    });

    it('should DENY when device not found in DB', async () => {
      const { service, directory } = createService();
      stubFindDeviceRepeated(directory, null);

      const topic = `tenants/${TENANT_A}/devices/${MQTT_CLIENT}/telemetry`;
      const result = await service.checkTopicAccess(MQTT_CLIENT, topic, 2);
      expect(result).toBe(false);
    });

    it('should DENY when device ID in topic does not match username or device UUID', async () => {
      const device = makeDevice({ tenantId: TENANT_A });
      const { service, directory } = createService();
      stubFindDeviceRepeated(directory, device);

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

    it('unknown service account should be denied', async () => {
      const { service } = createService();
      const topic = `tenants/${TENANT_A}/devices/d1/data`;
      // 'unknown_service' is not in serviceAccountNames, so falls through to device logic
      // No device found -> denied
      const { service: s, directory: ds } = createService();
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
      const { service, directory } = createService();
      stubFindDeviceRepeated(directory, null);
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
    it('should return password and hash in $7$ format', async () => {
      const { service } = createService();
      const { password, hash } = await service.generateCredentials();

      expect(password).toBeDefined();
      expect(password.length).toBeGreaterThan(0);
      expect(hash).toMatch(/^\$7\$/);
    });

    it('should generate verifiable credentials', async () => {
      const { service } = createService();
      const { password, hash } = await service.generateCredentials();

      await expect(service.verifyPassword(password, hash)).resolves.toBe(true);
    });

    it('should generate unique passwords each time', async () => {
      const { service } = createService();
      const c1 = await service.generateCredentials();
      const c2 = await service.generateCredentials();

      expect(c1.password).not.toBe(c2.password);
      expect(c1.hash).not.toBe(c2.hash);
    });
  });
});

// ─── SENSOR-HIGH-118: ACL × listener subscription filters ───────────────────
//
// One denied filter used to fail the whole single-packet SUBSCRIBE and kill
// ALL MQTT ingestion. The grants above the ACL derive from the exported
// filter list (the SSoT) — these tests iterate that list so the two can
// never drift apart.

import {
  SENSOR_SERVICE_SUBSCRIPTION_FILTERS,
  LEGACY_EDGE_SUBSCRIPTION_FILTERS,
} from '../../ingestion/mqtt-listener.service';

describe('sensor_service ACL × SENSOR_SERVICE_SUBSCRIPTION_FILTERS (SENSOR-HIGH-118)', () => {
  const { service } = createService({ configOverrides: { NODE_ENV: 'production' } });

  it.each(SENSOR_SERVICE_SUBSCRIPTION_FILTERS)(
    'allows the listener filter "%s" for wildcard SUBSCRIBE (acc=4)',
    async (filter) => {
      await expect(service.checkTopicAccess('sensor_service', filter, 4)).resolves.toBe(true);
    },
  );

  it.each(SENSOR_SERVICE_SUBSCRIPTION_FILTERS)(
    'allows the listener filter "%s" for read-variants (acc=1 and acc=5)',
    async (filter) => {
      await expect(service.checkTopicAccess('sensor_service', filter, 1)).resolves.toBe(true);
      await expect(service.checkTopicAccess('sensor_service', filter, 5)).resolves.toBe(true);
    },
  );

  it.each(LEGACY_EDGE_SUBSCRIPTION_FILTERS)(
    'allows the legacy edge/ filter "%s" (prefix grant covers any acc)',
    async (filter) => {
      await expect(service.checkTopicAccess('sensor_service', filter, 4)).resolves.toBe(true);
    },
  );

  it('denies the broad tenants/+/devices/+/# wildcard (SEC-MEDIUM-130 intent preserved)', async () => {
    await expect(
      service.checkTopicAccess('sensor_service', 'tenants/+/devices/+/#', 4),
    ).resolves.toBe(false);
    await expect(service.checkTopicAccess('sensor_service', 'tenants/#', 4)).resolves.toBe(false);
    await expect(service.checkTopicAccess('sensor_service', '+/+/+/#', 4)).resolves.toBe(false);
  });

  it('denies publish (acc=2) on subscription filters — filters are subscribe-only', async () => {
    await expect(
      service.checkTopicAccess('sensor_service', 'tenants/+/devices/+/telemetry', 2),
    ).resolves.toBe(false);
    await expect(
      service.checkTopicAccess('sensor_service', '+/+/+/temperature-array', 2),
    ).resolves.toBe(false);
  });

  it('still allows concrete tenant topics for delivery (acc=1 on a real path)', async () => {
    await expect(
      service.checkTopicAccess('sensor_service', `tenants/${TENANT_A}/devices/edge-1/telemetry`, 1),
    ).resolves.toBe(true);
  });
});
