import { readFileSync } from 'fs';
import { join } from 'path';

import { EdgeDeviceService } from '../edge-device.service';
import { DeviceIoConfig, IoDataType, IoType } from '../entities/device-io-config.entity';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DEVICE_CODE = 'edge-device-01';

function makeMqttClient(): { isConnectedToBroker: jest.Mock; publish: jest.Mock } {
  return {
    isConnectedToBroker: jest.fn().mockReturnValue(true),
    publish: jest.fn().mockResolvedValue(undefined),
  };
}

function makeService(overrides: {
  device?: Record<string, unknown> | null;
  ioConfigs?: DeviceIoConfig[];
  mqttClient?: ReturnType<typeof makeMqttClient> | null;
} = {}): EdgeDeviceService {
  const device = overrides.device ?? {
    id: DEVICE_ID,
    tenantId: TENANT_ID,
    deviceCode: DEVICE_CODE,
    isOnline: true,
    ipAddress: '10.0.0.10',
  };
  const deviceRepository = {
    findOne: jest.fn().mockResolvedValue(device),
  };
  const ioConfigRepository = {
    find: jest.fn().mockResolvedValue(overrides.ioConfigs ?? []),
  };
  const loraDeviceRepository = {
    find: jest.fn().mockResolvedValue([]),
  };

  return new EdgeDeviceService(
    deviceRepository as never,
    ioConfigRepository as never,
    loraDeviceRepository as never,
    {} as never,
    (overrides.mqttClient === undefined ? null : overrides.mqttClient) as never,
    {} as never,
    { get: jest.fn() } as never,
  );
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function cfg(overrides: Partial<DeviceIoConfig>): DeviceIoConfig {
  return {
    id: 'cfg-id',
    deviceId: 'device-id',
    tagName: 'tag',
    ioType: IoType.AI,
    dataType: IoDataType.FLOAT32,
    moduleAddress: 1,
    channel: 1,
    invertValue: false,
    isActive: true,
    createdAt: new Date('2026-05-13T00:00:00Z'),
    updatedAt: new Date('2026-05-13T00:00:00Z'),
    ...overrides,
  } as DeviceIoConfig;
}

describe('AgentIoConfigV2 transform', () => {
  let service: EdgeDeviceService;

  beforeEach(() => {
    service = makeService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('emits flat schemaVersion 2 tags for gpio, modbus and i2c configs', () => {
    const result = service.transformIoConfigsToAgentFormat([
      cfg({
        tagName: 'relay',
        ioType: IoType.DO,
        dataType: IoDataType.BOOL,
        gpioPin: 17,
      }),
      cfg({
        tagName: 'temperature',
        ioType: IoType.AI,
        modbusSlaveId: 2,
        modbusRegister: 300,
        modbusFunction: 4,
        rawMin: 0,
        rawMax: 1000,
        engMin: 0,
        engMax: 100,
        alarmL: 10,
        alarmH: 30,
      }),
      cfg({
        tagName: 'ph',
        ioType: IoType.AI,
        busType: 'i2c',
        i2cBus: 1,
        i2cAddress: 0x63,
      }),
    ]);
    const normalized: unknown = JSON.parse(JSON.stringify(result));
    const golden: unknown = JSON.parse(
      readFileSync(
        join(process.cwd(), 'tools/gates/fixtures/agent-io-config-v2.golden.json'),
        'utf8',
      ),
    );

    expect(normalized).toEqual(golden);
  });

  it('refuses to push active configs that cannot be represented in AgentIoConfigV2', async () => {
    const mqttClient = makeMqttClient();
    service.onModuleDestroy();
    service = makeService({
      mqttClient,
      ioConfigs: [
        cfg({
          tagName: 'orphaned_tag',
          ioType: IoType.AI,
          dataType: IoDataType.FLOAT32,
        }),
      ],
    });

    const result = await service.pushIoConfigToDevice(DEVICE_ID, TENANT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('I/O config semantic validation failed');
    expect(result.error).toContain('orphaned_tag: no supported protocol address configured');
    expect(mqttClient.publish).not.toHaveBeenCalled();
  });

  it('refuses to push ambiguous configs instead of silently choosing a protocol', async () => {
    const mqttClient = makeMqttClient();
    service.onModuleDestroy();
    service = makeService({
      mqttClient,
      ioConfigs: [
        cfg({
          tagName: 'ambiguous_tag',
          ioType: IoType.DO,
          dataType: IoDataType.BOOL,
          gpioPin: 17,
          modbusRegister: 1,
          modbusFunction: 1,
        }),
      ],
    });

    const result = await service.pushIoConfigToDevice(DEVICE_ID, TENANT_ID);

    expect(result.success).toBe(false);
    expect(result.error).toContain('ambiguous_tag: multiple protocol addresses configured');
    expect(mqttClient.publish).not.toHaveBeenCalled();
  });

  it('ignores ping responses from a different device identifier', async () => {
    const mqttClient = makeMqttClient();
    service.onModuleDestroy();
    service = makeService({ mqttClient });

    const pingPromise = service.pingDevice(DEVICE_ID, TENANT_ID);
    await flushAsync();

    const publishCalls = mqttClient.publish.mock.calls as readonly (readonly unknown[])[];
    const publishPayload = publishCalls[0]?.[1] as Record<string, unknown>;
    const commandId = publishPayload['commandId'] as string;
    let settled = false;
    void pingPromise.then(() => {
      settled = true;
    });

    service.handlePingResponse('wrong-device', { commandId, success: true });
    await flushAsync();

    expect(settled).toBe(false);

    service.handlePingResponse(DEVICE_ID, { commandId, success: true });

    await expect(pingPromise).resolves.toMatchObject({
      success: true,
      deviceCode: DEVICE_CODE,
    });
  });
});

/**
 * SENSOR-HIGH-064 — the I/O config push must reflect the device's real ack, not
 * report unconditional green on publish. These tests pin that the push blocks on
 * a commandId-correlated edge ack, persists the confirmed applied state only on
 * success, and fails honestly on rejection or timeout.
 */
describe('pushIoConfigToDevice ack correlation (SENSOR-HIGH-064)', () => {
  function setupAckService(
    ioConfigs: DeviceIoConfig[],
    opts: { isOnline?: boolean } = {},
  ): {
    service: EdgeDeviceService;
    deviceRepository: { findOne: jest.Mock; update: jest.Mock };
    mqttClient: ReturnType<typeof makeMqttClient>;
  } {
    const device = {
      id: DEVICE_ID,
      tenantId: TENANT_ID,
      deviceCode: DEVICE_CODE,
      isOnline: opts.isOnline ?? true,
      ipAddress: '10.0.0.10',
    };
    const deviceRepository = {
      findOne: jest.fn().mockResolvedValue(device),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
    };
    const ioConfigRepository = { find: jest.fn().mockResolvedValue(ioConfigs) };
    const loraDeviceRepository = { find: jest.fn().mockResolvedValue([]) };
    const mqttClient = makeMqttClient();
    const service = new EdgeDeviceService(
      deviceRepository as never,
      ioConfigRepository as never,
      loraDeviceRepository as never,
      {} as never,
      mqttClient as never,
      {} as never,
      { get: jest.fn() } as never,
    );
    return { service, deviceRepository, mqttClient };
  }

  function validConfig(): DeviceIoConfig {
    return cfg({ tagName: 'relay', ioType: IoType.DO, dataType: IoDataType.BOOL, gpioPin: 17 });
  }

  function commandIdFor(
    mqttClient: ReturnType<typeof makeMqttClient>,
    command: string,
  ): string {
    const calls = mqttClient.publish.mock.calls as readonly (readonly unknown[])[];
    for (const call of calls) {
      const payload = call[1] as Record<string, unknown>;
      if (payload['command'] === command) {
        return payload['commandId'] as string;
      }
    }
    throw new Error(`no ${command} command was published`);
  }

  it('confirms + persists applied state only after a real success ack', async () => {
    const { service, deviceRepository, mqttClient } = setupAckService([validConfig()]);

    const pushPromise = service.pushIoConfigToDevice(DEVICE_ID, TENANT_ID);
    await flushAsync();

    // Awaiting the ack: not resolved, nothing persisted yet.
    expect(deviceRepository.update).not.toHaveBeenCalled();

    const commandId = commandIdFor(mqttClient, 'update_io_config');
    const routing = service.handleIoConfigAckResponse(DEVICE_CODE, { commandId, success: true });
    expect(routing).toMatchObject({ matched: true, success: true, deviceId: DEVICE_ID });

    await expect(pushPromise).resolves.toEqual({ success: true });
    expect(deviceRepository.update).toHaveBeenCalledWith(
      { id: DEVICE_ID, tenantId: TENANT_ID },
      expect.objectContaining({
        appliedConfigHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        lastConfigAckAt: expect.any(Date),
      }),
    );

    service.onModuleDestroy();
  });

  it('reports failure and does NOT persist when the edge rejects the config', async () => {
    const { service, deviceRepository, mqttClient } = setupAckService([validConfig()]);

    const pushPromise = service.pushIoConfigToDevice(DEVICE_ID, TENANT_ID);
    await flushAsync();

    const commandId = commandIdFor(mqttClient, 'update_io_config');
    service.handleIoConfigAckResponse(DEVICE_CODE, {
      commandId,
      success: false,
      error: 'GPIO 17 already claimed',
    });

    await expect(pushPromise).resolves.toEqual({ success: false, error: 'GPIO 17 already claimed' });
    expect(deviceRepository.update).not.toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it('times out honestly when no ack arrives (never fake green)', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    try {
      const { service, deviceRepository, mqttClient } = setupAckService([validConfig()]);

      const pushPromise = service.pushIoConfigToDevice(DEVICE_ID, TENANT_ID);
      await flushAsync();
      expect(commandIdFor(mqttClient, 'update_io_config')).toEqual(expect.any(String));

      jest.advanceTimersByTime(15001);
      const result = await pushPromise;

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not acknowledged/);
      expect(deviceRepository.update).not.toHaveBeenCalled();

      service.onModuleDestroy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('refuses to push to an offline device without publishing or awaiting', async () => {
    const { service, mqttClient } = setupAckService([], { isOnline: false });

    const result = await service.pushIoConfigToDevice(DEVICE_ID, TENANT_ID);

    expect(result).toEqual({ success: false, error: 'Device is offline' });
    expect(mqttClient.publish).not.toHaveBeenCalled();

    service.onModuleDestroy();
  });

  it('is a no-op for an unrelated commandId', () => {
    const { service } = setupAckService([]);
    expect(
      service.handleIoConfigAckResponse(DEVICE_CODE, { commandId: 'not-a-pending-id', success: true }),
    ).toEqual({ matched: false });
    service.onModuleDestroy();
  });

  it('ignores an ack whose device identifier does not match the pending push', async () => {
    const { service, mqttClient } = setupAckService([validConfig()]);

    const pushPromise = service.pushIoConfigToDevice(DEVICE_ID, TENANT_ID);
    await flushAsync();
    const commandId = commandIdFor(mqttClient, 'update_io_config');

    expect(
      service.handleIoConfigAckResponse('some-other-device', { commandId, success: true }).matched,
    ).toBe(false);

    // The correct device's ack still settles the push.
    service.handleIoConfigAckResponse(DEVICE_CODE, { commandId, success: true });
    await expect(pushPromise).resolves.toEqual({ success: true });

    service.onModuleDestroy();
  });
});
