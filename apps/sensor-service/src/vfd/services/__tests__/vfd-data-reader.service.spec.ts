/**
 * VfdDataReaderService — edge-delegated VFD telemetry (SENSOR-CRITICAL-007 / Faz 4).
 *
 * Pins that live reads go through the edge and are decoded honestly: a real edge
 * read is decoded + persisted; a failed edge read throws and marks the drive
 * disconnected rather than returning fabricated telemetry (SENSOR-HIGH-067).
 */
import { VfdDataReaderService } from '../vfd-data-reader.service';
import { VfdBrand, VfdDeviceStatus, VfdProtocol } from '../../entities/vfd.enums';
import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdEdgeReadAllResult } from '../vfd-edge-read.service';

function makeDevice(): VfdDevice {
  const d = new VfdDevice();
  d.id = 'vfd-1';
  d.tenantId = 'tenant-1';
  d.name = 'Pump VFD';
  d.brand = VfdBrand.DANFOSS;
  d.protocol = VfdProtocol.MODBUS_TCP;
  d.protocolConfiguration = { host: '10.0.0.5', port: 502, unitId: 1 } as never;
  d.status = VfdDeviceStatus.ACTIVE;
  d.pollIntervalMs = 1000;
  d.isPollingEnabled = true;
  d.edgeDeviceId = 'edge-1';
  d.edgeModbusDeviceName = 'vfd-pump-1';
  d.createdAt = new Date();
  d.updatedAt = new Date();
  return d;
}

function makeService(readAllImpl: () => Promise<VfdEdgeReadAllResult>) {
  const readingRepo = {
    create: jest.fn((x: unknown) => x),
    save: jest.fn().mockImplementation((x: unknown) => Promise.resolve(x)),
  };
  const deviceService = {
    findById: jest.fn().mockResolvedValue(makeDevice()),
    updateConnectionStatus: jest.fn().mockResolvedValue(undefined),
  };
  const registerMapping = {
    getMappingsForBrand: jest.fn().mockResolvedValue([
      {
        parameterName: 'output_frequency',
        registerAddress: 100,
        registerCount: 1,
        functionCode: 3,
        scalingFactor: 0.1,
        offset: 0,
      },
    ]),
    getCriticalMappings: jest.fn().mockResolvedValue([]),
  };
  const edgeRead = { readAllRegisters: jest.fn().mockImplementation(readAllImpl) };
  const svc = new VfdDataReaderService(
    readingRepo as never,
    deviceService as never,
    registerMapping as never,
    edgeRead as never,
  );
  return { svc, readingRepo, deviceService, edgeRead };
}

describe('VfdDataReaderService (edge-delegated)', () => {
  it('reads via the edge, decodes, saves a reading, and marks the drive connected', async () => {
    const { svc, readingRepo, deviceService, edgeRead } = makeService(async () => ({
      success: true,
      commandId: 'r-1',
      values: [{ name: 'output_frequency', address: 100, rawValue: 500 }],
      latencyMs: 8,
    }));

    const result = await svc.readParameters('vfd-1', 'tenant-1');

    expect(edgeRead.readAllRegisters).toHaveBeenCalledTimes(1);
    expect(result.parameters.outputFrequency).toBeCloseTo(50.0); // 500 * 0.1
    expect(readingRepo.save).toHaveBeenCalledTimes(1);
    expect(deviceService.updateConnectionStatus).toHaveBeenCalledWith(
      'vfd-1',
      'tenant-1',
      expect.objectContaining({ isConnected: true }),
    );
  });

  it('throws and marks disconnected when the edge read fails (no fabricated reading)', async () => {
    const { svc, readingRepo, deviceService } = makeService(async () => ({
      success: false,
      commandId: 'r-1',
      values: [],
      error: 'drive unreachable',
    }));

    await expect(svc.readParameters('vfd-1', 'tenant-1')).rejects.toThrow(/drive unreachable/);
    expect(readingRepo.save).not.toHaveBeenCalled();
    expect(deviceService.updateConnectionStatus).toHaveBeenCalledWith(
      'vfd-1',
      'tenant-1',
      expect.objectContaining({ isConnected: false }),
    );
  });
});
