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
import { VfdDriveBindingService } from '../vfd-drive-binding.service';
import { VfdEdgeWriteService } from '../vfd-edge-write.service';
import { VfdRegisterMappingService } from '../vfd-register-mapping.service';

describe('VfdCommandService', () => {
  let service: VfdCommandService;
  let deviceService: jest.Mocked<VfdDeviceService>;
  let registerMappingService: jest.Mocked<VfdRegisterMappingService>;
  let edgeWriteService: jest.Mocked<VfdEdgeWriteService>;
  let driveBindingService: jest.Mocked<VfdDriveBindingService>;

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
    // SENSOR-CRITICAL-007: bound to an edge gateway so the edge-delegated write
    // path can dispatch (an unbound drive fails closed — covered separately).
    edgeDeviceId: 'edge-1',
    edgeModbusDeviceName: 'vfd-pump-1',
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
          // The gate that decides whether this drive may move a shaft at all.
          // Default: attested, so the command tests below are about commands.
          provide: VfdDriveBindingService,
          useValue: {
            assertActuable: jest.fn().mockResolvedValue(undefined),
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
          // SENSOR-CRITICAL-007: the edge-delegated write primitive. Default
          // resolves a real success ack; individual tests override it to
          // exercise edge-reported failure / fail-closed.
          provide: VfdEdgeWriteService,
          useValue: {
            writeRegister: jest
              .fn()
              .mockResolvedValue({ success: true, commandId: 'cmd-1', latencyMs: 5 }),
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
    edgeWriteService = module.get(VfdEdgeWriteService);
    driveBindingService = module.get(VfdDriveBindingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('the equipment-binding gate', () => {
    it('refuses the command when the drive is not bound to the equipment it drives', async () => {
      driveBindingService.assertActuable.mockRejectedValueOnce(
        new BadRequestException('VFD device-123 is not bound to the equipment it drives.'),
      );

      await expect(
        service.executeCommand('device-123', tenantId, { command: VfdCommandType.START }),
      ).rejects.toThrow(BadRequestException);

      // Nothing reached the wire. An unbound drive fails closed rather than
      // spinning something nobody recorded.
      expect(edgeWriteService.writeRegister).not.toHaveBeenCalled();
    });

    it('refuses the command when the binding is stale', async () => {
      driveBindingService.assertActuable.mockRejectedValueOnce(
        new BadRequestException("VFD device-123's equipment binding has aged out."),
      );

      await expect(
        service.executeCommand('device-123', tenantId, { command: VfdCommandType.SET_FREQUENCY, value: 40 }),
      ).rejects.toThrow(/aged out/);
      expect(edgeWriteService.writeRegister).not.toHaveBeenCalled();
    });

    it('consults the gate before every command, including EMERGENCY_STOP', async () => {
      await service.executeCommand('device-123', tenantId, {
        command: VfdCommandType.EMERGENCY_STOP,
      });

      expect(driveBindingService.assertActuable).toHaveBeenCalledWith('device-123', tenantId);
    });
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

    it('dispatches regardless of the stored cloud connection status', async () => {
      // The write path is edge-delegated now, so the cloud `connectionStatus`
      // (a legacy cloud-poll artifact) has no bearing on command dispatch — the
      // edge gateway owns the live link. A stale `isConnected: false` must not
      // block a command.
      const disconnectedDevice = {
        ...mockDevice,
        connectionStatus: { isConnected: false },
      };
      deviceService.findById.mockResolvedValueOnce(disconnectedDevice as VfdDevice);

      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(true);
    });

    it('dispatches START to the edge gateway with the control-word register', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);

      // Control-word register from the mapping; wire value from the brand
      // command word; human-readable intent for the audit/log trail.
      expect(edgeWriteService.writeRegister).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'device-123' }),
        mockControlMapping.registerAddress,
        expect.any(Number),
        'START',
      );
    });

    it('should return latency in result', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.latencyMs).toBeDefined();
      expect(typeof result.latencyMs).toBe('number');
    });

    it('reports an edge-reported write failure honestly (no fabricated success)', async () => {
      edgeWriteService.writeRegister.mockResolvedValueOnce({
        success: false,
        commandId: 'cmd-2',
        error: 'Write failed',
      });

      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Write failed');
    });

    it('EMERGENCY_STOP never returns success without a real edge ack (SENSOR-CRITICAL-007)', async () => {
      // The pre-fix hazard: a fake adapter returned success:true without
      // transmitting. Now an edge timeout / no-ack yields success:false.
      edgeWriteService.writeRegister.mockResolvedValueOnce({
        success: false,
        commandId: 'cmd-estop',
        error: 'Edge gateway did not acknowledge the write within the timeout',
      });

      const command: VfdCommandInput = { command: VfdCommandType.EMERGENCY_STOP };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/did not acknowledge/i);
    });

    it('fails closed when the drive is not bound to an edge gateway', async () => {
      // The primitive throws for an unbound drive; executeCommand swallows the
      // throw into an honest { success:false, error } result — never a success.
      edgeWriteService.writeRegister.mockRejectedValueOnce(
        new BadRequestException('VFD device-123 is not bound to an edge gateway'),
      );

      const command: VfdCommandInput = { command: VfdCommandType.START };

      const result = await service.executeCommand('device-123', tenantId, command);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/not bound to an edge gateway/i);
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

  describe('edge dispatch', () => {
    // The in-process connection pool (connect/disconnect/closeConnection) was
    // retired — every command is a discrete edge-delegated write. There is no
    // cloud socket to pool or release.
    it('issues one discrete edge write per command (no pooling)', async () => {
      const command: VfdCommandInput = { command: VfdCommandType.START };

      await service.executeCommand('device-123', tenantId, command);
      await service.executeCommand('device-123', tenantId, command);

      expect(edgeWriteService.writeRegister).toHaveBeenCalledTimes(2);
    });
  });
});
