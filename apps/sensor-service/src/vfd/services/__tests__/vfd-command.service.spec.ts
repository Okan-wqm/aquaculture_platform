/**
 * VFD Command Service Unit Tests
 */

 
 
 
 

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';

import { VfdDevice } from '../../entities/vfd-device.entity';
import { VfdProtocol, VfdBrand, VfdDeviceStatus, VfdCommandType } from '../../entities/vfd.enums';
import { VfdCommandService, VfdCommandInput } from '../vfd-command.service';
import { VfdDeviceService } from '../vfd-device.service';
import { VfdRegisterMappingService } from '../vfd-register-mapping.service';

// Mock the adapters module
jest.mock('../../adapters', () => ({
  createVfdAdapter: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue({ id: 'connection-123' }),
    disconnect: jest.fn().mockResolvedValue(undefined),
    // Real adapter write results carry the round-trip latency; the command
    // service passes result.latencyMs straight through.
    writeControlWord: jest.fn().mockResolvedValue({ success: true, latencyMs: 12 }),
    writeSpeedReference: jest.fn().mockResolvedValue({ success: true, latencyMs: 12 }),
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
    // Range bounds so executeSetFrequency's guard actually fires: 45 Hz is in
    // range, 600 Hz is over-max and -10 Hz is under-min (both must be rejected).
    minValue: 0,
    maxValue: 50,
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

    it('should reject SET_FREQUENCY without value', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
      };

      // executeCommand surfaces in-flow command errors (missing value, range,
      // connect/write failures) as { success: false, error } — it only throws
      // for the device preconditions (not found / not active). The command is
      // still rejected (no frequency is written); the diagnostic is on `error`.
      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/requires a value/i);
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

    it('should fail (not throw) when the live connection cannot be established', async () => {
      // The command path no longer gates on the persisted (possibly stale)
      // connectionStatus flag — it opens a live connection. When that live
      // connection fails, the result is { success: false } rather than a throw.
      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockRejectedValue(new Error('No route to host')),
        disconnect: jest.fn().mockResolvedValue(undefined),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/No route to host/);
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

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Connection failed');
    });
  });

  describe('command validation', () => {
    it('should validate frequency value range', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
        value: 600, // Over max
      };

      // Range validation still blocks the write; surfaced as { success: false }.
      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should validate negative frequency', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
        value: -10,
      };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
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

  describe('connection management', () => {
    it('should pool and reuse the connection across commands (no per-command disconnect)', async () => {
      const { createVfdAdapter } = require('../../adapters');
      const mockConnect = jest
        .fn()
        .mockResolvedValue({ id: 'connection-123', isConnected: true });
      const mockDisconnect = jest.fn().mockResolvedValue(undefined);
      // One adapter is created for the device and cached; both commands reuse it.
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: mockConnect,
        disconnect: mockDisconnect,
        writeControlWord: jest.fn().mockResolvedValue({ success: true, latencyMs: 12 }),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };
      await service.executeCommand('device-123', tenantId, command);
      await service.executeCommand('device-123', tenantId, command);

      // Connection is opened once and pooled — not torn down after each command.
      expect(mockConnect).toHaveBeenCalledTimes(1);
      expect(mockDisconnect).not.toHaveBeenCalled();
    });

    it('should surface a write failure as { success: false } without throwing', async () => {
      const { createVfdAdapter } = require('../../adapters');
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockResolvedValue({ id: 'connection-123', isConnected: true }),
        disconnect: jest.fn().mockResolvedValue(undefined),
        writeControlWord: jest.fn().mockRejectedValue(new Error('Write error')),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write error');
    });
  });
});
