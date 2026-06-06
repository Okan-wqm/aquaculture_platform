import { readFileSync } from 'fs';
import { join } from 'path';

import { EdgeDeviceService } from '../edge-device.service';
import { DeviceIoConfig, IoDataType, IoType } from '../entities/device-io-config.entity';

const TENANT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DEVICE_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const DEVICE_CODE = 'edge-device-01';

function makeMqttClient() {
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
    deviceRepository as any,
    ioConfigRepository as any,
    loraDeviceRepository as any,
    {} as any,
    (overrides.mqttClient === undefined ? null : overrides.mqttClient) as any,
    {} as any,
    { get: jest.fn() } as any,
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

  afterEach(async () => {
    await service.onModuleDestroy();
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
    const normalized = JSON.parse(JSON.stringify(result));
    const golden = JSON.parse(
      readFileSync(
        join(process.cwd(), 'tools/gates/fixtures/agent-io-config-v2.golden.json'),
        'utf8',
      ),
    );

    expect(normalized).toEqual(golden);
  });

  it('refuses to push active configs that cannot be represented in AgentIoConfigV2', async () => {
    const mqttClient = makeMqttClient();
    await service.onModuleDestroy();
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
    await service.onModuleDestroy();
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
    await service.onModuleDestroy();
    service = makeService({ mqttClient });

    const pingPromise = service.pingDevice(DEVICE_ID, TENANT_ID);
    await flushAsync();

    const publishPayload = mqttClient.publish.mock.calls[0]?.[1] as Record<string, unknown>;
    const commandId = publishPayload['commandId'] as string;
    let settled = false;
    pingPromise.then(() => {
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
