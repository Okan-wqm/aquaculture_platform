/**
 * VFD Command Service Unit Tests
 */

 
 
 
 

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';

import { VfdCommandAuditLog } from '../../entities/vfd-command-audit-log.entity';
import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdProtocol, VfdBrand, VfdDeviceStatus, VfdCommandType } from '../../entities/vfd.enums';
import { VfdCommandService, VfdCommandInput } from '../vfd-command.service';
import { VfdDeviceService } from '../vfd-device.service';
import { VfdRegisterMappingService } from '../vfd-register-mapping.service';

// Mock the adapters module. The default handle is POOLABLE
// (isConnected: true — getOrCreateConnection reuses it) and the write
// results carry latencyMs/acknowledgedAt like the real adapters do.
jest.mock('../../adapters', () => ({
  createVfdAdapter: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue({ id: 'connection-123', isConnected: true }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    writeControlWord: jest
      .fn()
      .mockResolvedValue({ success: true, latencyMs: 5, acknowledgedAt: new Date() }),
    writeSpeedReference: jest
      .fn()
      .mockResolvedValue({ success: true, latencyMs: 5, acknowledgedAt: new Date() }),
  })),
}));

describe('VfdCommandService', () => {
  let service: VfdCommandService;
  let deviceService: jest.Mocked<VfdDeviceService>;
  let registerMappingService: jest.Mocked<VfdRegisterMappingService>;

  const tenantId = 'tenant-123';

  const mockDevice: Partial<VfdDevice> = {
    id: 'device-123',
    name: 'Test VFD',
    brand: VfdBrand.DANFOSS,
    protocol: VfdProtocol.MODBUS_TCP,
    protocolConfiguration: {
      host: '192.168.1.100',
      port: 502,
      unitId: 1,
      connectionTimeout: 3000,
      responseTimeout: 1000,
    },
    status: VfdDeviceStatus.ACTIVE,
    tenantId,
    connectionStatus: { isConnected: true },
  };

  const mockControlMapping = {
    parameterName: 'control_word',
    registerAddress: 49999,
    dataType: 'uint16',
    scalingFactor: 1,
    isWritable: true,
  };

  const mockSpeedRefMapping = {
    parameterName: 'speed_reference',
    registerAddress: 50000,
    dataType: 'uint16',
    scalingFactor: 0.1,
    isWritable: true,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdCommandService,
        {
          provide: VfdDeviceService,
          useValue: {
            findById: jest.fn().mockResolvedValue(mockDevice),
          },
        },
        {
          provide: VfdRegisterMappingService,
          useValue: {
            getControlWordMapping: jest.fn().mockResolvedValue(mockControlMapping),
            getSpeedReferenceMapping: jest.fn().mockResolvedValue(mockSpeedRefMapping),
            getCommandValue: jest.fn().mockReturnValue(0x047f),
          },
        },
        {
          // DB-SENSOR-HIGH-003: command audit repo (best-effort writer).
          provide: getRepositoryToken(VfdCommandAuditLog),
          useValue: {
            create: jest.fn((x: unknown) => x),
            save: jest.fn().mockResolvedValue(undefined),
            find: jest.fn().mockResolvedValue([]),
          },
        },
      ],
    }).compile();

    service = module.get<VfdCommandService>(VfdCommandService);
    deviceService = module.get(VfdDeviceService);
    registerMappingService = module.get(VfdRegisterMappingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('executeCommand', () => {
    it('should execute START command', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
      expect(deviceService.findById).toHaveBeenCalledWith('device-123', tenantId);
    });

    it('should execute STOP command', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.STOP };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('should execute REVERSE command', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.REVERSE };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('should execute FAULT_RESET command', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.FAULT_RESET };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('should execute QUICK_STOP command', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.QUICK_STOP };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('should execute SET_FREQUENCY command with value', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
        value: 45.0,
      };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('should execute COAST_STOP command', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.COAST_STOP };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('should reject SET_FREQUENCY without value', async () => {
      // executeCommand deliberately swallows validation throws into a
      // result object — callers observe { success: false, error }.
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
      };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBe('SET_FREQUENCY requires a value');
    });

    it('should throw if device not found', async () => {
      deviceService.findById.mockRejectedValueOnce(new NotFoundException());

      const command: VfdCommandInput = { command: VfdCommandType.START };

      await expect(service.executeCommand('non-existent', tenantId, command)).rejects.toThrow(
        NotFoundException
      );
    });

    it('should throw if device is not active', async () => {
      const inactiveDevice = { ...mockDevice, status: VfdDeviceStatus.DRAFT };
      deviceService.findById.mockResolvedValueOnce(inactiveDevice as VfdDevice);

      const command: VfdCommandInput = { command: VfdCommandType.START };

      await expect(service.executeCommand('device-123', tenantId, command)).rejects.toThrow(
        BadRequestException
      );
    });

    it('should lazily connect even when the stored connection status is disconnected', async () => {
      // The connection-status precheck was deliberately removed: connections
      // are lazy + pooled, so a stale persisted `isConnected: false` must not
      // block a command — the service connects on demand.
      const disconnectedDevice = {
        ...mockDevice,
        connectionStatus: { isConnected: false },
      };
      deviceService.findById.mockResolvedValueOnce(disconnectedDevice as VfdDevice);

      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('should return latency in result', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.latencyMs).toBeDefined();
      expect(typeof result.latencyMs).toBe('number');
    });

    it('should handle command execution failure', async () => {
      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockResolvedValue({ id: 'connection-123' }),
        disconnect: jest.fn().mockResolvedValue(undefined),
        writeControlWord: jest.fn().mockResolvedValue({
          success: false,
          error: 'Write failed',
        }),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
    });

    it('should handle connection error', async () => {
      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(new Error('Connection failed')),
        disconnect: jest.fn().mockResolvedValue(undefined),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };

      // Connection failures are swallowed into the result object too.
      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection failed');
    });
  });

  describe('command validation', () => {
    // The mocked speed-reference mapping carries NO min/max bounds, so the
    // service's conservative fallback envelope (0..400 Hz) applies. The
    // validation throw is swallowed by executeCommand into { success, error }.
    it('should validate frequency value range', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
        value: 600, // Over max
      };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/above maximum 400 Hz/);
    });

    it('should validate negative frequency', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
        value: -10,
      };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/below minimum 0 Hz/);
    });
  });

  describe('brand-specific commands', () => {
    // The previous API exposed a `getCommandValue(brand, commandType)`
    // method on VfdRegisterMappingService that derived the wire value
    // for a given brand+command pair. That method was removed when
    // VfdCommandService inlined the derivation — see
    // vfd-command.service.ts:169 (`getControlWordMapping(brand)` is
    // the surviving brand-aware call). The brand-aware behaviour is
    // now exercised through `getControlWordMapping` which is what
    // the command path actually calls.

    it('should use Danfoss-specific control-word mapping', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);

      expect(registerMappingService.getControlWordMapping).toHaveBeenCalledWith(
        VfdBrand.DANFOSS,
      );
    });

    it('should use ABB-specific control-word mapping for ABB device', async () => {
      const abbDevice = { ...mockDevice, brand: VfdBrand.ABB };
      deviceService.findById.mockResolvedValueOnce(abbDevice as VfdDevice);

      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);

      expect(registerMappingService.getControlWordMapping).toHaveBeenCalledWith(
        VfdBrand.ABB,
      );
    });
  });

  describe('connection management (pooled)', () => {
    // Per-command disconnect was deliberately replaced by a per-device
    // connection pool (60 s idle window) — these tests pin the pooling
    // contract instead of the retired connect/disconnect-per-command flow.
    it('should reuse the pooled connection across commands', async () => {
      const { createVfdAdapter } = require('../../adapters');
      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);
      await service.executeCommand('device-123', tenantId, command);

      // One adapter, one connect — the second command rode the pool.
      expect(createVfdAdapter).toHaveBeenCalledTimes(1);
      const adapterInstance = createVfdAdapter.mock.results[0].value;
      expect(adapterInstance.connect).toHaveBeenCalledTimes(1);
      expect(adapterInstance.writeControlWord).toHaveBeenCalledTimes(2);
    });

    it('should disconnect when the connection is released', async () => {
      const { createVfdAdapter } = require('../../adapters');
      const mockDisconnect = jest.fn().mockResolvedValue(undefined);
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockResolvedValue({ id: 'connection-123', isConnected: true }),
        disconnect: mockDisconnect,
        writeControlWord: jest
          .fn()
          .mockResolvedValue({ success: true, latencyMs: 5, acknowledgedAt: new Date() }),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);
      expect(mockDisconnect).not.toHaveBeenCalled(); // pooled, still open

      await service.closeConnection('device-123');
      expect(mockDisconnect).toHaveBeenCalledTimes(1);
    });
  });
});
