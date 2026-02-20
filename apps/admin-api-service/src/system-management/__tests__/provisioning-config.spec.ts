/**
 * GlobalSettingsService - Provisioning Config Tests
 *
 * Tests for getProvisioningConfig and updateProvisioningConfig methods
 * that manage edge device provisioning settings stored in global_configs.
 */

/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-return */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import {
  GlobalConfig,
  ConfigCategory,
  ConfigValueType,
} from '../entities/global-config.entity';
import { FeatureToggle } from '../entities/feature-toggle.entity';
import { MaintenanceMode } from '../entities/maintenance-mode.entity';
import { SystemVersion } from '../entities/system-version.entity';
import { GlobalSettingsService } from '../services/global-settings.service';

// ---------------------------------------------------------------------------
// Repository mock helpers
// ---------------------------------------------------------------------------
const createMockRepository = () => ({
  create: jest.fn().mockImplementation((dto) => ({ id: 'generated-uuid', ...dto })),
  save: jest.fn().mockImplementation((entity) =>
    Promise.resolve({ id: entity.id || 'generated-uuid', ...entity }),
  ),
  findOne: jest.fn().mockResolvedValue(null),
  find: jest.fn().mockResolvedValue([]),
  count: jest.fn().mockResolvedValue(0),
  remove: jest.fn(),
  update: jest.fn(),
  createQueryBuilder: jest.fn().mockReturnValue({
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  }),
});

// ---------------------------------------------------------------------------
// Helper: build a mock GlobalConfig
// ---------------------------------------------------------------------------
const buildMockConfig = (overrides: Partial<GlobalConfig> = {}): GlobalConfig =>
  ({
    id: 'config-uuid',
    key: 'provisioning.api_url',
    name: 'provisioning.api_url',
    description: 'Provisioning setting: api_url',
    category: ConfigCategory.PROVISIONING,
    valueType: ConfigValueType.STRING,
    value: 'https://api.example.com',
    isSecret: false,
    isReadOnly: false,
    requiresRestart: false,
    isEnvironmentSpecific: false,
    maxHistoryEntries: 10,
    sortOrder: 0,
    history: [],
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  }) as GlobalConfig;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('GlobalSettingsService - Provisioning Config', () => {
  let service: GlobalSettingsService;
  let globalConfigRepo: ReturnType<typeof createMockRepository>;
  let featureToggleRepo: ReturnType<typeof createMockRepository>;
  let maintenanceModeRepo: ReturnType<typeof createMockRepository>;
  let systemVersionRepo: ReturnType<typeof createMockRepository>;

  beforeEach(async () => {
    jest.clearAllMocks();

    globalConfigRepo = createMockRepository();
    featureToggleRepo = createMockRepository();
    maintenanceModeRepo = createMockRepository();
    systemVersionRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GlobalSettingsService,
        { provide: getRepositoryToken(GlobalConfig), useValue: globalConfigRepo },
        { provide: getRepositoryToken(FeatureToggle), useValue: featureToggleRepo },
        { provide: getRepositoryToken(MaintenanceMode), useValue: maintenanceModeRepo },
        { provide: getRepositoryToken(SystemVersion), useValue: systemVersionRepo },
      ],
    }).compile();

    service = module.get<GlobalSettingsService>(GlobalSettingsService);
  });

  // =========================================================================
  // getProvisioningConfig
  // =========================================================================
  describe('getProvisioningConfig', () => {
    it('should return default values when no configs in DB', async () => {
      globalConfigRepo.find.mockResolvedValueOnce([]); // no provisioning configs

      const result = await service.getProvisioningConfig();

      expect(result).toEqual({
        provisioningApiUrl: 'http://localhost:3000',
        mqttBrokerHost: 'localhost',
        mqttBrokerPort: 1883,
        githubReleaseUrl: 'https://github.com/Okan-wqm/aquaculture_platform/releases',
        agentDefaultVersion: 'latest',
        githubRepo: 'Okan-wqm/aquaculture_platform',
      });
      expect(globalConfigRepo.find).toHaveBeenCalledWith({
        where: { category: ConfigCategory.PROVISIONING },
      });
    });

    it('should return DB values when configs exist', async () => {
      const dbConfigs: Partial<GlobalConfig>[] = [
        buildMockConfig({ key: 'provisioning.api_url', value: 'https://prod-api.example.com' }),
        buildMockConfig({ key: 'provisioning.mqtt_broker_host', value: 'mqtt.prod.example.com' }),
        buildMockConfig({ key: 'provisioning.mqtt_broker_port', value: '8883' }),
        buildMockConfig({ key: 'provisioning.github_release_url', value: 'https://github.com/Prod/releases' }),
        buildMockConfig({ key: 'provisioning.agent_default_version', value: '5.0.0' }),
        buildMockConfig({ key: 'provisioning.github_repo', value: 'ProdOrg/prod-agent' }),
      ];
      globalConfigRepo.find.mockResolvedValueOnce(dbConfigs);

      const result = await service.getProvisioningConfig();

      expect(result).toEqual({
        provisioningApiUrl: 'https://prod-api.example.com',
        mqttBrokerHost: 'mqtt.prod.example.com',
        mqttBrokerPort: 8883,
        githubReleaseUrl: 'https://github.com/Prod/releases',
        agentDefaultVersion: '5.0.0',
        githubRepo: 'ProdOrg/prod-agent',
      });
    });

    it('should merge DB values with defaults for missing keys', async () => {
      // Only some keys exist in DB
      const partialConfigs: Partial<GlobalConfig>[] = [
        buildMockConfig({ key: 'provisioning.api_url', value: 'https://partial-api.example.com' }),
        buildMockConfig({ key: 'provisioning.mqtt_broker_host', value: 'mqtt.partial.example.com' }),
      ];
      globalConfigRepo.find.mockResolvedValueOnce(partialConfigs);

      const result = await service.getProvisioningConfig();

      // DB values
      expect(result.provisioningApiUrl).toBe('https://partial-api.example.com');
      expect(result.mqttBrokerHost).toBe('mqtt.partial.example.com');
      // Default values for missing keys
      expect(result.mqttBrokerPort).toBe(1883);
      expect(result.githubReleaseUrl).toBe('https://github.com/Okan-wqm/aquaculture_platform/releases');
      expect(result.agentDefaultVersion).toBe('latest');
      expect(result.githubRepo).toBe('Okan-wqm/aquaculture_platform');
    });
  });

  // =========================================================================
  // updateProvisioningConfig
  // =========================================================================
  describe('updateProvisioningConfig', () => {
    it('should update existing config', async () => {
      const existingConfig = buildMockConfig({
        id: 'existing-config-id',
        key: 'provisioning.api_url',
        value: 'http://old-api.example.com',
      });
      globalConfigRepo.findOne
        .mockResolvedValueOnce(existingConfig) // lookup by key in updateProvisioningConfig
        .mockResolvedValueOnce(existingConfig); // lookup by id in updateConfig

      await service.updateProvisioningConfig(
        { 'provisioning.api_url': 'https://new-api.example.com' },
        'admin-user-1',
      );

      // updateConfig should have been called (which calls save)
      expect(globalConfigRepo.findOne).toHaveBeenCalledWith({
        where: { key: 'provisioning.api_url' },
      });
      expect(globalConfigRepo.save).toHaveBeenCalled();
      const savedEntity = globalConfigRepo.save.mock.calls[0][0];
      expect(savedEntity.value).toBe('https://new-api.example.com');
    });

    it('should create new config if key does not exist', async () => {
      // findOne returns null for key lookup (key doesn't exist)
      globalConfigRepo.findOne.mockResolvedValueOnce(null);
      // findOne returns null for duplicate check in createConfig
      globalConfigRepo.findOne.mockResolvedValueOnce(null);

      await service.updateProvisioningConfig(
        { 'provisioning.new_setting': 'new-value' },
        'admin-user-1',
      );

      // createConfig should have been called
      expect(globalConfigRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'provisioning.new_setting',
          name: 'provisioning.new_setting',
          value: 'new-value',
          category: ConfigCategory.PROVISIONING,
          valueType: ConfigValueType.STRING,
        }),
      );
      expect(globalConfigRepo.save).toHaveBeenCalled();
    });

    it('should prefix keys with provisioning. if not already prefixed', async () => {
      // Key without prefix
      globalConfigRepo.findOne.mockResolvedValueOnce(null);
      globalConfigRepo.findOne.mockResolvedValueOnce(null);

      await service.updateProvisioningConfig(
        { mqtt_broker_host: 'mqtt.new.example.com' },
        'admin-user-1',
      );

      // Should have looked up with the full prefixed key
      expect(globalConfigRepo.findOne).toHaveBeenCalledWith({
        where: { key: 'provisioning.mqtt_broker_host' },
      });
      // createConfig should use prefixed key
      expect(globalConfigRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'provisioning.mqtt_broker_host',
        }),
      );
    });
  });
});
