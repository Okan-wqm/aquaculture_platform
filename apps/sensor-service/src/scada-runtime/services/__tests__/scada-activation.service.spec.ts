/**
 * ScadaActivationService — activation bridge lifecycle (RT-011 Faz 3).
 *
 * Proves: lazy activation on first operator (loads PUBLISHED package → engine),
 * the provisioning gate, no-op-if-inactive on package events, reactivate on
 * publish, deactivate on archive, and idle eviction. runInTenantRead is mocked
 * to return package rows; the engine/scheduler are mocks.
 */

// `mock`-prefixed so the jest.mock factory may reference it (hoist rule).
let mockPackageRows: Array<{ package_data: Record<string, unknown> | null }> = [];

jest.mock('@aquaculture/backend-common/database', () => {
  const actual = jest.requireActual('@aquaculture/backend-common/database');
  return {
    ...actual,
    runInTenantRead: jest.fn(
      (
        _ds: unknown,
        _schema: string,
        _tenantId: string,
        fn: (qr: { query: () => Promise<unknown> }) => unknown,
      ) => fn({ query: async () => mockPackageRows }),
    ),
  };
});

import { ScadaActivationService } from '../scada-activation.service';
import type { AlarmEngineService } from '../alarm-engine.service';
import type { SchedulerService } from '../scheduler.service';
import type { DataSource } from 'typeorm';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** Deep-partial → full-type widening in one type-checked place (cast-free idiom). */
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;
function mockOf<T>(impl: DeepPartial<T>): T {
  return impl as T;
}

interface Mocks {
  dataSource: jest.Mocked<Pick<DataSource, 'query'>>;
  alarmEngine: jest.Mocked<
    Pick<
      AlarmEngineService,
      'isTenantActive' | 'setAlarmRules' | 'setNotificationConfigs' | 'deactivateTenant'
    >
  >;
  scheduler: jest.Mocked<Pick<SchedulerService, 'loadScripts'>>;
}

function build(
  provisioned = true,
  active = false,
): { service: ScadaActivationService; mocks: Mocks } {
  const mocks: Mocks = {
    dataSource: {
      // provisioning check: information_schema.schemata → row present iff provisioned
      query: jest.fn().mockResolvedValue(provisioned ? [{ '?column?': 1 }] : []),
    },
    alarmEngine: {
      isTenantActive: jest.fn().mockReturnValue(active),
      setAlarmRules: jest.fn(),
      setNotificationConfigs: jest.fn(),
      deactivateTenant: jest.fn(),
    },
    scheduler: { loadScripts: jest.fn() },
  };
  const service = new ScadaActivationService(
    mockOf<DataSource>(mocks.dataSource),
    mockOf<AlarmEngineService>(mocks.alarmEngine),
    mockOf<SchedulerService>(mocks.scheduler),
  );
  return { service, mocks };
}

const goodPackage = {
  package_data: {
    alarmRules: [{ id: 'r1', tag: 'pond/temp', condition: '>', value: 30, severity: 'high' }],
    scripts: [{ id: 's1', name: 'x', code: 'return 1', mode: 'server', enabled: true }],
  },
};

beforeEach(() => {
  mockPackageRows = [];
});

describe('ScadaActivationService — lazy activation', () => {
  it('activates on first operator: loads the PUBLISHED package into the engine + scheduler', async () => {
    const { service, mocks } = build(true, false);
    mockPackageRows = [goodPackage];

    await service.handleOperatorConnected({ tenantId: TENANT });

    expect(mocks.alarmEngine.setAlarmRules).toHaveBeenCalledWith(
      TENANT,
      expect.arrayContaining([
        expect.objectContaining({ id: 'r1', tagId: 'pond/temp', threshold: 30 }),
      ]),
    );
    expect(mocks.alarmEngine.setNotificationConfigs).toHaveBeenCalledWith(TENANT, []);
    expect(mocks.scheduler.loadScripts).toHaveBeenCalledWith(
      TENANT,
      goodPackage.package_data.scripts,
    );
  });

  it('does NOT activate an un-provisioned tenant', async () => {
    const { service, mocks } = build(false, false);
    mockPackageRows = [goodPackage];

    await service.handleOperatorConnected({ tenantId: TENANT });

    expect(mocks.alarmEngine.setAlarmRules).not.toHaveBeenCalled();
  });

  it('does not re-load a tenant that is already active', async () => {
    const { service, mocks } = build(true, true); // isTenantActive → true
    mockPackageRows = [goodPackage];

    await service.handleOperatorConnected({ tenantId: TENANT });

    expect(mocks.alarmEngine.setAlarmRules).not.toHaveBeenCalled();
  });
});

describe('ScadaActivationService — package lifecycle', () => {
  it('reloads an ACTIVE tenant when its package is published', async () => {
    const { service, mocks } = build(true, true);
    mockPackageRows = [goodPackage];

    await service.handlePackagePublished({ tenantId: TENANT, packageId: 'p1' });

    expect(mocks.alarmEngine.setAlarmRules).toHaveBeenCalledWith(TENANT, expect.any(Array));
  });

  it('is a no-op when a package is published for an INACTIVE tenant (D4)', async () => {
    const { service, mocks } = build(true, false); // inactive
    mockPackageRows = [goodPackage];

    await service.handlePackagePublished({ tenantId: TENANT, packageId: 'p1' });

    expect(mocks.alarmEngine.setAlarmRules).not.toHaveBeenCalled();
  });

  it('deactivates an ACTIVE tenant when its package is archived', () => {
    const { service, mocks } = build(true, true);

    service.handlePackageArchived({ tenantId: TENANT, packageId: 'p1' });

    expect(mocks.alarmEngine.deactivateTenant).toHaveBeenCalledWith(TENANT);
    expect(mocks.scheduler.loadScripts).toHaveBeenCalledWith(TENANT, []);
  });
});

describe('ScadaActivationService — idle eviction', () => {
  it('evicts a tenant whose last operator left beyond the idle window', () => {
    jest.useFakeTimers();
    try {
      const { service, mocks } = build(true, true); // active tenant
      service.onModuleInit(); // starts the sweep timer

      // Last operator leaves → idle clock starts (tenant not in connected set).
      service.handleOperatorDisconnected({ tenantId: TENANT });

      // Advance past the idle window; the periodic sweep fires and evicts.
      jest.advanceTimersByTime(16 * 60 * 1000);

      expect(mocks.alarmEngine.deactivateTenant).toHaveBeenCalledWith(TENANT);

      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does NOT evict a tenant that still has a connected operator', () => {
    jest.useFakeTimers();
    try {
      const { service, mocks } = build(true, true);
      service.onModuleInit();

      // Operator connects and stays (in the connected set).
      void service.handleOperatorConnected({ tenantId: TENANT });

      jest.advanceTimersByTime(30 * 60 * 1000);

      expect(mocks.alarmEngine.deactivateTenant).not.toHaveBeenCalled();
      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });
});
