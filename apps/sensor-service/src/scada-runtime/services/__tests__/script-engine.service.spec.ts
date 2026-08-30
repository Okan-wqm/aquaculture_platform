/**
 * ScriptEngineService contract.
 *
 * London-school: the six SCADA collaborators are mocks; these tests assert the
 * `ScriptResult` contract the scheduler depends on and that each `$`-bridge is
 * wired to the correct collaborator through the QuickJS boundary, fenced to the
 * PER-RUN tenant (RT-011). The sandbox isolation itself is covered by
 * `quickjs-sandbox.spec.ts`.
 */
import { ScriptEngineService } from '../script-engine.service';
import type { TagManagerService } from '../tag-manager.service';
import type { AlarmEngineService } from '../alarm-engine.service';
import type { NotificationService } from '../notification.service';
import type { AlarmStorageService } from '../alarm-storage.service';
import type { DaqStorageService } from '../daq-storage.service';
import type { ScadaRuntimeGateway } from '../../scada-runtime.gateway';
import type { ScadaScript } from '../../scada-types';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

/** Recursively-optional view of a type — a mock need only supply the fields
 *  the test exercises, at any depth (e.g. the gateway's `server.emit`). */
type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

/**
 * Widen a deep-partial jest mock to its full collaborator type for constructor
 * injection. London-school specs exercise only a few methods, so the mock is a
 * strict subtype; this generic performs the single widening assertion in one
 * type-checked place (`DeepPartial<T> → T`) instead of an unsafe
 * double-assertion at every call site.
 */
function mockOf<T>(impl: DeepPartial<T>): T {
  return impl as T;
}

interface Mocks {
  tagManager: jest.Mocked<
    Pick<TagManagerService, 'getTagValue' | 'writeTagValue' | 'getAllTagValues'>
  >;
  alarmEngine: jest.Mocked<Pick<AlarmEngineService, 'getActiveAlarms' | 'acknowledgeAlarm'>>;
  notificationService: jest.Mocked<Pick<NotificationService, 'sendDirectEmail'>>;
  alarmStorage: jest.Mocked<Pick<AlarmStorageService, 'getAlarmHistory'>>;
  daqStorage: jest.Mocked<Pick<DaqStorageService, 'queryValues'>>;
  gateway: jest.Mocked<Pick<ScadaRuntimeGateway, 'broadcastCommand' | 'pushScriptConsole'>>;
}

function buildService(): { service: ScriptEngineService; mocks: Mocks } {
  const mocks: Mocks = {
    tagManager: {
      getTagValue: jest.fn(),
      writeTagValue: jest.fn(),
      getAllTagValues: jest.fn().mockReturnValue([]),
    },
    alarmEngine: {
      getActiveAlarms: jest.fn().mockReturnValue([]),
      acknowledgeAlarm: jest.fn().mockResolvedValue(undefined),
    },
    notificationService: { sendDirectEmail: jest.fn().mockResolvedValue(undefined) },
    alarmStorage: { getAlarmHistory: jest.fn().mockResolvedValue([]) },
    daqStorage: { queryValues: jest.fn().mockResolvedValue({}) },
    gateway: { broadcastCommand: jest.fn(), pushScriptConsole: jest.fn() },
  };

  const service = new ScriptEngineService(
    mockOf<TagManagerService>(mocks.tagManager),
    mockOf<AlarmEngineService>(mocks.alarmEngine),
    mockOf<NotificationService>(mocks.notificationService),
    mockOf<AlarmStorageService>(mocks.alarmStorage),
    mockOf<DaqStorageService>(mocks.daqStorage),
    mockOf<ScadaRuntimeGateway>(mocks.gateway),
  );
  return { service, mocks };
}

function script(code: string, overrides: Partial<ScadaScript> = {}): ScadaScript {
  return {
    id: 'script-1',
    name: 'test script',
    code,
    trigger: 'event',
    enabled: true,
    ...overrides,
  } as ScadaScript;
}

describe('ScriptEngineService — runScript contract', () => {
  it('returns a success ScriptResult carrying the return value', async () => {
    const { service } = buildService();
    const result = await service.runScript(TENANT, script('return 20 + 22'));
    expect(result.scriptId).toBe('script-1');
    expect(result.success).toBe(true);
    expect(result.result).toBe(42);
    expect(typeof result.durationMs).toBe('number');
    expect(result.error).toBeUndefined();
  });

  it('returns a failure ScriptResult when the script throws', async () => {
    const { service } = buildService();
    const result = await service.runScript(TENANT, script('throw new Error("nope")'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/nope/);
  });

  it('resolves tagId params to live tag values before execution', async () => {
    const { service, mocks } = buildService();
    mocks.tagManager.getTagValue.mockReturnValue({
      tagId: 't1',
      value: 7,
      quality: 'good',
      timestamp: 1,
    } as never);
    const result = await service.runScript(
      TENANT,
      script('return params.temp.value * 2', {
        params: [{ name: 'temp', type: 'tagId', value: 't1' }],
      } as Partial<ScadaScript>),
    );
    expect(mocks.tagManager.getTagValue).toHaveBeenCalledWith(TENANT, 't1');
    expect(result.result).toBe(14);
  });
});

describe('ScriptEngineService — testScript contract', () => {
  it('wraps the return value and captured console logs', async () => {
    const { service } = buildService();
    const result = await service.testScript(TENANT, script('console.log("hi"); return 1'));
    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ returnValue: 1 });
    const logs = (result.result as { consoleLogs: Array<{ message: string }> }).consoleLogs;
    expect(logs.some((l) => l.message === 'hi')).toBe(true);
  });

  it('returns captured console logs even when the script fails', async () => {
    const { service } = buildService();
    const result = await service.testScript(
      TENANT,
      script('console.warn("careful"); throw new Error("x")'),
    );
    expect(result.success).toBe(false);
    const logs = (result.result as { consoleLogs: Array<{ message: string }> }).consoleLogs;
    expect(logs.some((l) => l.message === 'careful')).toBe(true);
  });

  it('forwards console output to the run tenant room only', async () => {
    const { service, mocks } = buildService();
    await service.testScript(TENANT, script('console.log("hi"); return 1'));
    expect(mocks.gateway.pushScriptConsole).toHaveBeenCalledWith(
      TENANT,
      expect.objectContaining({ scriptId: 'script-1', level: 'log', message: 'hi' }),
    );
  });
});

describe('ScriptEngineService — $-bridge wiring (per-run tenant)', () => {
  it('$getTag / $setTag reach TagManagerService under the run tenant', async () => {
    const { service, mocks } = buildService();
    mocks.tagManager.getTagValue.mockReturnValue({ tagId: 't1', value: 5 } as never);
    const result = await service.runScript(
      TENANT,
      script('const t = $getTag("t1"); $setTag("t2", t.value + 1); return t.value'),
    );
    expect(result.result).toBe(5);
    expect(mocks.tagManager.getTagValue).toHaveBeenCalledWith(TENANT, 't1');
    expect(mocks.tagManager.writeTagValue).toHaveBeenCalledWith('t2', 6, 'script-engine', TENANT);
  });

  it('$setView broadcasts under the run tenant', async () => {
    const { service, mocks } = buildService();
    await service.runScript(TENANT, script('$setView("overview")'));
    expect(mocks.gateway.broadcastCommand).toHaveBeenCalledWith(TENANT, {
      type: 'SETVIEW',
      viewId: 'overview',
    });
  });

  it('$ackAlarm routes the ack to the run tenant', async () => {
    const { service, mocks } = buildService();
    await service.runScript(TENANT, script('await $ackAlarm("alarm-9", "op-1"); return 1'));
    expect(mocks.alarmEngine.acknowledgeAlarm).toHaveBeenCalledWith(TENANT, 'alarm-9', 'op-1');
  });

  it('$getHistoricalTags is tenant-fenced through the run tenant', async () => {
    const { service, mocks } = buildService();
    await service.runScript(TENANT, script('await $getHistoricalTags(["a"], 0, 10); return 1'));
    expect(mocks.daqStorage.queryValues).toHaveBeenCalledWith(
      TENANT,
      ['a'],
      new Date(0),
      new Date(10),
    );
  });

  it('$sendMessage awaits NotificationService', async () => {
    const { service, mocks } = buildService();
    await service.runScript(
      TENANT,
      script('await $sendMessage("ops@x.io", "subj", "body"); return 1'),
    );
    expect(mocks.notificationService.sendDirectEmail).toHaveBeenCalledWith(
      'ops@x.io',
      'subj',
      'body',
    );
  });
});

describe('ScriptEngineService — tenant fail-closed', () => {
  it('a run with an empty tenant fails closed and never broadcasts', async () => {
    const { service, mocks } = buildService();
    // The tenant is asserted before any sandbox/bridge is built, so the run
    // fails without touching a tenant-scoped collaborator.
    const result = await service.runScript('', script('$setView("overview"); return "done"'));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/non-empty tenantId/);
    expect(mocks.gateway.broadcastCommand).not.toHaveBeenCalled();
  });
});
