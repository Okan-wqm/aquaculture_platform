/**
 * VfdEdgeProvisioningService — VFD → edge Modbus device bridge (SENSOR-CRITICAL-007).
 *
 * These tests pin the three guarantees the edge-delegated I/O path depends on:
 *  1. A bound Modbus drive is translated into a correct edge ModbusDeviceConfig
 *     (connection + register map + WRITABLE-only allowed_write_ranges).
 *  2. The register map the edge receives covers BOTH catalogues — telemetry and
 *     configuration — because the edge answers `read_modbus` with exactly the
 *     registers it was provisioned with, and an unprovisioned address is
 *     unreadable in production.
 *  3. Provisioning is a real edge round-trip — success only on a real ack, and a
 *     non-Modbus / unbound drive is skipped, never silently "provisioned".
 */
import { VfdEdgeProvisioningService } from '../vfd-edge-provisioning.service';
import { VfdEdgeReadService } from '../vfd-edge-read.service';
import { VfdRegisterMappingService } from '../vfd-register-mapping.service';
import {
  getVfdConfigRegisters,
  getVfdRegisterMappings,
  getWritableParameters,
} from '../../brand-configs';
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
    // Provisioning asks for the EDGE-READABLE set (telemetry ∪ configuration).
    // The union itself is exercised against the real catalogues further down;
    // here the stub stands in for it so the envelope/ack tests stay focused.
    getEdgeReadableMappings: jest.fn().mockResolvedValue(ALL),
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

  /**
   * Configuration-drift Phase A.
   *
   * These run against the REAL brand catalogues and the REAL
   * VfdRegisterMappingService — only the TypeORM repository is stubbed (empty),
   * so the service falls back to the built-in catalogues exactly as a stock
   * install does. Nothing here simulates a drive or an edge gateway: every
   * assertion is about the payload the cloud puts on the wire, which is the part
   * that was wrong. Whether a physical drive answers those addresses is hardware
   * verification, and this suite does not claim it.
   */
  describe('configuration registers reach the edge (real brand catalogues)', () => {
    const U16_MAX = 0xffff;
    const inU16 = (a: number): boolean => Number.isInteger(a) && a >= 0 && a <= U16_MAX;
    const brands = Object.values(VfdBrand);

    function realService(): {
      svc: VfdEdgeProvisioningService;
      mqtt: { isConnectedToBroker: jest.Mock; publish: jest.Mock };
    } {
      const mappingRepo = { find: jest.fn().mockResolvedValue([]) };
      const mappingService = new VfdRegisterMappingService(mappingRepo as never);
      const deviceRepo = { find: jest.fn().mockResolvedValue([]) };
      const mqtt = {
        isConnectedToBroker: jest.fn().mockReturnValue(true),
        publish: jest.fn().mockResolvedValue(undefined),
      };
      const svc = new VfdEdgeProvisioningService(
        mqtt as never,
        mappingService,
        deviceRepo as never,
      );
      return { svc, mqtt };
    }

    it.each(brands)(
      '%s — every configuration register is present in the provisioned read map',
      async (brand) => {
        const { svc } = realService();
        const config = await svc.buildModbusDeviceConfig(makeVfdDevice({ brand }));
        expect(config).not.toBeNull();
        const provisioned = new Set(config!.registers.map((r) => r.address));

        const configAddresses = [
          ...new Set(
            getVfdConfigRegisters(brand)
              .map((r) => r.registerAddress)
              .filter(inU16),
          ),
        ];
        // A brand with an empty configuration catalogue would make the assertion
        // below vacuously true — the catalogue's existence is part of the claim.
        expect(configAddresses.length).toBeGreaterThan(0);
        expect(configAddresses.filter((a) => !provisioned.has(a))).toEqual([]);
      },
    );

    it.each(brands)('%s — telemetry registers are still provisioned', async (brand) => {
      const { svc } = realService();
      const config = await svc.buildModbusDeviceConfig(makeVfdDevice({ brand }));
      const provisioned = new Set(config!.registers.map((r) => r.address));
      const telemetryAddresses = [
        ...new Set(
          getVfdRegisterMappings(brand)
            .map((r) => r.registerAddress)
            .filter(inU16),
        ),
      ];
      expect(telemetryAddresses.length).toBeGreaterThan(0);
      expect(telemetryAddresses.filter((a) => !provisioned.has(a))).toEqual([]);
    });

    it.each(brands)('%s — the union adds no address the map already carries', async (brand) => {
      // Delta (1537) and Mitsubishi (1, 2) publish the same address in both
      // catalogues, and Mitsubishi's configuration catalogue claims 9 twice on
      // its own; a naive concatenation would make the edge read those registers
      // twice per cycle and answer with two entries for one address.
      //
      // The comparison is against the TELEMETRY map rather than against 1,
      // because Siemens' telemetry catalogue already claims address 25 twice
      // (see the catalogue-collision test below). Collapsing that here would
      // change what telemetry decodes today, so the property under test is that
      // the union introduces no NEW duplication — not that the pre-existing one
      // disappeared.
      const { svc } = realService();
      const config = await svc.buildModbusDeviceConfig(makeVfdDevice({ brand }));

      const countByAddress = (addresses: number[]): Map<number, number> => {
        const counts = new Map<number, number>();
        for (const a of addresses) counts.set(a, (counts.get(a) ?? 0) + 1);
        return counts;
      };
      const provisionedCounts = countByAddress(config!.registers.map((r) => r.address));
      const telemetryCounts = countByAddress(
        getVfdRegisterMappings(brand)
          .map((r) => r.registerAddress)
          .filter(inU16),
      );

      const overCounted = [...provisionedCounts.entries()].filter(
        ([address, count]) => count !== (telemetryCounts.get(address) ?? 1),
      );
      expect(overCounted).toEqual([]);
    });

    it('pins the catalogue address collisions that exist today', () => {
      // Two parameters at one address cannot both be read: the edge answers per
      // address and `buildVfdReadResult` keys by address, so the second name
      // silently receives the first one's value. Both collisions below are
      // catalogue-authoring defects that predate this change; pinning them makes
      // a THIRD one fail at authoring time instead of shipping as wrong
      // telemetry.
      const collisions: Array<{ brand: string; catalogue: string; address: number }> = [];
      for (const brand of brands) {
        const scan = (catalogue: string, entries: Array<{ registerAddress: number }>): void => {
          const counts = new Map<number, number>();
          for (const e of entries) {
            counts.set(e.registerAddress, (counts.get(e.registerAddress) ?? 0) + 1);
          }
          for (const [address, count] of counts) {
            if (count > 1) collisions.push({ brand, catalogue, address });
          }
        };
        scan('telemetry', getVfdRegisterMappings(brand));
        scan('configuration', getVfdConfigRegisters(brand));
      }

      expect(collisions).toEqual([
        // r0025 is claimed by both `motor_voltage` and `dc_bus_voltage`, so a
        // Siemens drive reports its output voltage as its DC bus voltage.
        { brand: VfdBrand.SIEMENS, catalogue: 'telemetry', address: 25 },
        // Pr.9 is claimed by both `motor_nom_current` and
        // `thermal_relay_function`.
        { brand: VfdBrand.MITSUBISHI, catalogue: 'configuration', address: 9 },
      ]);
    });

    it('keeps the TELEMETRY entry when both catalogues claim one address', async () => {
      // Delta publishes 1537 in both catalogues. The telemetry decoder
      // (buildVfdReadResult) is written against the telemetry entry's name,
      // scaling and data type, so that entry has to be the one provisioned —
      // otherwise widening the read map would quietly rewrite telemetry.
      const { svc } = realService();
      const config = await svc.buildModbusDeviceConfig(makeVfdDevice({ brand: VfdBrand.DELTA }));
      const telemetryEntry = getVfdRegisterMappings(VfdBrand.DELTA).find(
        (r) => r.registerAddress === 1537,
      );
      const configEntry = getVfdConfigRegisters(VfdBrand.DELTA).find(
        (r) => r.registerAddress === 1537,
      );
      // Both halves of the collision must actually exist, or the test proves
      // nothing about collision handling.
      expect(telemetryEntry).toBeDefined();
      expect(configEntry).toBeDefined();
      expect(telemetryEntry!.parameterName).not.toBe(configEntry!.parameterName);

      const provisionedAt1537 = config!.registers.filter((r) => r.address === 1537);
      expect(provisionedAt1537).toHaveLength(1);
      expect(provisionedAt1537[0]!.name).toBe(telemetryEntry!.parameterName);
    });

    it.each(brands)(
      '%s — allowed_write_ranges still derives from writable TELEMETRY registers alone',
      async (brand) => {
        const { svc } = realService();
        const config = await svc.buildModbusDeviceConfig(makeVfdDevice({ brand }));

        // Expected ranges are computed from the catalogue accessor rather than
        // from the service under test, so this pins the SOURCE of write
        // authority, not merely that the service is self-consistent.
        const expected: Array<[number, number]> = [];
        const seen = new Set<string>();
        for (const r of getWritableParameters(brand)) {
          const start = r.registerAddress;
          const end = start + Math.max(r.registerCount ?? 1, 1) - 1;
          if (!inU16(start) || !inU16(end) || end < start) continue;
          const key = `${start}:${end}`;
          if (seen.has(key)) continue;
          seen.add(key);
          expected.push([start, end]);
        }
        expect(config!.security.allowed_write_ranges).toEqual(expected);
      },
    );

    it.each(brands)('%s — no configuration-only address became writable', async (brand) => {
      // The load-bearing security assertion: making a register READABLE must not
      // make it writable. Addresses that exist only in the configuration
      // catalogue are the ones the read map newly carries, so they are exactly
      // the set that could have leaked into the write whitelist.
      const { svc } = realService();
      const config = await svc.buildModbusDeviceConfig(makeVfdDevice({ brand }));
      const telemetryAddresses = new Set(
        getVfdRegisterMappings(brand).map((r) => r.registerAddress),
      );
      const configOnly = getVfdConfigRegisters(brand)
        .map((r) => r.registerAddress)
        .filter((a) => inU16(a) && !telemetryAddresses.has(a));
      expect(configOnly.length).toBeGreaterThan(0);

      const isWritable = (a: number): boolean =>
        config!.security.allowed_write_ranges.some(([start, end]) => a >= start && a <= end);
      expect(configOnly.filter(isWritable)).toEqual([]);
    });

    it('resolves a configuration address out of a read_modbus response shaped by the provisioned map', async () => {
      // HONEST SCOPE: this exercises the CLOUD-side contract only — that the
      // address the provisioner puts in the register map is the address the
      // reader extracts by. The response is built FROM the provisioned register
      // list rather than invented, but no drive and no gateway took part.
      // Whether a real SINAMICS answers P1120 over Modbus is hardware
      // verification, and it is NOT what passes here.
      const { svc } = realService();
      const device = makeVfdDevice({ brand: VfdBrand.SIEMENS });
      const provisioned = await svc.buildModbusDeviceConfig(device);

      const accelTime = getVfdConfigRegisters(VfdBrand.SIEMENS).find(
        (r) => r.parameterName === 'accel_time',
      );
      expect(accelTime).toBeDefined();

      const mqtt = {
        isConnectedToBroker: jest.fn().mockReturnValue(true),
        publish: jest.fn().mockResolvedValue(undefined),
      };
      const reader = new VfdEdgeReadService(mqtt as never);
      const pending = reader.readRegister(device, accelTime!.registerAddress, 'read accel_time');
      await flush();
      const envelope = mqtt.publish.mock.calls[0][1] as PublishedEnvelope;

      reader.handleReadResponse({
        commandId: envelope.commandId,
        success: true,
        result: {
          devices: [
            {
              device: device.edgeModbusDeviceName,
              // `read_modbus` answers with every register the device was
              // provisioned with — so the response is that list.
              values: provisioned!.registers.map((r) => ({
                name: r.name,
                address: r.address,
                raw_value: 1000,
                scaled_value: 1000 * r.scale,
              })),
            },
          ],
        },
      });

      const result = await pending;
      expect(result.success).toBe(true);
      expect(result.found).toBe(true);
      expect(result.rawValue).toBe(1000);
    });

    it('reports found:false for that same address when the map carries telemetry only', async () => {
      // Counter-proof that the assertion above is not vacuous: replay the
      // identical read against the PRE-Phase-A payload (telemetry catalogue
      // only) and the parameter comes back unknown — which is what every
      // configuration read did in production.
      const { svc } = realService();
      const device = makeVfdDevice({ brand: VfdBrand.SIEMENS });
      const provisioned = await svc.buildModbusDeviceConfig(device);
      const telemetryAddresses = new Set(
        getVfdRegisterMappings(VfdBrand.SIEMENS).map((r) => r.registerAddress),
      );
      const accelTime = getVfdConfigRegisters(VfdBrand.SIEMENS).find(
        (r) => r.parameterName === 'accel_time',
      );

      const mqtt = {
        isConnectedToBroker: jest.fn().mockReturnValue(true),
        publish: jest.fn().mockResolvedValue(undefined),
      };
      const reader = new VfdEdgeReadService(mqtt as never);
      const pending = reader.readRegister(device, accelTime!.registerAddress, 'read accel_time');
      await flush();
      const envelope = mqtt.publish.mock.calls[0][1] as PublishedEnvelope;

      reader.handleReadResponse({
        commandId: envelope.commandId,
        success: true,
        result: {
          devices: [
            {
              device: device.edgeModbusDeviceName,
              values: provisioned!.registers
                .filter((r) => telemetryAddresses.has(r.address))
                .map((r) => ({
                  name: r.name,
                  address: r.address,
                  raw_value: 1000,
                  scaled_value: 1000 * r.scale,
                })),
            },
          ],
        },
      });

      const result = await pending;
      expect(result.success).toBe(true);
      expect(result.found).toBe(false);
      expect(result.error).toContain('not present');
    });
  });
});
