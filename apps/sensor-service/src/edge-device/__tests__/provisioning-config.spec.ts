/**
 * ProvisioningService - Config Management Tests
 *
 * Tests for the provisioning config fetching, caching, and fallback behavior,
 * as well as config usage in installer script generation and device activation.
 */

 
 
 

import {
  NotFoundException,
  ConflictException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { DeviceEvent } from '../entities/device-event.entity';
import {
  EdgeDevice,
  DeviceLifecycleState,
  DeviceModel,
} from '../entities/edge-device.entity';
import { TenantProvisioningKey } from '../entities/tenant-provisioning-key.entity';
import { MqttAuthService } from '../mqtt-auth.service';
import { InstallerScriptService } from '../installer-script.service';
import { TenantKeyService } from '../tenant-key.service';
import { DeviceEventService } from '../device-event.service';
import { ProvisioningService } from '../provisioning.service';

// ---------------------------------------------------------------------------
// Mock global fetch
// ---------------------------------------------------------------------------
const mockFetch = jest.fn();
global.fetch = mockFetch as any;

// ---------------------------------------------------------------------------
// Repository mocks
// ---------------------------------------------------------------------------
const createMockRepository = () => ({
  create: jest.fn().mockImplementation((dto) => ({ id: 'generated-uuid', ...dto })),
  save: jest.fn().mockImplementation((entity) => Promise.resolve({ id: entity.id || 'generated-uuid', ...entity })),
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
  MQTT_BROKER_HOST: 'env-mqtt.example.com',
  MQTT_BROKER_PORT: 8883,
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
  generateCredentials: jest.fn().mockReturnValue({
    password: 'mqtt-plain-password',
    hash: '$7$101$fakesalt$fakehash',
  }),
  addDeviceCredentials: jest.fn().mockResolvedValue(true),
};

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
    provisioningToken: 'a'.repeat(64),
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
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MqttAuthService, useValue: mockMqttAuthService },
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
      const script = await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith('http://admin-api:3010/system/settings/provisioning-config', expect.anything());
      // Script should contain the admin API config values
      expect(script).toContain(adminConfig.provisioningApiUrl);
      expect(script).toContain(adminConfig.agentDefaultVersion);
      expect(script).toContain(adminConfig.githubRepo);
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
      await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second call - should use cache, no additional fetch
      await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);
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
      await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Manually expire the cache on InstallerScriptService
      (installerScriptService as any).configCacheExpiry = new Date(0);

      // Third call - cache expired, should fetch again
      await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should fall back to env vars when admin API is unreachable', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);

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

      const script = await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);

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

      const script = await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);

      expect(script).toContain('https://api.test.com');
      expect(script).toContain('4.0.0');
      expect(script).toContain('TestOrg/edge-agent');
      expect(script).toContain(device.deviceCode);
      expect(script).toContain(device.provisioningToken!);
    });

    it('should include SHA256 checksum verification in script', async () => {
      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);

      expect(script).toContain('sha256sum');
      expect(script).toContain('.sha256');
      expect(script).toContain('Checksum verification failed');
    });

    it('should include correct archive names for architecture detection', async () => {
      const device = buildMockDevice();
      deviceRepo.findOne.mockResolvedValueOnce(device);

      const script = await service.generateInstallerScript(device.deviceCode, device.provisioningToken!);

      expect(script).toContain('suderra-agent-x86_64-linux');
      expect(script).toContain('suderra-agent-aarch64-linux');
      expect(script).toContain('suderra-agent-armv7-linux');
    });

    it('should reject expired token', async () => {
      const expiredDevice = buildMockDevice({
        tokenExpiresAt: new Date(Date.now() - 86400000), // expired 24 h ago
      });
      deviceRepo.findOne.mockResolvedValueOnce(expiredDevice);

      await expect(
        service.generateInstallerScript(expiredDevice.deviceCode, expiredDevice.provisioningToken!),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('should reject already-used token', async () => {
      const usedDevice = buildMockDevice({
        tokenUsedAt: new Date(), // token already consumed
      });
      deviceRepo.findOne.mockResolvedValueOnce(usedDevice);

      await expect(
        service.generateInstallerScript(usedDevice.deviceCode, usedDevice.provisioningToken!),
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

      expect(result.installerUrl).toContain('https://custom-domain.example.com/install/');
      expect(result.installerUrl).toContain('?token=');
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

      expect(result.installerCommand).toMatch(/^curl -sSL "https:\/\/edge\.example\.com\/install\/.+\?token=.+" \| sudo bash$/);
    });
  });

  // =========================================================================
  // activateDevice
  // =========================================================================
  describe('activateDevice', () => {
    it('should use config for MQTT broker in response', async () => {
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
        token: device.provisioningToken!,
        fingerprint: { machineId: 'machine-123', hostname: 'edge-01' },
        agentVersion: '1.0.0',
      });

      expect(result.success).toBe(true);
      expect(result.mqtt_broker).toBe('mqtt.production.example.com');
      expect(result.mqtt_port).toBe(8883);
      expect(result.mqtt_password).toBe('mqtt-plain-password');
      expect(result.device_code).toBe(device.deviceCode);
      expect(result.tenant_id).toBe(device.tenantId);
    });
  });
});
