/**
 * M2 — ALARM_STATUS summary additive fields.
 *
 * The legacy severity counts kept counting ACKED and CLEARED alarms, so an
 * acknowledged critical looked identical to a screaming one. The summary now
 * additionally carries `unacked` (per severity: active|cleared with no ack)
 * and `totalActive` (strictly-active only). The legacy fields are UNCHANGED
 * for live old clients.
 *
 * London-school: collaborators mocked; fake timers drive the private 1 Hz
 * tick so the summary is produced by the real engine state machine.
 */
import { AlarmEngineService } from '../alarm-engine.service';
import type { TagManagerService } from '../tag-manager.service';
import type { ScadaRuntimeGateway } from '../../scada-runtime.gateway';
import type { AlarmStorageService } from '../alarm-storage.service';
import type { NotificationService } from '../notification.service';
import type { AlarmRuleRuntime, AlarmStatusSummary, TagValueChange } from '../../scada-types';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function mockOf<T>(impl: DeepPartial<T>): T {
  return impl as T;
}

interface Mocks {
  tagManager: jest.Mocked<Pick<TagManagerService, 'getTagValue'>>;
  gateway: jest.Mocked<Pick<ScadaRuntimeGateway, 'pushAlarmStatus'>>;
  storage: jest.Mocked<Pick<AlarmStorageService, 'flushTenantBatch'>>;
  notification: jest.Mocked<Pick<NotificationService, 'processAlarm' | 'clearAlarmRecords'>>;
}

function rule(id: string, severity: AlarmRuleRuntime['severity']): AlarmRuleRuntime {
  return {
    id,
    name: `rule-${id}`,
    tagId: `pond/${id}`,
    condition: '>',
    threshold: 50,
    severity,
    message: 'too high',
    ackMode: 'ackActive',
    enabled: true,
    timeDelay: 0,
  };
}

function build(): { engine: AlarmEngineService; mocks: Mocks } {
  const mocks: Mocks = {
    tagManager: { getTagValue: jest.fn() },
    gateway: { pushAlarmStatus: jest.fn() },
    storage: { flushTenantBatch: jest.fn().mockResolvedValue(undefined) },
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

describe('AlarmEngineService — summary unacked/totalActive (M2)', () => {
  let engine: AlarmEngineService;
  let mocks: Mocks;

  beforeEach(() => {
    jest.useFakeTimers();
    ({ engine, mocks } = build());
    engine.onModuleInit();
  });

  afterEach(() => {
    engine.onModuleDestroy();
    jest.useRealTimers();
  });

  function lastSummary(): AlarmStatusSummary {
    const calls = mocks.gateway.pushAlarmStatus.mock.calls;
    return calls[calls.length - 1]![1];
  }

  it('an ACKED critical no longer counts as unacked critical (legacy fields keep counting)', async () => {
    mocks.tagManager.getTagValue.mockImplementation((_t, tagId) =>
      ({ tagId, value: 100 }) as TagValueChange,
    );
    engine.setAlarmRules(TENANT, [rule('crit', 'critical')]);

    jest.advanceTimersByTime(1000); // activate
    await engine.acknowledgeAlarm(TENANT, engine.getActiveAlarms(TENANT)[0]!.id, 'op');

    const summary = lastSummary();
    expect(summary.unacked!.critical).toBe(0);
    expect(summary.critical).toBe(1); // legacy count still includes the acked alarm
    // The alarm's status is now 'acknowledged' — totalActive counts strictly
    // ACTIVE alarms, so it drops out (the legacy fields keep it visible).
    expect(summary.totalActive).toBe(0);
  });

  it('a CLEARED-unacknowledged alarm counts in unacked but NOT in totalActive', async () => {
    mocks.tagManager.getTagValue.mockImplementation((_t, tagId) =>
      ({ tagId, value: 100 }) as TagValueChange,
    );
    engine.setAlarmRules(TENANT, [rule('warn', 'warning')]);

    jest.advanceTimersByTime(1000); // activate

    // Condition clears (well outside the deadband) → alarm becomes CLEARED,
    // still awaiting an ack (ackMode ackActive, not float).
    mocks.tagManager.getTagValue.mockImplementation((_t, tagId) =>
      ({ tagId, value: 0 }) as TagValueChange,
    );
    jest.advanceTimersByTime(1000);

    const alarms = engine.getActiveAlarms(TENANT);
    expect(alarms[0]!.status).toBe('cleared');

    const summary = lastSummary();
    expect(summary.unacked!.warning).toBe(1); // cleared but unacked
    expect(summary.totalActive).toBe(0); // no longer active
    expect(summary.warning).toBe(1); // legacy count unchanged
  });

  it('fresh active alarms are both unacked and totalActive across severities', () => {
    mocks.tagManager.getTagValue.mockImplementation((_t, tagId) =>
      ({ tagId, value: 100 }) as TagValueChange,
    );
    engine.setAlarmRules(TENANT, [
      rule('c', 'critical'),
      rule('h', 'high'),
      rule('w', 'warning'),
      rule('i', 'info'),
    ]);

    jest.advanceTimersByTime(1000);

    const summary = lastSummary();
    expect(summary.unacked).toEqual({ critical: 1, high: 1, warning: 1, info: 1 });
    expect(summary.totalActive).toBe(4);
    // Legacy fields identical to before — old clients see no change.
    expect(summary.critical).toBe(1);
    expect(summary.high).toBe(1);
    expect(summary.warning).toBe(1);
    expect(summary.info).toBe(1);
  });

  it('acknowledging every alarm empties unacked while totalActive reflects reality', async () => {
    mocks.tagManager.getTagValue.mockImplementation((_t, tagId) =>
      ({ tagId, value: 100 }) as TagValueChange,
    );
    engine.setAlarmRules(TENANT, [rule('c', 'critical'), rule('h', 'high')]);

    jest.advanceTimersByTime(1000);
    await engine.acknowledgeAll(TENANT, 'op');

    const summary = lastSummary();
    expect(summary.unacked).toEqual({ critical: 0, high: 0, warning: 0, info: 0 });
    // Both alarms are acknowledged now — strictly-active count is 0 while the
    // legacy severity counts (2) still reflect the acked-but-unresolved set.
    expect(summary.totalActive).toBe(0);
    expect(summary.critical).toBe(1);
    expect(summary.high).toBe(1);
  });
});
