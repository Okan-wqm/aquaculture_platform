/**
 * M8 — script bridge hardening.
 *
 *  (a) $sendMessage: per-tenant hourly rate limit (20/h), recipient
 *      allowlist = the tenant's VERIFIED user emails (auth.users), and a
 *      structured audit log on EVERY attempt (delivered, rejected, or
 *      throttled). Policy rejections throw into the sandbox.
 *  (b) console forwarding: only the FIRST 10 entries per run reach the HMI
 *      (toast + console feed); the script keeps running and testScript
 *      still captures the full log.
 *
 * Reuses the buildService harness conventions of script-engine.service.spec.
 */
import { Logger } from '@nestjs/common';
import { ScriptEngineService } from '../script-engine.service';
import type { TagManagerService } from '../tag-manager.service';
import type { AlarmEngineService } from '../alarm-engine.service';
import type { NotificationService } from '../notification.service';
import type { AlarmStorageService } from '../alarm-storage.service';
import type { DaqStorageService } from '../daq-storage.service';
import type { ScadaRuntimeGateway } from '../../scada-runtime.gateway';
import type { ScadaScript } from '../../scada-types';
import type { DataSource } from 'typeorm';

const TENANT = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const VERIFIED = 'verified@tenant.io';

type DeepPartial<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function mockOf<T>(impl: DeepPartial<T>): T {
  return impl as T;
}

interface Mocks {
  notificationService: jest.Mocked<Pick<NotificationService, 'sendDirectEmail'>>;
  gateway: jest.Mocked<Pick<ScadaRuntimeGateway, 'broadcastCommand' | 'pushScriptConsole'>>;
  dataSource: { query: jest.Mock };
}

function build(verifiedEmails: string[] = [VERIFIED]): { service: ScriptEngineService; mocks: Mocks } {
  const mocks: Mocks = {
    notificationService: { sendDirectEmail: jest.fn().mockResolvedValue(undefined) },
    gateway: { broadcastCommand: jest.fn(), pushScriptConsole: jest.fn() },
    dataSource: {
      query: jest.fn().mockResolvedValue(verifiedEmails.map((email) => ({ email }))),
    },
  };

  const service = new ScriptEngineService(
    mockOf<TagManagerService>({
      getTagValue: jest.fn(),
      writeTagValue: jest.fn(),
      getAllTagValues: jest.fn().mockReturnValue([]),
    }),
    mockOf<AlarmEngineService>({
      getActiveAlarms: jest.fn().mockReturnValue([]),
      acknowledgeAlarm: jest.fn().mockResolvedValue(undefined),
    }),
    mockOf<NotificationService>(mocks.notificationService),
    mockOf<AlarmStorageService>({ getAlarmHistory: jest.fn().mockResolvedValue([]) }),
    mockOf<DaqStorageService>({ queryValues: jest.fn().mockResolvedValue({}) }),
    mockOf<ScadaRuntimeGateway>(mocks.gateway),
    mockOf<DataSource>(mocks.dataSource),
  );
  return { service, mocks };
}

function script(code: string): ScadaScript {
  return {
    id: 'script-mail',
    name: 'mail script',
    code,
    trigger: 'event',
    enabled: true,
  } as ScadaScript;
}

const SEND = `await $sendMessage("${VERIFIED}", "subj", "body"); return 1`;

describe('ScriptEngineService — $sendMessage hardening (M8a)', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('delivers to a verified tenant recipient and audit-logs the send', async () => {
    const { service, mocks } = build();
    const result = await service.runScript(TENANT, script(SEND));

    expect(result.success).toBe(true);
    expect(mocks.notificationService.sendDirectEmail).toHaveBeenCalledWith(
      VERIFIED,
      'subj',
      'body',
    );
    const audit = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('scada_script_send_message'));
    expect(audit).toBeDefined();
    expect(audit).toContain(`tenant=${TENANT}`);
    expect(audit).toContain('scriptId=script-mail');
    expect(audit).toContain(`to=${VERIFIED}`);
  });

  it('queries the tenant-scoped verified directory', async () => {
    const { service, mocks } = build();
    await service.runScript(TENANT, script(SEND));
    expect(mocks.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('auth.users'),
      [TENANT],
    );
    expect(mocks.dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('"isEmailVerified" = true'),
      [TENANT],
    );
  });

  it('REJECTS a recipient outside the tenant (and audits the attempt)', async () => {
    const { service, mocks } = build();
    const result = await service.runScript(
      TENANT,
      script(`await $sendMessage("attacker@evil.example", "subj", "body"); return 1`),
    );

    expect(mocks.notificationService.sendDirectEmail).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not a verified user of this tenant/);
    expect(
      warnSpy.mock.calls.map((c) => String(c[0])).some((m) => m.includes('scada_script_send_message')),
    ).toBe(true);
  });

  it('REJECTS (fail-closed) when the directory cannot be read', async () => {
    const { service, mocks } = build();
    mocks.dataSource.query.mockRejectedValue(new Error('relation "auth.users" does not exist'));

    const result = await service.runScript(TENANT, script(SEND));

    expect(mocks.notificationService.sendDirectEmail).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allowlist unavailable/);
  });

  it('REJECTS (fail-closed) when no DataSource is wired', async () => {
    const service = new ScriptEngineService(
      mockOf<TagManagerService>({ getTagValue: jest.fn(), writeTagValue: jest.fn() }),
      mockOf<AlarmEngineService>({ getActiveAlarms: jest.fn().mockReturnValue([]) }),
      mockOf<NotificationService>({ sendDirectEmail: jest.fn() }),
      mockOf<AlarmStorageService>({ getAlarmHistory: jest.fn() }),
      mockOf<DaqStorageService>({ queryValues: jest.fn() }),
      mockOf<ScadaRuntimeGateway>({ broadcastCommand: jest.fn(), pushScriptConsole: jest.fn() }),
      null,
    );

    const result = await service.runScript(TENANT, script(SEND));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/allowlist unavailable/);
  });

  it('rate-limits the tenant to 20 sends per rolling hour (21st is rejected)', async () => {
    const { service, mocks } = build();
    for (let i = 0; i < 20; i++) {
      const r = await service.runScript(TENANT, script(SEND));
      expect(r.success).toBe(true);
    }
    expect(mocks.notificationService.sendDirectEmail).toHaveBeenCalledTimes(20);

    const r21 = await service.runScript(TENANT, script(SEND));
    expect(r21.success).toBe(false);
    expect(r21.error).toMatch(/rate limit exceeded \(20\/hour/);
    expect(mocks.notificationService.sendDirectEmail).toHaveBeenCalledTimes(20);
  });

  it('the rate limit is per tenant, not global', async () => {
    const OTHER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const { service, mocks } = build([VERIFIED]);
    for (let i = 0; i < 20; i++) {
      await service.runScript(TENANT, script(SEND));
    }
    const other = await service.runScript(OTHER, script(SEND));
    expect(other.success).toBe(true);
    expect(mocks.notificationService.sendDirectEmail).toHaveBeenCalledTimes(21);
  });
});

describe('ScriptEngineService — console forward cap (M8b)', () => {
  it('forwards only the first 10 console entries per run, then silences (script keeps running)', async () => {
    const { service, mocks } = build();
    const code = `for (let i = 0; i < 25; i++) { console.log("line " + i); } return "done"`;

    const result = await service.runScript(TENANT, script(code));

    // The script ran to completion.
    expect(result.success).toBe(true);
    expect(result.result).toBe('done');

    // Exactly the FIRST 10 entries were forwarded to the HMI…
    expect(mocks.gateway.broadcastCommand).toHaveBeenCalledTimes(10);
    expect(mocks.gateway.pushScriptConsole).toHaveBeenCalledTimes(10);
    const first = mocks.gateway.pushScriptConsole.mock.calls[0]![1] as { message: string };
    const last = mocks.gateway.pushScriptConsole.mock.calls[9]![1] as { message: string };
    expect(first.message).toBe('line 0');
    expect(last.message).toBe('line 9');

    // …but testScript still captures the FULL log for the author.
    const test = await service.testScript(TENANT, script(code));
    const logs = (test.result as { consoleLogs: Array<{ message: string }> }).consoleLogs;
    expect(logs).toHaveLength(25);
  });

  it('a script with ≤ 10 console entries forwards everything', async () => {
    const { service, mocks } = build();
    await service.runScript(TENANT, script('console.log("a"); console.warn("b"); return 1'));
    expect(mocks.gateway.broadcastCommand).toHaveBeenCalledTimes(2);
    expect(mocks.gateway.pushScriptConsole).toHaveBeenCalledTimes(2);
  });
});
