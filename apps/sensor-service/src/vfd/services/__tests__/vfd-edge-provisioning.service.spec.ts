/**
 * VfdEdgeProvisioningService — VFD → edge Modbus device bridge (SENSOR-CRITICAL-007).
 *
 * These tests pin the two guarantees the edge-delegated write path depends on:
 *  1. A bound Modbus drive is translated into a correct edge ModbusDeviceConfig
 *     (connection + register map + WRITABLE-only allowed_write_ranges).
 *  2. Provisioning is a real edge round-trip — success only on a real ack, and a
 *     non-Modbus / unbound drive is skipped, never silently "provisioned".
 */
import { VfdEdgeProvisioningService } from '../vfd-edge-provisioning.service';
import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdRegisterMapping } from '../../entities/vfd-register-mapping.entity';
import { VfdBrand, VfdDataType, VfdDeviceStatus, VfdProtocol } from '../../entities/vfd.enums';

function mapping(over: Partial<VfdRegisterMapping>): VfdRegisterMapping {
  return {
    parameterName: 'control_word',
    registerAddress: 49999,
    registerCount: 1,
    functionCode: 6,
    dataType: VfdDataType.CONTROL_WORD,
    scalingFactor: 1,
    unit: null,
    isWritable: true,
    ...over,
  } as VfdRegisterMapping;
}

const WRITABLE = [
  mapping({ parameterName: 'control_word', registerAddress: 49999 }),
  mapping({
    parameterName: 'speed_reference',
    registerAddress: 50000,
    dataType: VfdDataType.UINT16,
  }),
];
const ALL = [
  ...WRITABLE,
  mapping({
    parameterName: 'status_word',
    registerAddress: 50100,
    functionCode: 3,
    dataType: VfdDataType.STATUS_WORD,
    isWritable: false,
  }),
];

function makeService(opts: { writable?: VfdRegisterMapping[]; connected?: boolean } = {}) {
  const registerMapping = {
    getMappingsForBrand: jest.fn().mockResolvedValue(ALL),
    getWritableMappings: jest.fn().mockResolvedValue(opts.writable ?? WRITABLE),
  };
  const repo = { find: jest.fn().mockResolvedValue([]) };
  const mqtt = {
    isConnectedToBroker: jest.fn().mockReturnValue(opts.connected ?? true),
    publish: jest.fn().mockResolvedValue(undefined),
  };
  const svc = new VfdEdgeProvisioningService(
    mqtt as never,
    registerMapping as never,
    repo as never,
  );
  return { svc, registerMapping, repo, mqtt };
}

function makeVfdDevice(overrides: Partial<VfdDevice> = {}): VfdDevice {
  const base: VfdDevice = {
    id: 'vfd-1',
    name: 'Pump 1 VFD',
    brand: VfdBrand.DANFOSS,
    protocol: VfdProtocol.MODBUS_TCP,
    protocolConfiguration: {
      host: '10.0.0.5',
      port: 502,
      unitId: 3,
      connectionTimeout: 5000,
      responseTimeout: 2000,
    },
    status: VfdDeviceStatus.ACTIVE,
    tenantId: 'tenant-1',
    pollIntervalMs: 1000,
    isPollingEnabled: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    edgeDeviceId: 'edge-1',
    edgeModbusDeviceName: 'vfd-pump-1',
  };
  return { ...base, ...overrides };
}

const tcpDevice = makeVfdDevice();

const flush = (): Promise<void> => new Promise((r) => setImmediate(r));

interface PublishedEnvelope {
  commandId: string;
  command: string;
  params: Record<string, unknown>;
}

describe('VfdEdgeProvisioningService', () => {
  describe('buildModbusDeviceConfig', () => {
    it('translates a bound Modbus-TCP drive into an edge device config', async () => {
      const { svc } = makeService();
      const config = await svc.buildModbusDeviceConfig(tcpDevice);
      expect(config).not.toBeNull();
      expect(config).toMatchObject({
        name: 'vfd-pump-1',
        connection_type: 'tcp',
        address: '10.0.0.5:502',
        slave_id: 3,
      });
      // Registers carry the full brand map; control word is a holding-register u16.
      expect(config!.registers).toHaveLength(3);
      expect(config!.registers[0]).toMatchObject({
        name: 'control_word',
        address: 49999,
        register_type: 'holding',
        data_type: 'u16',
      });
    });

    it('derives allowed_write_ranges from WRITABLE registers only + enables writes', async () => {
      const { svc } = makeService();
      const config = await svc.buildModbusDeviceConfig(tcpDevice);
      expect(config!.security.allow_writes).toBe(true);
      // 49999 (control word) + 50000 (speed ref); the read-only status word (50100)
      // is NOT a write range.
      expect(config!.security.allowed_write_ranges).toEqual([
        [49999, 49999],
        [50000, 50000],
      ]);
      // Write function codes are admitted; the address whitelist is the fine gate.
      expect(config!.security.allowed_function_codes).toContain(6);
    });

    it('provisions read-only (allow_writes=false) when there are no writable registers', async () => {
      const { svc } = makeService({ writable: [] });
      const config = await svc.buildModbusDeviceConfig(tcpDevice);
      expect(config!.security.allow_writes).toBe(false);
      expect(config!.security.allowed_write_ranges).toEqual([]);
    });

    it('returns null for a non-Modbus protocol', async () => {
      const { svc } = makeService();
      const profibus = makeVfdDevice({
        protocol: VfdProtocol.PROFIBUS_DP,
        protocolConfiguration: { stationAddress: 5, baudRate: 187500, ppoType: 1 },
      });
      expect(await svc.buildModbusDeviceConfig(profibus)).toBeNull();
    });
  });

  describe('provisionDevice', () => {
    it('publishes provision_modbus_device to the gateway and resolves on the ack', async () => {
      const { svc, mqtt } = makeService();
      const pending = svc.provisionDevice(tcpDevice);
      await flush();

      expect(mqtt.publish).toHaveBeenCalledTimes(1);
      const [topic, envelope] = mqtt.publish.mock.calls[0] as [string, PublishedEnvelope];
      expect(topic).toBe('tenants/tenant-1/devices/edge-1/commands');
      expect(envelope.command).toBe('provision_modbus_device');
      expect((envelope.params as { device: { name: string } }).device.name).toBe('vfd-pump-1');

      svc.handleProvisionResponse({ commandId: envelope.commandId, success: true });
      await expect(pending).resolves.toMatchObject({ success: true });
    });

    it('reports failure with the edge reason when the gateway rejects', async () => {
      const { svc, mqtt } = makeService();
      const pending = svc.provisionDevice(tcpDevice);
      await flush();
      const envelope = mqtt.publish.mock.calls[0][1] as PublishedEnvelope;
      svc.handleProvisionResponse({
        commandId: envelope.commandId,
        success: false,
        error: 'allow_writes=true requires non-empty allowed_write_ranges',
      });
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.error).toContain('allowed_write_ranges');
    });

    it('skips (does not publish) an unbound drive', async () => {
      const { svc, mqtt } = makeService();
      const unbound = makeVfdDevice({ edgeDeviceId: undefined, edgeModbusDeviceName: undefined });
      const result = await svc.provisionDevice(unbound);
      expect(result.skipped).toBe(true);
      expect(result.success).toBe(false);
      expect(mqtt.publish).not.toHaveBeenCalled();
    });

    it('skips a non-Modbus protocol without publishing', async () => {
      const { svc, mqtt } = makeService();
      const profinet = makeVfdDevice({
        protocol: VfdProtocol.PROFINET,
        protocolConfiguration: { deviceName: 'drive', ipAddress: '10.0.0.9', updateCycleMs: 8 },
      });
      const result = await svc.provisionDevice(profinet);
      expect(result.skipped).toBe(true);
      expect(mqtt.publish).not.toHaveBeenCalled();
    });

    it('fails closed when the broker is disconnected', async () => {
      const { svc, mqtt } = makeService({ connected: false });
      const result = await svc.provisionDevice(tcpDevice);
      expect(result.success).toBe(false);
      expect(result.error).toContain('MQTT broker');
      expect(mqtt.publish).not.toHaveBeenCalled();
    });
  });

  describe('decommissionDevice', () => {
    it('publishes decommission_modbus_device with the device name', async () => {
      const { svc, mqtt } = makeService();
      const pending = svc.decommissionDevice({
        tenantId: 'tenant-1',
        edgeDeviceId: 'edge-1',
        edgeModbusDeviceName: 'vfd-pump-1',
      });
      await flush();
      const [topic, envelope] = mqtt.publish.mock.calls[0] as [string, PublishedEnvelope];
      expect(topic).toBe('tenants/tenant-1/devices/edge-1/commands');
      expect(envelope.command).toBe('decommission_modbus_device');
      expect((envelope.params as { device: string }).device).toBe('vfd-pump-1');
      svc.handleProvisionResponse({ commandId: envelope.commandId, success: true });
      await expect(pending).resolves.toMatchObject({ success: true });
    });

    it('skips when there is no binding to remove', async () => {
      const { svc, mqtt } = makeService();
      const result = await svc.decommissionDevice({ tenantId: 'tenant-1' });
      expect(result.skipped).toBe(true);
      expect(mqtt.publish).not.toHaveBeenCalled();
    });
  });

  describe('reprovisionAllForEdge', () => {
    it('re-provisions every bound drive owned by the gateway', async () => {
      const { svc, repo, mqtt } = makeService();
      repo.find.mockResolvedValue([
        tcpDevice,
        { ...tcpDevice, id: 'vfd-2', edgeModbusDeviceName: 'vfd-pump-2' },
        { ...tcpDevice, id: 'vfd-3', edgeModbusDeviceName: undefined }, // unbound → filtered out
      ]);
      // Auto-ack each publish so the awaited provisions resolve.
      mqtt.publish.mockImplementation((_topic: string, envelope: { commandId: string }) => {
        setImmediate(() =>
          svc.handleProvisionResponse({ commandId: envelope.commandId, success: true }),
        );
        return Promise.resolve();
      });

      const outcomes = await svc.reprovisionAllForEdge('edge-1', 'tenant-1');
      expect(repo.find).toHaveBeenCalledWith({
        where: { edgeDeviceId: 'edge-1', tenantId: 'tenant-1' },
      });
      expect(outcomes.map((o) => o.vfdDeviceId)).toEqual(['vfd-1', 'vfd-2']);
      expect(outcomes.every((o) => o.result.success)).toBe(true);
    });
  });
});
