/**
 * ProvisioningService - Config Management Tests
 *
 * Tests for the provisioning config fetching, caching, and fallback behavior,
 * as well as config usage in installer script generation and device activation.
 */

import { createHash } from 'crypto';

import { NotFoundException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { DeviceEvent } from '../entities/device-event.entity';
import { EdgeDevice, DeviceLifecycleState, DeviceModel } from '../entities/edge-device.entity';
import { TenantProvisioningKey } from '../entities/tenant-provisioning-key.entity';
import { MqttAuthService } from '../mqtt-auth.service';
import { InstallerScriptService } from '../installer-script.service';
import { TenantKeyService } from '../tenant-key.service';
import { DeviceEventService } from '../device-event.service';
import { DeviceDirectoryService } from '../device-directory.service';
import { DeviceBrokerConfigError } from '../device-broker';
import { ProvisioningService } from '../provisioning.service';
import { DeviceLifecycleStatementService } from '../device-lifecycle-statement.service';
import { EdgeProvisioningManifestService } from '../edge-provisioning-manifest.service';
import { EdgeRootHandoffService } from '../edge-root-handoff.service';
import { ProvisioningReservationService } from '../provisioning-reservation.service';

// SENSOR-CRITICAL-143: device writes run inside runInTenantTransaction. The
// boundary itself is proven on real Postgres (edge-mqtt-auth.rls.postgres.spec);
// here the callback receives the same transactional manager the DataSource
// mock's transaction() hands out, so the provisioning logic stays under test.
jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInTenantTransaction: jest.fn(
      (
        dataSource: {
          transaction: (cb: (manager: unknown) => Promise<unknown>) => Promise<unknown>;
        },
        _schema: string,
        _tenantId: string,
        fn: (qr: { manager: unknown }) => Promise<unknown>,
      ) => dataSource.transaction((manager) => fn({ manager })),
    ),
  };
});

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// SENSOR-MEDIUM-011/012: provisioning tokens are hashed at rest. The device
// stores sha256(token); the caller presents the plaintext, which is embedded in
// the installer (header) and validated against the stored digest.
const PLAINTEXT_TOKEN = 'a'.repeat(64);
const HASHED_TOKEN = createHash('sha256').update(PLAINTEXT_TOKEN).digest('hex');

// ---------------------------------------------------------------------------
// Repository mocks
// ---------------------------------------------------------------------------
const createMockRepository = () => ({
  create: jest.fn().mockImplementation((dto) => ({ id: 'generated-uuid', ...dto })),
  save: jest
    .fn()
    .mockImplementation((entity) =>
      Promise.resolve({ id: entity.id || 'generated-uuid', ...entity }),
    ),
  findOne: jest.fn(),
  find: jest.fn(),
  findAndCount: jest.fn(),
  createQueryBuilder: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    getOne: jest.fn(),
    execute: jest.fn(),
  }),
});

// ---------------------------------------------------------------------------
// ConfigService mock
// ---------------------------------------------------------------------------
const ENV_DEFAULTS: Record<string, string | number | boolean> = {
  PROVISIONING_TOKEN_TTL_HOURS: 24,
  PROVISIONING_API_BASE_URL: 'http://env-api.example.com',
  AGENT_VERSION: '2.0.0',
  MQTT_PUBLIC_BROKER_HOST: 'env-mqtt.example.com',
  ADMIN_API_URL: 'http://admin-api:3010',
  EDGE_AGENT_GITHUB_REPO: 'TestOrg/test-repo',
  MQTT_AUTH_ENABLED: false,
};

const mockConfigService = {
  get: jest.fn((key: string, fallback?: any) => {
    return ENV_DEFAULTS[key] ?? fallback;
  }),
};

// ---------------------------------------------------------------------------
// MqttAuthService mock
// ---------------------------------------------------------------------------
const mockMqttAuthService = {
  generateCredentials: jest.fn().mockResolvedValue({
    password: 'mqtt-plain-password',
    hash: '$7$101$fakesalt$fakehash',
  }),
  addDeviceCredentials: jest.fn().mockResolvedValue(true),
};

// ---------------------------------------------------------------------------
// DataSource mock — the service looks devices up via raw cross-schema SQL
// (findDeviceAcrossSchemas) and mutates them inside transactions. The mock
// bridges both paths back to the deviceRepository mock so the per-test
// `deviceRepo.findOne.mockResolvedValue*` arrangements keep working.
// ---------------------------------------------------------------------------
const toSnakeCaseRow = (entity: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(entity).map(([key, value]) => [
      key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`),
      value,
    ]),
  );

const createMockDataSource = (deviceRepository: ReturnType<typeof createMockRepository>) => ({
  query: jest.fn(async (sql: string) => {
    if (sql.includes('information_schema.schemata')) {
      return [{ schema_name: 'tenant_0123456789abcdef' }];
    }
    if (sql.includes('edge_devices')) {
      const device: Record<string, unknown> | null = await deviceRepository.findOne({});
      return device ? [toSnakeCaseRow(device)] : [];
    }
    return [];
  }),
  transaction: jest.fn(async (cb: (manager: unknown) => Promise<unknown>) =>
    cb({
      query: jest.fn().mockResolvedValue(undefined),
      save: deviceRepository.save,
      findOne: deviceRepository.findOne,
      update: jest.fn().mockResolvedValue(undefined),
      getRepository: jest.fn().mockReturnValue(deviceRepository),
    }),
  ),
});

// ---------------------------------------------------------------------------
// Helper: build a mock EdgeDevice
// ---------------------------------------------------------------------------
const buildMockDevice = (overrides: Partial<EdgeDevice> = {}): EdgeDevice =>
  ({
    id: 'device-uuid-1',
    tenantId: 'tenant-uuid-1',
    deviceCode: 'EDGE-AABB1122',
    deviceName: 'Test Edge',
    deviceModel: DeviceModel.CUSTOM,
    lifecycleState: DeviceLifecycleState.REGISTERED,
    provisioningToken: HASHED_TOKEN,
    tokenExpiresAt: new Date(Date.now() + 86400000), // 24 h in future
    tokenUsedAt: undefined,
    mqttClientId: 'edge-tenant-u-edge-aabb1122',
    isOnline: false,
    securityLevel: 2,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }) as EdgeDevice;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('ProvisioningService - Config Management', () => {
  let service: ProvisioningService;
  let installerScriptService: InstallerScriptService;
  let deviceRepo: ReturnType<typeof createMockRepository>;
  let tenantKeyRepo: ReturnType<typeof createMockRepository>;
  let deviceEventRepo: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    jest.clearAllMocks();
    mockFetch.mockReset();

    deviceRepo = createMockRepository();
    tenantKeyRepo = createMockRepository();
    deviceEventRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ProvisioningService,
        InstallerScriptService,
        TenantKeyService,
        DeviceEventService,
        { provide: getRepositoryToken(EdgeDevice), useValue: deviceRepo },
        { provide: getRepositoryToken(TenantProvisioningKey), useValue: tenantKeyRepo },
        { provide: getRepositoryToken(DeviceEvent), useValue: deviceEventRepo },
        { provide: DataSource, useValue: createMockDataSource(deviceRepo) },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MqttAuthService, useValue: mockMqttAuthService },
        {
          provide: ProvisioningReservationService,
          useValue: { issueCredentials: jest.fn().mockResolvedValue(true) },
        },
        { provide: EdgeProvisioningManifestService, useValue: {} },
        { provide: DeviceLifecycleStatementService, useValue: {} },
        { provide: EdgeRootHandoffService, useValue: {} },
        {
          provide: DeviceDirectoryService,
          useValue: {
            // SENSOR-MEDIUM-004: device creation saves through the
            // transaction's manager (the device and its route commit together).
            saveNewDevice: jest.fn(
              (device: EdgeDevice, manager: { save: (e: EdgeDevice) => Promise<EdgeDevice> }) =>
                manager.save(device),
            ),
            // SENSOR-CRITICAL-143: public lookups resolve through findDevice.
            findDevice: jest.fn(async () => deviceRepo.findOne({})),
          },
        },
      ],
    }).compile();

    service = module.get<ProvisioningService>(ProvisioningService);
    installerScriptService = module.get<InstallerScriptService>(InstallerScriptService);
  });

  // =========================================================================
  // getProvisioningConfig (now on InstallerScriptService, tested indirectly)
  // =========================================================================
  describe('getProvisioningConfig', () => {
    it('should fetch config from admin API on first call', async () => {
      const adminConfig = {
        provisioningApiUrl: 'https://api.prod.example.com',
        mqttBrokerHost: 'mqtt.prod.example.com',
        mqttBrokerPort: 1883,
        agentDefaultVersion: '3.1.0',
        githubRepo: 'ProdOrg/prod-repo',
        githubReleaseUrl: 'https://github.com/ProdOrg/prod-repo/releases',
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => adminConfig,
      });

      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      // generateInstallerScript calls getProvisioningConfig internally
      const script = await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'http://admin-api:3010/system/settings/provisioning-config',
        expect.anything(),
      );
      // Script should contain the admin API config values
      expect(script).toContain(adminConfig.provisioningApiUrl);
      expect(script).toContain(adminConfig.agentDefaultVersion);
      // The GitHub repo is pinned from env (EDGE_AGENT_GITHUB_REPO) — the remote
      // config is never trusted for the repo URL (supply-chain hardening)
      expect(script).toContain('TestOrg/test-repo');
      expect(script).not.toContain(adminConfig.githubRepo);
    });

    it('should return cached config within TTL', async () => {
      const adminConfig = {
        provisioningApiUrl: 'https://cached-api.example.com',
        mqttBrokerHost: 'cached-mqtt.example.com',
        mqttBrokerPort: 1883,
        agentDefaultVersion: '3.2.0',
        githubRepo: 'CachedOrg/cached-repo',
        githubReleaseUrl: 'https://github.com/CachedOrg/cached-repo/releases',
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => adminConfig,
      });

      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValue(device);

      // First call - fetches from admin API
      await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call - should use cache, no additional fetch
      await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should refresh config after TTL expires', async () => {
      const adminConfig = {
        provisioningApiUrl: 'https://first-api.example.com',
        mqttBrokerHost: 'first-mqtt.example.com',
        mqttBrokerPort: 1883,
        agentDefaultVersion: '1.0.0',
        githubRepo: 'Org/repo',
        githubReleaseUrl: 'https://github.com/Org/repo/releases',
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => adminConfig,
      });

      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValue(device);

      // First call
      await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Manually expire the cache on InstallerScriptService
      (installerScriptService as any).configCacheExpiry = new Date(0);

      // Third call - cache expired, should fetch again
      await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should fall back to env vars when admin API is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);

      // Should contain env var values from ConfigService mock
      expect(script).toContain('http://env-api.example.com');
      expect(script).toContain('2.0.0');
      expect(script).toContain('TestOrg/test-repo');
    });

    it('should fall back to env vars when admin API returns error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);

      // Should contain env var fallback values
      expect(script).toContain('http://env-api.example.com');
      expect(script).toContain('2.0.0');
    });
  });

  // =========================================================================
  // generateInstallerScript
  // =========================================================================
  describe('generateInstallerScript', () => {
    beforeEach(() => {
      // Default: admin API returns config
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          provisioningApiUrl: 'https://api.test.com',
          mqttBrokerHost: 'mqtt.test.com',
          mqttBrokerPort: 1883,
          agentDefaultVersion: '4.0.0',
          githubRepo: 'TestOrg/edge-agent',
          githubReleaseUrl: 'https://github.com/TestOrg/edge-agent/releases',
        }),
      });
    });

    it('should use config from admin API in generated script', async () => {
      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);

      expect(script).toContain('https://api.test.com');
      expect(script).toContain('4.0.0');
      // Repo comes from the pinned env value, not from the admin API response
      expect(script).toContain('TestOrg/test-repo');
      expect(script).toContain(device.deviceCode);
      expect(script).toContain(PLAINTEXT_TOKEN);
    });

    it('writes the pinned broker on 8883 with TLS, never the admin API host or port (SENSOR-MEDIUM-220)', async () => {
      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);

      expect(script).toContain(
        'mqtt:\n  broker: "env-mqtt.example.com"\n  port: 8883\n  tls:\n    enabled: true\n',
      );
      expect(script).not.toContain('mqtt.test.com');
      expect(script).not.toContain('1883');
    });

    it('refuses to start with a device broker that is not a bare host name', () => {
      for (const host of ['mqtt://env-mqtt.example.com:1883', 'env-mqtt.example.com:1883', '']) {
        expect(
          () =>
            new InstallerScriptService(
              new ConfigService({ ...ENV_DEFAULTS, MQTT_PUBLIC_BROKER_HOST: host }),
            ),
        ).toThrow(DeviceBrokerConfigError);
      }
    });

    it('should include SHA256 checksum verification in script', async () => {
      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);

      expect(script).toContain('sha256sum');
      expect(script).toContain('.sha256');
      expect(script).toContain('Checksum verification failed');
    });

    it('should include correct archive names for architecture detection', async () => {
      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, PLAINTEXT_TOKEN);

      expect(script).toContain('TARGET_SLUG="x86_64-linux"');
      expect(script).toContain('TARGET_SLUG="aarch64-linux"');
      expect(script).toContain('TARGET_SLUG="armv7-linux"');
      // Versioned tarball name: suderra-agent-<version>-<slug>.tar.gz
      expect(script).toContain('suderra-agent-${RELEASE_VERSION}-${TARGET_SLUG}.tar.gz');
    });

    it('should reject expired token', async () => {
      const expiredDevice = buildMockDevice({
        tokenExpiresAt: new Date(Date.now() - 86400000), // expired 24 h ago
      });
      deviceRepo.findOne.mockResolvedValueOnce(expiredDevice);

      await expect(
        service.generateInstallerScript(expiredDevice.deviceCode, PLAINTEXT_TOKEN),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject already-used token', async () => {
      const usedDevice = buildMockDevice({
        tokenUsedAt: new Date(), // token already consumed
      });
      deviceRepo.findOne.mockResolvedValueOnce(usedDevice);

      await expect(
        service.generateInstallerScript(usedDevice.deviceCode, PLAINTEXT_TOKEN),
      ).rejects.toThrow(ConflictException);
    });
  });

  // =========================================================================
  // buildInstallerUrl (now on InstallerScriptService, tested via createProvisionedDevice response)
  // =========================================================================
  describe('buildInstallerUrl', () => {
    it('should use apiBaseUrl from config', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          provisioningApiUrl: 'https://custom-domain.example.com',
          mqttBrokerHost: 'mqtt.example.com',
          mqttBrokerPort: 1883,
          agentDefaultVersion: 'latest',
          githubRepo: 'Org/repo',
          githubReleaseUrl: 'https://github.com/Org/repo/releases',
        }),
      });

      // createProvisionedDevice returns an installerUrl built from config
      deviceRepo.findOne.mockResolvedValue(null); // no collision
      deviceRepo.save.mockImplementation((entity: any) =>
        Promise.resolve({ id: 'new-device-id', ...entity }),
      );

      const result = await service.createProvisionedDevice('tenant-uuid', {
        deviceName: 'My Device',
      });

      // SENSOR-MEDIUM-002: the token is carried in a header, never the URL.
      expect(result.installerUrl).toContain('https://custom-domain.example.com/install/');
      expect(result.installerUrl).not.toContain('?token=');
    });
  });

  // =========================================================================
  // buildInstallerCommand (now on InstallerScriptService, tested via createProvisionedDevice response)
  // =========================================================================
  describe('buildInstallerCommand', () => {
    it('should generate curl command with correct URL', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          provisioningApiUrl: 'https://edge.example.com',
          mqttBrokerHost: 'mqtt.example.com',
          mqttBrokerPort: 1883,
          agentDefaultVersion: 'latest',
          githubRepo: 'Org/repo',
          githubReleaseUrl: 'https://github.com/Org/repo/releases',
        }),
      });

      deviceRepo.findOne.mockResolvedValue(null);
      deviceRepo.save.mockImplementation((entity: any) =>
        Promise.resolve({ id: 'new-device-id', ...entity }),
      );

      const result = await service.createProvisionedDevice('tenant-uuid', {
        deviceName: 'Curl Test Device',
      });

      // SENSOR-MEDIUM-002: token travels in the X-Provisioning-Token header.
      expect(result.installerCommand).toMatch(
        /^curl -sSL -H "X-Provisioning-Token: .+" "https:\/\/edge\.example\.com\/install\/.+" \| sudo bash$/,
      );
    });
  });

  // =========================================================================
  // activateDevice
  // =========================================================================
  describe('activateDevice', () => {
    it('names the pinned 8883 TLS broker, never one the admin API sends (SENSOR-MEDIUM-220)', async () => {
      const adminConfig = {
        provisioningApiUrl: 'https://api.example.com',
        mqttBrokerHost: 'mqtt.production.example.com',
        mqttBrokerPort: 8883,
        agentDefaultVersion: 'latest',
        githubRepo: 'Org/repo',
        githubReleaseUrl: 'https://github.com/Org/repo/releases',
      };
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => adminConfig,
      });

      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);
      deviceRepo.save.mockImplementation((entity: any) => Promise.resolve(entity));

      const result = await service.activateDevice({
        deviceId: device.id,
        token: PLAINTEXT_TOKEN,
        fingerprint: { machineId: 'machine-123', hostname: 'edge-01' },
        agentVersion: '1.0.0',
      });

      expect(result.success).toBe(true);
      expect(result.mqtt_broker).toBe('env-mqtt.example.com');
      expect(result.mqtt_port).toBe(8883);
      expect(result.mqtt_tls_enabled).toBe(true);
      expect(result.mqtt_password).toBe('mqtt-plain-password');
      expect(result.device_code).toBe(device.deviceCode);
      expect(result.tenant_id).toBe(device.tenantId);
    });
  });
});
