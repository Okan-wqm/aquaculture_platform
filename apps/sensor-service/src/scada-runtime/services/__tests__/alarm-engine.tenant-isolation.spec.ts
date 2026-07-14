/**
 * AlarmEngineService — multi-tenant isolation (RT-011).
 *
 * The engine is a process-wide singleton evaluating EVERY active tenant from
 * one 1 Hz loop. These tests prove that two tenants sharing the identical tag
 * fqn and rule id never see each other's evaluation state: only the tenant
 * whose tag value trips the threshold gets an alarm, status pushes are fenced
 * to the owning tenant's room, and an ACK routed to the wrong tenant is inert.
 *
 * London-school: collaborators (tag cache, gateway, storage, notify) are mocks;
 * the alarm decision math is the real `@platform/alarm-core` kernel. Fake timers
 * drive the private evaluation tick deterministically.
 */
import { AlarmEngineService } from '../alarm-engine.service';
import type { TagManagerService } from '../tag-manager.service';
import type { ScadaRuntimeGateway } from '../../scada-runtime.gateway';
import type { AlarmStorageService } from '../alarm-storage.service';
import type { NotificationService } from '../notification.service';
import type { AlarmRuleRuntime, AlarmStatusSummary, TagValueChange } from '../../scada-types';

const TENANT_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function mockOf<T>(impl: DeepPartial<T>): T {
  return impl as T;
}

interface Mocks {
  tagManager: jest.Mocked<Pick<TagManagerService, 'getTagValue' | 'writeTagValue'>>;
  gateway: jest.Mocked<Pick<ScadaRuntimeGateway, 'pushAlarmStatus'>>;
  storage: jest.Mocked<Pick<AlarmStorageService, 'flushTenantBatch'>>;
  notification: jest.Mocked<Pick<NotificationService, 'processAlarm' | 'clearAlarmRecords'>>;
}

/** A rule that trips when the tag value exceeds 50 (no delay, ack-on-active). */
function rule(overrides: Partial<AlarmRuleRuntime> = {}): AlarmRuleRuntime {
  return {
    id: 'rule-1',
    name: 'high temp',
    tagId: 'pond/temp', // identical fqn across both tenants — the collision under test
    condition: '>',
    threshold: 50,
    severity: 'critical',
    message: 'temperature too high',
    ackMode: 'ackActive',
    enabled: true,
    timeDelay: 0,
    ...overrides,
  };
}

function build(): { engine: AlarmEngineService; mocks: Mocks } {
  const mocks: Mocks = {
    tagManager: { getTagValue: jest.fn(), writeTagValue: jest.fn() },
    gateway: { pushAlarmStatus: jest.fn() },
    storage: {
      flushTenantBatch: jest.fn().mockResolvedValue(undefined),
    },
    notification: {
      processAlarm: jest.fn().mockResolvedValue(undefined),
      clearAlarmRecords: jest.fn(),
    },
  };

  const engine = new AlarmEngineService(
    mockOf<TagManagerService>(mocks.tagManager),
    mockOf<ScadaRuntimeGateway>(mocks.gateway),
    mockOf<AlarmStorageService>(mocks.storage),
    mockOf<NotificationService>(mocks.notification),
  );
  return { engine, mocks };
}

/** getTagValue that returns per-tenant values for the shared `pond/temp` fqn. */
function tenantValue(a: number, b: number) {
  return (tenantId: string, tagId: string): TagValueChange | null => {
    const value = tenantId === TENANT_A ? a : tenantId === TENANT_B ? b : null;
    if (value == null) return null;
    return { tagId, value } as TagValueChange;
  };
}

describe('AlarmEngineService — multi-tenant isolation', () => {
  let engine: AlarmEngineService;
  let mocks: Mocks;

  beforeEach(() => {
    jest.useFakeTimers();
    ({ engine, mocks } = build());
    engine.onModuleInit(); // starts the single 1 Hz loop
  });

  afterEach(() => {
    engine.onModuleDestroy();
    jest.useRealTimers();
  });

  it('evaluates each tenant against its own tag value for the same fqn', () => {
    // Same fqn, same rule id — only tenant A is over threshold.
    mocks.tagManager.getTagValue.mockImplementation(tenantValue(100, 0));
    engine.setAlarmRules(TENANT_A, [rule()]);
    engine.setAlarmRules(TENANT_B, [rule()]);

    jest.advanceTimersByTime(1000); // one tick drives both tenants

    expect(engine.getActiveAlarms(TENANT_A)).toHaveLength(1);
    expect(engine.getActiveAlarms(TENANT_B)).toHaveLength(0);

    // getTagValue was asked for each tenant separately (tenant-qualified read)
    expect(mocks.tagManager.getTagValue).toHaveBeenCalledWith(TENANT_A, 'pond/temp');
    expect(mocks.tagManager.getTagValue).toHaveBeenCalledWith(TENANT_B, 'pond/temp');
  });

  it('pushes each tenant its own status summary, to its own room', () => {
    mocks.tagManager.getTagValue.mockImplementation(tenantValue(100, 0));
    engine.setAlarmRules(TENANT_A, [rule()]);
    engine.setAlarmRules(TENANT_B, [rule()]);

    jest.advanceTimersByTime(1000);

    expect(mocks.gateway.pushAlarmStatus).toHaveBeenCalledWith(
      TENANT_A,
      expect.objectContaining<Partial<AlarmStatusSummary>>({ critical: 1 }),
    );
    expect(mocks.gateway.pushAlarmStatus).toHaveBeenCalledWith(
      TENANT_B,
      expect.objectContaining<Partial<AlarmStatusSummary>>({ critical: 0 }),
    );
  });

  it('ignores an ACK routed to the wrong tenant, honours the owning tenant', async () => {
    mocks.tagManager.getTagValue.mockImplementation(tenantValue(100, 0));
    engine.setAlarmRules(TENANT_A, [rule()]);
    engine.setAlarmRules(TENANT_B, [rule()]);
    jest.advanceTimersByTime(1000);

    const alarmId = engine.getActiveAlarms(TENANT_A)[0]!.id;

    // Wrong tenant: B does not own this alarm — the ack is inert.
    await engine.acknowledgeAlarm(TENANT_B, alarmId, 'operator');
    expect(engine.getActiveAlarms(TENANT_A)[0]!.status).toBe('active');

    // Correct tenant: the ack lands.
    await engine.acknowledgeAlarm(TENANT_A, alarmId, 'operator');
    expect(engine.getActiveAlarms(TENANT_A)[0]!.status).toBe('acknowledged');
  });

  it('deactivating one tenant leaves the other tenant evaluating', () => {
    mocks.tagManager.getTagValue.mockImplementation(tenantValue(100, 100));
    engine.setAlarmRules(TENANT_A, [rule()]);
    engine.setAlarmRules(TENANT_B, [rule()]);
    jest.advanceTimersByTime(1000);
    expect(engine.getActiveAlarms(TENANT_A)).toHaveLength(1);
    expect(engine.getActiveAlarms(TENANT_B)).toHaveLength(1);

    engine.deactivateTenant(TENANT_A);

    expect(engine.isTenantActive(TENANT_A)).toBe(false);
    expect(engine.getActiveAlarms(TENANT_A)).toHaveLength(0);
    // Tenant B is untouched and still active.
    expect(engine.isTenantActive(TENANT_B)).toBe(true);
    expect(engine.getActiveAlarms(TENANT_B)).toHaveLength(1);
  });

  it('an engine with no active tenants evaluates for no one', () => {
    jest.advanceTimersByTime(1000);
    expect(mocks.gateway.pushAlarmStatus).not.toHaveBeenCalled();
    expect(mocks.tagManager.getTagValue).not.toHaveBeenCalled();
  });

  it('coalesces a tenant per-tick writes into ONE batched flush (no per-write storm)', () => {
    mocks.tagManager.getTagValue.mockImplementation(tenantValue(100, 0));
    // Three rules on the same tenant all trip in the same tick.
    engine.setAlarmRules(TENANT_A, [
      rule({ id: 'rule-1' }),
      rule({ id: 'rule-2' }),
      rule({ id: 'rule-3' }),
    ]);

    jest.advanceTimersByTime(1000);

    // ONE flush for the tenant this tick, carrying all three activations —
    // not three separate transactions.
    expect(mocks.storage.flushTenantBatch).toHaveBeenCalledTimes(1);
    const [tenantId, batch] = mocks.storage.flushTenantBatch.mock.calls[0]!;
    expect(tenantId).toBe(TENANT_A);
    expect(batch.upserts).toHaveLength(3);
    expect(batch.deleteIds).toHaveLength(0);
  });
});
