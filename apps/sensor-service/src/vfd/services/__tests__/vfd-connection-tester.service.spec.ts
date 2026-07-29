/**
 * VfdConnectionTesterService — edge-delegated, honest connection testing
 * (SENSOR-CRITICAL-007 / SENSOR-CRITICAL-009, Faz 2C).
 *
 * The tester opens no sockets and instantiates no in-process adapters. A
 * pre-registration test cannot reach an edge-delegated drive and fails honestly;
 * the authoritative test is a live edge read on a bound device. Per-protocol
 * config comes from the `protocol-config` SSoT.
 */
import { CircuitBreakerService } from '@aquaculture/backend-common/resilience';
import { Test, TestingModule } from '@nestjs/testing';

import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdProtocol, VfdBrand, VfdDeviceStatus } from '../../entities/vfd.enums';
import { VfdConnectionTesterService, TestConnectionInput } from '../vfd-connection-tester.service';
import { VfdDeviceService } from '../vfd-device.service';
import { VfdEdgeReadService, VfdEdgeReadAllResult } from '../vfd-edge-read.service';
import { VfdRegisterMappingService } from '../vfd-register-mapping.service';

const tenantId = 'tenant-123';

function makeDevice(over: Partial<VfdDevice> = {}): VfdDevice {
  const device = {
    id: 'device-123',
    name: 'Test VFD',
    brand: VfdBrand.DANFOSS,
    protocol: VfdProtocol.MODBUS_TCP,
    protocolConfiguration: { host: '192.168.1.100', port: 502, unitId: 1 },
    status: VfdDeviceStatus.DRAFT,
    tenantId,
    edgeDeviceId: 'edge-1',
    edgeModbusDeviceName: 'vfd-pump-1',
    connectionStatus: { isConnected: false },
    ...over,
  };
  return device as VfdDevice;
}

describe('VfdConnectionTesterService (edge-delegated)', () => {
  let service: VfdConnectionTesterService;
  let deviceService: jest.Mocked<VfdDeviceService>;
  let registerMappingService: jest.Mocked<VfdRegisterMappingService>;
  let edgeReadService: jest.Mocked<VfdEdgeReadService>;

  const okRead: VfdEdgeReadAllResult = {
    success: true,
    commandId: 'r-1',
    values: [{ name: 'output_frequency', address: 16129, rawValue: 500 }],
    latencyMs: 12,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdConnectionTesterService,
        {
          provide: VfdDeviceService,
          useValue: {
            findById: jest.fn().mockResolvedValue(makeDevice()),
            updateConnectionStatus: jest.fn().mockResolvedValue(undefined),
            updateStatus: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: VfdRegisterMappingService,
          useValue: {
            getMappingsForBrand: jest.fn().mockResolvedValue([
              {
                parameterName: 'output_frequency',
                registerAddress: 16129,
                registerCount: 1,
                functionCode: 3,
                scalingFactor: 0.1,
                offset: 0,
              },
            ]),
          },
        },
        {
          provide: VfdEdgeReadService,
          useValue: { readAllRegisters: jest.fn().mockResolvedValue(okRead) },
        },
        {
          provide: CircuitBreakerService,
          useValue: {
            // Closed-circuit pass-through: run fn() and let it reject on failure
            // (the real breaker only serves the fallback once OPEN). The service's
            // own try/catch converts a rejection into an honest success:false.
            execute: jest
              .fn()
              .mockImplementation(async (call: { fn: () => Promise<unknown> }) => call.fn()),
          },
        },
      ],
    }).compile();

    service = module.get(VfdConnectionTesterService);
    deviceService = module.get(VfdDeviceService);
    registerMappingService = module.get(VfdRegisterMappingService);
    edgeReadService = module.get(VfdEdgeReadService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('testConnection (pre-registration)', () => {
    const validInput: TestConnectionInput = {
      protocol: VfdProtocol.MODBUS_TCP,
      configuration: { host: '192.168.1.100', port: 502, unitId: 1 },
      brand: VfdBrand.DANFOSS,
    };

    it('never fabricates success for an edge-delegated protocol; explains edge verification', async () => {
      const result = await service.testConnection(validInput);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/edge/i);
      expect(result.protocol).toBe(VfdProtocol.MODBUS_TCP);
      expect(result.configuration).toEqual(validInput.configuration);
      expect(result.testedAt).toBeInstanceOf(Date);
      // No socket, no edge call — a pre-registration test contacts nothing.
      expect(edgeReadService.readAllRegisters).not.toHaveBeenCalled();
    });

    it('surfaces configuration validation errors first', async () => {
      const result = await service.testConnection({
        protocol: VfdProtocol.MODBUS_TCP,
        configuration: { port: 999999 }, // missing host, invalid port
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Configuration validation failed');
    });

    it('fails honestly for an unsupported protocol', async () => {
      const result = await service.testConnection({
        protocol: VfdProtocol.PROFIBUS_DP,
        configuration: {},
      });

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not supported/i);
    });
  });

  describe('testDeviceConnection (edge-delegated)', () => {
    it('reads via the edge, succeeds, decodes a sample, and advances DRAFT → TESTING', async () => {
      const result = await service.testDeviceConnection('device-123', tenantId);

      expect(deviceService.findById).toHaveBeenCalledWith('device-123', tenantId);
      expect(edgeReadService.readAllRegisters).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.latencyMs).toBe(12);
      expect(result.parameters?.outputFrequency).toBeCloseTo(50.0); // 500 * 0.1
      expect(registerMappingService.getMappingsForBrand).toHaveBeenCalledWith(VfdBrand.DANFOSS);
      expect(deviceService.updateConnectionStatus).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        expect.objectContaining({ isConnected: true, lastTestedAt: expect.any(Date) }),
      );
      expect(deviceService.updateStatus).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        VfdDeviceStatus.TESTING,
      );
    });

    it('marks disconnected and TESTING → TEST_FAILED when the edge read fails', async () => {
      deviceService.findById.mockResolvedValueOnce(makeDevice({ status: VfdDeviceStatus.TESTING }));
      edgeReadService.readAllRegisters.mockResolvedValueOnce({
        success: false,
        commandId: 'r-2',
        values: [],
        error: 'drive unreachable',
      });

      const result = await service.testDeviceConnection('device-123', tenantId);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/drive unreachable/);
      expect(deviceService.updateConnectionStatus).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        expect.objectContaining({ isConnected: false }),
      );
      expect(deviceService.updateStatus).toHaveBeenCalledWith(
        'device-123',
        tenantId,
        VfdDeviceStatus.TEST_FAILED,
      );
    });

    it('fails honestly (no edge call) when the device is not bound to an edge gateway', async () => {
      deviceService.findById.mockResolvedValueOnce(
        makeDevice({ edgeDeviceId: undefined, edgeModbusDeviceName: undefined }),
      );

      const result = await service.testDeviceConnection('device-123', tenantId);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not attached to an edge gateway/i);
      expect(edgeReadService.readAllRegisters).not.toHaveBeenCalled();
    });

    it('fails honestly for a device whose protocol has no edge home', async () => {
      deviceService.findById.mockResolvedValueOnce(makeDevice({ protocol: VfdProtocol.PROFINET }));

      const result = await service.testDeviceConnection('device-123', tenantId);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not supported/i);
      expect(edgeReadService.readAllRegisters).not.toHaveBeenCalled();
    });
  });

  describe('config SSoT surface', () => {
    it('validates a well-formed Modbus TCP config', () => {
      expect(
        service.validateConfiguration(VfdProtocol.MODBUS_TCP, { host: '192.168.1.100', port: 502 })
          .valid,
      ).toBe(true);
    });

    it('rejects a Modbus TCP config missing the required host', () => {
      const result = service.validateConfiguration(VfdProtocol.MODBUS_TCP, { port: 502 });
      expect(result.valid).toBe(false);
      expect(result.errors.join(' ')).toMatch(/host/);
    });

    it('returns a schema for Modbus and null for unsupported protocols', () => {
      const schema = service.getProtocolSchema(VfdProtocol.MODBUS_TCP) as Record<string, unknown>;
      expect(schema).toMatchObject({ type: 'object' });
      expect(service.getProtocolSchema(VfdProtocol.BACNET_IP)).toBeNull();
    });

    it('returns defaults for Modbus and null for unsupported protocols', () => {
      expect(service.getDefaultConfiguration(VfdProtocol.MODBUS_TCP)).toMatchObject({ port: 502 });
      expect(service.getDefaultConfiguration(VfdProtocol.CANOPEN)).toBeNull();
    });

    it('lists only selectable (edge-serviceable) protocols — no unsupported ones', () => {
      const protocols = service.getSupportedProtocols();
      const codes = protocols.map((p) => p.code);
      expect(codes).toEqual(
        expect.arrayContaining([VfdProtocol.MODBUS_TCP, VfdProtocol.MODBUS_RTU]),
      );
      expect(codes).not.toContain(VfdProtocol.PROFIBUS_DP);
      expect(codes).not.toContain(VfdProtocol.BACNET_IP);
    });
  });
});
