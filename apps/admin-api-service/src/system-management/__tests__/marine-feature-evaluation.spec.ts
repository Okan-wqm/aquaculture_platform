import { Repository } from 'typeorm';

import {
  FeatureToggle,
  FeatureToggleScope,
  FeatureToggleStatus,
} from '../entities/feature-toggle.entity';
import { MaintenanceMode } from '../entities/maintenance-mode.entity';
import { SystemVersion } from '../entities/system-version.entity';
import { GlobalSettingsService } from '../services/global-settings.service';

const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';

describe('GlobalSettingsService tenant feature evaluation', () => {
  it('requires both enabled status and explicit tenant allowlist membership', async () => {
    const service = createService(
      toggle({
        status: FeatureToggleStatus.ENABLED,
        enabledTenants: [TENANT_ID],
      }),
    );

    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    ).resolves.toMatchObject({ enabled: true });
    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: OTHER_TENANT_ID }),
    ).resolves.toMatchObject({ enabled: false, reason: 'Tenant is not allowlisted' });
    await expect(service.evaluateFeatureToggle('marine_explorer', {})).resolves.toMatchObject({
      enabled: false,
      reason: 'Tenant context is required',
    });
  });

  it('keeps disabled as a master kill switch even for an allowlisted tenant', async () => {
    const service = createService(
      toggle({
        status: FeatureToggleStatus.DISABLED,
        enabledTenants: [TENANT_ID],
      }),
    );

    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    ).resolves.toMatchObject({ enabled: false, reason: 'Feature is disabled' });
  });

  it('makes the tenant denylist win over enabled status and allowlist', async () => {
    const service = createService(
      toggle({
        status: FeatureToggleStatus.ENABLED,
        enabledTenants: [TENANT_ID],
        disabledTenants: [TENANT_ID],
      }),
    );

    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    ).resolves.toMatchObject({ enabled: false, reason: 'Disabled for this tenant' });
  });

  it.each([
    ['unknown status', { status: 'bogus' as FeatureToggleStatus }],
    ['missing schedule', { status: FeatureToggleStatus.SCHEDULED, rolloutSchedule: undefined }],
    [
      'malformed schedule',
      {
        status: FeatureToggleStatus.SCHEDULED,
        rolloutSchedule: {
          startDate: 'not-an-instant',
          percentage: 100,
        },
      },
    ],
  ])('fails closed for %s', async (_label, overrides) => {
    const service = createService(
      toggle({
        enabledTenants: [TENANT_ID],
        ...overrides,
      }),
    );

    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    ).resolves.toMatchObject({ enabled: false });
  });

  it('fails closed when persisted tenant policy is not an array of tenant IDs', async () => {
    const feature = toggle({
      status: FeatureToggleStatus.ENABLED,
      enabledTenants: [TENANT_ID],
    });
    Reflect.set(feature, 'enabledTenants', TENANT_ID);
    const service = createService(feature);

    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    ).resolves.toMatchObject({ enabled: false, reason: 'Feature configuration is invalid' });
  });

  it('parses JSONB ISO schedule instants and denies before the start', async () => {
    const service = createService(
      toggle({
        status: FeatureToggleStatus.SCHEDULED,
        enabledTenants: [TENANT_ID],
        rolloutSchedule: {
          startDate: '2099-01-01T00:00:00.000Z',
          percentage: 100,
        },
      }),
    );

    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    ).resolves.toMatchObject({ enabled: false, reason: 'Scheduled rollout not started' });
  });

  it('keeps a completed partial schedule bounded instead of enabling every tenant', async () => {
    const service = createService(
      toggle({
        status: FeatureToggleStatus.SCHEDULED,
        enabledTenants: [TENANT_ID],
        rolloutSchedule: {
          startDate: '2026-01-01T00:00:00.000Z',
          endDate: '2026-01-02T00:00:00.000Z',
          percentage: 0,
        },
      }),
    );

    await expect(
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    ).resolves.toMatchObject({ enabled: false, reason: 'Not in scheduled rollout percentage' });
  });

  it('does not promote a completed partial target to globally enabled', async () => {
    const feature = toggle({
      status: FeatureToggleStatus.SCHEDULED,
      enabledTenants: [TENANT_ID],
      rolloutPercentage: 25,
      rolloutSchedule: {
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-02T00:00:00.000Z',
        percentage: 0,
        targetPercentage: 25,
        incrementPerDay: 25,
      },
    });
    const save = jest.fn().mockResolvedValue(feature);
    const featureRepo = {
      find: jest.fn().mockResolvedValue([feature]),
      save,
    } as Partial<Repository<FeatureToggle>> as Repository<FeatureToggle>;
    const service = new GlobalSettingsService(
      featureRepo,
      {} as Repository<MaintenanceMode>,
      {} as Repository<SystemVersion>,
    );

    await service.handleScheduledFeatureRollouts();

    expect(feature.status).toBe(FeatureToggleStatus.SCHEDULED);
    expect(save).not.toHaveBeenCalled();
  });

  it('coalesces concurrent stale-cache refreshes into one repository read', async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const feature = toggle({
      status: FeatureToggleStatus.ENABLED,
      enabledTenants: [TENANT_ID],
    });
    const find = jest.fn(async () => {
      await blocked;
      return [feature];
    });
    const service = createService(feature, find);
    const evaluations = Array.from({ length: 16 }, () =>
      service.evaluateFeatureToggle('marine_explorer', { tenantId: TENANT_ID }),
    );
    await Promise.resolve();

    expect(find).toHaveBeenCalledTimes(1);
    release?.();
    await expect(Promise.all(evaluations)).resolves.toEqual(
      Array.from({ length: 16 }, () => expect.objectContaining({ enabled: true })),
    );
  });
});

function createService(
  feature: FeatureToggle,
  find: jest.Mock = jest.fn().mockResolvedValue([feature]),
): GlobalSettingsService {
  const featureRepo = {
    find,
  } as Partial<Repository<FeatureToggle>> as Repository<FeatureToggle>;
  const maintenanceRepo = {} as Repository<MaintenanceMode>;
  const versionRepo = {} as Repository<SystemVersion>;
  return new GlobalSettingsService(featureRepo, maintenanceRepo, versionRepo);
}

function toggle(overrides: Partial<FeatureToggle>): FeatureToggle {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    key: 'marine_explorer',
    name: 'Marine Data Explorer',
    scope: FeatureToggleScope.TENANT,
    status: FeatureToggleStatus.DISABLED,
    rolloutPercentage: 0,
    requiresRestart: false,
    isExperimental: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
