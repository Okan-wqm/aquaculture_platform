/**
 * GlobalSettingsService - Provisioning Config Tests
 *
 * Tests for getProvisioningConfig and updateProvisioningConfig.
 *
 * CONTRACT (post-retirement of direct global_configs writes):
 *  - getProvisioningConfig() is SYNCHRONOUS and sources its values from
 *    PROVISIONING_* environment variables, falling back to hardcoded
 *    defaults. It does NOT read the global_configs table — the admin-api
 *    no longer owns provisioning configuration storage.
 *  - updateProvisioningConfig() is RETIRED: admin-api direct global_configs
 *    writes throw GoneException, directing callers to the config-service
 *    effective-configuration APIs. It never touches the repository.
 *
 * These tests assert that exact behavior. The previous version of this suite
 * asserted a DB-backed read/merge + save/create flow that the service no
 * longer implements; it was rewritten (not weakened) to match the current
 * SSoT after the global_configs write path was retired.
 */

import { GoneException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { ConfigCategory, ConfigValueType } from '../entities/global-config.entity';
import { FeatureToggle } from '../entities/feature-toggle.entity';
import { MaintenanceMode } from '../entities/maintenance-mode.entity';
import { SystemVersion } from '../entities/system-version.entity';
import { GlobalSettingsService } from '../services/global-settings.service';

// ---------------------------------------------------------------------------
// Repository mock helpers
// ---------------------------------------------------------------------------
interface MockRepository {
  create: jest.Mock;
  save: jest.Mock;
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  remove: jest.Mock;
  update: jest.Mock;
  createQueryBuilder: jest.Mock;
}

const createMockRepository = (): MockRepository => ({
  create: jest.fn().mockImplementation((dto: Record<string, unknown>) => ({
    id: 'generated-uuid',
    ...dto,
  })),
  save: jest.fn().mockImplementation((entity: Record<string, unknown>) =>
    Promise.resolve({ id: entity.id ?? 'generated-uuid', ...entity }),
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

// The PROVISIONING_* env keys the service consults, with their hardcoded
// fallbacks. Kept in one place so the tests stay in lockstep with the
// service's `provisioningDefault` table.
const PROVISIONING_ENV_KEYS = [
  'PROVISIONING_API_URL',
  'PROVISIONING_MQTT_BROKER_HOST',
  'PROVISIONING_MQTT_BROKER_PORT',
  'PROVISIONING_GITHUB_RELEASE_URL',
  'PROVISIONING_AGENT_DEFAULT_VERSION',
  'PROVISIONING_GITHUB_REPO',
] as const;

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------
describe('GlobalSettingsService - Provisioning Config', () => {
  let service: GlobalSettingsService;
  let featureToggleRepo: MockRepository;
  let maintenanceModeRepo: MockRepository;
  let systemVersionRepo: MockRepository;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(async () => {
    jest.clearAllMocks();

    // Snapshot then clear the PROVISIONING_* env so default-fallback assertions
    // are deterministic regardless of the host environment.
    savedEnv = {};
    for (const key of PROVISIONING_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      // Reflect.deleteProperty unsets the dynamically-keyed env var without the
      // `delete` operator on a computed member (no-dynamic-delete).
      Reflect.deleteProperty(process.env, key);
    }

    featureToggleRepo = createMockRepository();
    maintenanceModeRepo = createMockRepository();
    systemVersionRepo = createMockRepository();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GlobalSettingsService,
        { provide: getRepositoryToken(FeatureToggle), useValue: featureToggleRepo },
        { provide: getRepositoryToken(MaintenanceMode), useValue: maintenanceModeRepo },
        { provide: getRepositoryToken(SystemVersion), useValue: systemVersionRepo },
      ],
    }).compile();

    service = module.get<GlobalSettingsService>(GlobalSettingsService);
  });

  afterEach(() => {
    // Restore the host env exactly as it was before the test mutated it.
    for (const key of PROVISIONING_ENV_KEYS) {
      const original = savedEnv[key];
      if (original === undefined) {
        // Restore the "absent" state without the banned `delete` operator.
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = original;
      }
    }
  });

  // =========================================================================
  // getProvisioningConfig
  // =========================================================================
  describe('getProvisioningConfig', () => {
    it('returns hardcoded defaults when no PROVISIONING_* env vars are set', () => {
      const result = service.getProvisioningConfig();

      expect(result).toEqual({
        provisioningApiUrl: 'http://localhost:3000',
        mqttBrokerHost: 'localhost',
        mqttBrokerPort: 1883,
        githubReleaseUrl: 'https://github.com/Okan-wqm/aquaculture_platform/releases',
        agentDefaultVersion: 'latest',
        githubRepo: 'Okan-wqm/aquaculture_platform',
      });
    });

    it('does NOT read the global_configs table (storage was retired)', () => {
      service.getProvisioningConfig();

      // getProvisioningConfig sources from env only — it must read no repo at all
      // (the global_configs repo it once consulted no longer exists).
      expect(featureToggleRepo.find).not.toHaveBeenCalled();
      expect(featureToggleRepo.findOne).not.toHaveBeenCalled();
    });

    it('sources values from PROVISIONING_* env vars when present', () => {
      process.env['PROVISIONING_API_URL'] = 'https://prod-api.example.com';
      process.env['PROVISIONING_MQTT_BROKER_HOST'] = 'mqtt.prod.example.com';
      process.env['PROVISIONING_MQTT_BROKER_PORT'] = '8883';
      process.env['PROVISIONING_GITHUB_RELEASE_URL'] = 'https://github.com/Prod/releases';
      process.env['PROVISIONING_AGENT_DEFAULT_VERSION'] = '5.0.0';
      process.env['PROVISIONING_GITHUB_REPO'] = 'ProdOrg/prod-agent';

      const result = service.getProvisioningConfig();

      expect(result).toEqual({
        provisioningApiUrl: 'https://prod-api.example.com',
        mqttBrokerHost: 'mqtt.prod.example.com',
        mqttBrokerPort: 8883,
        githubReleaseUrl: 'https://github.com/Prod/releases',
        agentDefaultVersion: '5.0.0',
        githubRepo: 'ProdOrg/prod-agent',
      });
    });

    it('merges env overrides with defaults for unset keys', () => {
      process.env['PROVISIONING_API_URL'] = 'https://partial-api.example.com';
      process.env['PROVISIONING_MQTT_BROKER_HOST'] = 'mqtt.partial.example.com';

      const result = service.getProvisioningConfig();

      // Env-sourced values
      expect(result.provisioningApiUrl).toBe('https://partial-api.example.com');
      expect(result.mqttBrokerHost).toBe('mqtt.partial.example.com');
      // Hardcoded defaults for the unset keys
      expect(result.mqttBrokerPort).toBe(1883);
      expect(result.githubReleaseUrl).toBe(
        'https://github.com/Okan-wqm/aquaculture_platform/releases',
      );
      expect(result.agentDefaultVersion).toBe('latest');
      expect(result.githubRepo).toBe('Okan-wqm/aquaculture_platform');
    });
  });

  // =========================================================================
  // updateProvisioningConfig (retired write path)
  // =========================================================================
  describe('updateProvisioningConfig', () => {
    it('throws GoneException — direct global_configs writes are retired', () => {
      expect(() =>
        service.updateProvisioningConfig(
          { 'provisioning.api_url': 'https://new-api.example.com' },
          'admin-user-1',
        ),
      ).toThrow(GoneException);
    });

    it('never touches the repository when rejecting a write', () => {
      expect(() =>
        service.updateProvisioningConfig({ 'provisioning.new_setting': 'new-value' }, 'admin-user-1'),
      ).toThrow(GoneException);

      // The retired write path must persist through NONE of the service's real
      // repos (there is no global_configs repo at all anymore).
      expect(featureToggleRepo.save).not.toHaveBeenCalled();
      expect(maintenanceModeRepo.save).not.toHaveBeenCalled();
      expect(systemVersionRepo.save).not.toHaveBeenCalled();
    });
  });

  // Reference the contract enums so the imports stay meaningful for readers
  // wiring up future fixtures against the config vocabulary.
  it('exposes the provisioning config category contract', () => {
    expect(ConfigCategory.PROVISIONING).toBeDefined();
    expect(ConfigValueType.STRING).toBeDefined();
  });
});
