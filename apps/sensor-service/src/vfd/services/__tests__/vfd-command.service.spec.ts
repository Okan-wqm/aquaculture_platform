/**
 * VFD Command Service Unit Tests
 */

/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */

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
    writeControlWord: jest.fn().mockResolvedValue({ success: true }),
    writeSpeedReference: jest.fn().mockResolvedValue({ success: true }),
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
    protocolConfiguration: { host: '192.168.1.100', port: 502, unitId: 1 },
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

      await expect(service.executeCommand('device-123', tenantId, command)).rejects.toThrow(
        BadRequestException
      );
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

    it('should throw if device is not connected', async () => {
      const disconnectedDevice = {
        ...mockDevice,
        connectionStatus: { isConnected: false },
      };
      deviceService.findById.mockResolvedValueOnce(disconnectedDevice as VfdDevice);

      const command: VfdCommandInput = { command: VfdCommandType.START };

      await expect(service.executeCommand('device-123', tenantId, command)).rejects.toThrow(
        BadRequestException
      );
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

      await expect(service.executeCommand('device-123', tenantId, command)).rejects.toThrow(
        'Connection failed'
      );
    });
  });

  describe('command validation', () => {
    it('should validate frequency value range', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
        value: 600, // Over max
      };

      await expect(service.executeCommand('device-123', tenantId, command)).rejects.toThrow(
        BadRequestException
      );
    });

    it('should validate negative frequency', async () => {
      const command: VfdCommandInput = {
        command: VfdCommandType.SET_FREQUENCY,
        value: -10,
      };

      await expect(service.executeCommand('device-123', tenantId, command)).rejects.toThrow(
        BadRequestException
      );
    });
  });

  describe('brand-specific commands', () => {
    it('should use Danfoss-specific command values', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);

      expect(registerMappingService.getCommandValue).toHaveBeenCalledWith(
        VfdBrand.DANFOSS,
        VfdCommandType.START
      );
    });

    it('should handle different brand command mappings', async () => {
      const abbDevice = { ...mockDevice, brand: VfdBrand.ABB };
      deviceService.findById.mockResolvedValueOnce(abbDevice as VfdDevice);

      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);

      expect(registerMappingService.getCommandValue).toHaveBeenCalledWith(
        VfdBrand.ABB,
        VfdCommandType.START
      );
    });
  });

  describe('connection management', () => {
    it('should disconnect after command execution', async () => {
      const { createVfdAdapter } = require('../../adapters');
      const mockDisconnect = jest.fn().mockResolvedValue(undefined);
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockResolvedValue({ id: 'connection-123' }),
        disconnect: mockDisconnect,
        writeControlWord: jest.fn().mockResolvedValue({ success: true }),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);

      expect(mockDisconnect).toHaveBeenCalled();
    });

    it('should disconnect even on command failure', async () => {
      const { createVfdAdapter } = require('../../adapters');
      const mockDisconnect = jest.fn().mockResolvedValue(undefined);
      createVfdAdapter.mockImplementationOnce(() => ({
        connect: jest.fn().mockResolvedValue({ id: 'connection-123' }),
        disconnect: mockDisconnect,
        writeControlWord: jest.fn().mockRejectedValue(new Error('Write error')),
      }));

      const command: VfdCommandInput = { command: VfdCommandType.START };

      try {
        await service.executeCommand('device-123', tenantId, command);
      } catch {
        // Expected to throw
      }

      expect(mockDisconnect).toHaveBeenCalled();
    });
  });
});
