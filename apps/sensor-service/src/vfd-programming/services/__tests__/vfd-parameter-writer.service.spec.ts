import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { BadRequestException } from '@nestjs/common';

import { VfdParameterWriterService } from '../vfd-parameter-writer.service';
import { VfdChangeSet } from '../../entities/vfd-change-set.entity';
import { VfdChangeSetItem } from '../../entities/vfd-change-set-item.entity';
import { VfdParameterAuditLog } from '../../entities/vfd-parameter-audit-log.entity';
import { VfdParameterDefinition } from '../../entities/vfd-parameter-definition.entity';
import {
  VfdChangeSetStatus,
  VfdChangeSetItemStatus,
  VfdAuditAction,
  VfdDeviceStatus,
  VfdBrand,
  VfdProtocol,
  VfdParameterGroup,
  RiskLevel,
} from '../../../vfd/entities/vfd.enums';
import { VfdDeviceService } from '../../../vfd/services/vfd-device.service';
import { VfdCommandService } from '../../../vfd/services/vfd-command.service';
import { VfdRegisterMappingService } from '../../../vfd/services/vfd-register-mapping.service';
import { VfdDevice } from '../../../vfd/entities/vfd-device.entity';
import { BaseVfdAdapter, VfdConnectionHandle, VfdCommandResult } from '../../../vfd/adapters';

// ---- Mock adapter ----
const mockHandle: VfdConnectionHandle = {
  id: 'test-handle-1',
  protocol: VfdProtocol.MODBUS_TCP,
  isConnected: true,
  lastActivity: new Date(),
};

const createMockAdapter = () => ({
  connect: jest.fn().mockResolvedValue(mockHandle),
  disconnect: jest.fn().mockResolvedValue(undefined),
  readRegister: jest.fn(),
  writeRegister: jest.fn(),
  readParameters: jest.fn(),
  writeControlWord: jest.fn(),
  writeSpeedReference: jest.fn(),
  testConnection: jest.fn(),
  validateConfiguration: jest.fn(),
  getConfigurationSchema: jest.fn(),
  getDefaultConfiguration: jest.fn(),
});

let mockAdapter = createMockAdapter();

// Mock the createVfdAdapter factory
jest.mock('../../../vfd/adapters', () => {
  const actual = jest.requireActual('../../../vfd/adapters');
  return {
    ...actual,
    createVfdAdapter: jest.fn(() => mockAdapter),
  };
});

// ---- Test data factories ----
function createMockDevice(overrides: Partial<VfdDevice> = {}): VfdDevice {
  const device = new VfdDevice();
  device.id = 'device-1';
  device.tenantId = 'tenant-1';
  device.name = 'Test VFD';
  device.brand = VfdBrand.DANFOSS;
  device.protocol = VfdProtocol.MODBUS_TCP;
  device.protocolConfiguration = { host: '192.168.1.100', port: 502, unitId: 1 } as never;
  device.status = VfdDeviceStatus.ACTIVE;
  device.pollIntervalMs = 1000;
  device.isPollingEnabled = true;
  device.createdAt = new Date();
  device.updatedAt = new Date();
  Object.assign(device, overrides);
  return device;
}

function createMockParamDef(overrides: Partial<VfdParameterDefinition> = {}): VfdParameterDefinition {
  const def = new VfdParameterDefinition();
  def.id = 'def-1';
  def.brand = VfdBrand.DANFOSS;
  def.parameterName = 'accel_time_1';
  def.displayName = 'Acceleration Time 1';
  def.category = 'configuration';
  def.group = VfdParameterGroup.RAMP_TIMES;
  def.registerAddress = 100;
  def.registerCount = 1;
  def.functionCode = 6;
  def.dataType = 'uint16';
  def.scalingFactor = 0.1;
  def.offset = 0;
  def.byteOrder = 'big';
  def.wordOrder = 'big';
  def.riskLevel = RiskLevel.LOW;
  def.requiresMotorStop = false;
  def.isReadable = true;
  def.isWritable = true;
  def.isActive = true;
  def.displayOrder = 0;
  def.createdAt = new Date();
  def.updatedAt = new Date();
  Object.assign(def, overrides);
  return def;
}

function createMockItem(overrides: Partial<VfdChangeSetItem> = {}): VfdChangeSetItem {
  const item = new VfdChangeSetItem();
  item.id = 'item-1';
  item.changeSetId = 'cs-1';
  item.parameterDefinitionId = 'def-1';
  item.parameterName = 'accel_time_1';
  item.requestedValue = 5.0;
  item.status = VfdChangeSetItemStatus.PENDING;
  item.createdAt = new Date();
  Object.assign(item, overrides);
  return item;
}

function createMockChangeSet(overrides: Partial<VfdChangeSet> = {}): VfdChangeSet {
  const cs = new VfdChangeSet();
  cs.id = 'cs-1';
  cs.tenantId = 'tenant-1';
  cs.vfdDeviceId = 'device-1';
  cs.status = VfdChangeSetStatus.APPROVED;
  cs.description = 'Test change set';
  cs.createdBy = 'user-1';
  cs.items = [createMockItem()];
  cs.createdAt = new Date();
  cs.updatedAt = new Date();
  Object.assign(cs, overrides);
  return cs;
}

/**
 * Create a Buffer with a uint16 BE value (simulating a register read).
 */
function uint16Buffer(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16BE(value, 0);
  return buf;
}

describe('VfdParameterWriterService', () => {
  let service: VfdParameterWriterService;
  let changeSetRepo: jest.Mocked<Repository<VfdChangeSet>>;
  let changeSetItemRepo: jest.Mocked<Repository<VfdChangeSetItem>>;
  let auditLogRepo: jest.Mocked<Repository<VfdParameterAuditLog>>;
  let paramDefRepo: jest.Mocked<Repository<VfdParameterDefinition>>;
  let deviceService: jest.Mocked<VfdDeviceService>;
  let commandService: jest.Mocked<VfdCommandService>;
  let registerMappingService: jest.Mocked<VfdRegisterMappingService>;
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    // Reset mock adapter for each test
    mockAdapter = createMockAdapter();
    const { createVfdAdapter } = require('../../../vfd/adapters');
    (createVfdAdapter as jest.Mock).mockReturnValue(mockAdapter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdParameterWriterService,
        {
          provide: getRepositoryToken(VfdChangeSet),
          useValue: {
            save: jest.fn().mockImplementation((entity: VfdChangeSet) => Promise.resolve(entity)),
            findByIds: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(VfdChangeSetItem),
          useValue: {
            save: jest.fn().mockImplementation((entity: VfdChangeSetItem) => Promise.resolve(entity)),
          },
        },
        {
          provide: getRepositoryToken(VfdParameterAuditLog),
          useValue: {
            create: jest.fn().mockImplementation((data: Partial<VfdParameterAuditLog>) => data),
            save: jest.fn().mockImplementation((entity: Partial<VfdParameterAuditLog>) => Promise.resolve(entity)),
          },
        },
        {
          provide: getRepositoryToken(VfdParameterDefinition),
          useValue: {
            findByIds: jest.fn(),
          },
        },
        {
          provide: VfdDeviceService,
          useValue: {
            findById: jest.fn(),
          },
        },
        {
          provide: VfdCommandService,
          useValue: {},
        },
        {
          provide: VfdRegisterMappingService,
          useValue: {
            getStatusWordMapping: jest.fn(),
          },
        },
        {
          provide: EventEmitter2,
          useValue: {
            emit: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get(VfdParameterWriterService);
    changeSetRepo = module.get(getRepositoryToken(VfdChangeSet));
    changeSetItemRepo = module.get(getRepositoryToken(VfdChangeSetItem));
    auditLogRepo = module.get(getRepositoryToken(VfdParameterAuditLog));
    paramDefRepo = module.get(getRepositoryToken(VfdParameterDefinition));
    deviceService = module.get(VfdDeviceService);
    commandService = module.get(VfdCommandService);
    registerMappingService = module.get(VfdRegisterMappingService);
    eventEmitter = module.get(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('applyChangeSet - successful apply', () => {
    it('should read-back, write, verify, and mark all items APPLIED', async () => {
      const def = createMockParamDef();
      const item = createMockItem({ requestedValue: 5.0 });
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      // scalingFactor = 0.1 => raw for 5.0 = 50
      // Read current: raw 30 => engineering 3.0
      mockAdapter.readRegister
        .mockResolvedValueOnce(uint16Buffer(30))  // read current value
        .mockResolvedValueOnce(uint16Buffer(50));  // read-back verification

      mockAdapter.writeRegister.mockResolvedValue({
        success: true,
        acknowledgedAt: new Date(),
        latencyMs: 10,
      } as VfdCommandResult);

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.APPLIED);
      expect(item.previousValue).toBe(3.0);  // 30 * 0.1
      expect(item.appliedValue).toBe(5.0);   // 50 * 0.1
      expect(item.status).toBe(VfdChangeSetItemStatus.APPLIED);
      expect(eventEmitter.emit).toHaveBeenCalledWith('vfd.changeset.applied', {
        changeSetId: 'cs-1',
      });
      expect(auditLogRepo.save).toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - write failure with rollback', () => {
    it('should mark item FAILED and change set FAILED when write throws', async () => {
      const def = createMockParamDef();
      const item = createMockItem();
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      mockAdapter.readRegister.mockResolvedValue(uint16Buffer(30));
      mockAdapter.writeRegister.mockRejectedValue(new Error('Communication error'));

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.FAILED);
      expect(item.status).toBe(VfdChangeSetItemStatus.FAILED);
      expect(item.errorMessage).toContain('Communication error');
      expect(eventEmitter.emit).toHaveBeenCalledWith('vfd.changeset.failed', {
        changeSetId: 'cs-1',
      });
    });
  });

  describe('applyChangeSet - motor running + requiresMotorStop', () => {
    it('should abort before any writes when motor is running', async () => {
      const def = createMockParamDef({ requiresMotorStop: true });
      const item = createMockItem();
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      // Status word mapping
      registerMappingService.getStatusWordMapping.mockResolvedValue({
        registerAddress: 8451,
        registerCount: 1,
        functionCode: 3,
        parameterName: 'status_word',
      } as never);

      // Status word with bit 2 set (0x0004 = operation enabled / motor running)
      mockAdapter.readRegister.mockResolvedValue(uint16Buffer(0x0007));

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(BadRequestException);

      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      // No write should have been attempted
      expect(mockAdapter.writeRegister).not.toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - motor state unverifiable (fail-closed)', () => {
    it('should refuse the write when no status-word mapping exists for the brand', async () => {
      const def = createMockParamDef({ requiresMotorStop: true });
      const item = createMockItem();
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      // No status-word mapping -> motor state cannot be verified
      registerMappingService.getStatusWordMapping.mockResolvedValue(null);

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(BadRequestException);
      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(/cannot verify motor state/i);

      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      // Fail-closed: no register read against the drive, no write attempted
      expect(mockAdapter.writeRegister).not.toHaveBeenCalled();
    });

    it('should refuse the write when the status word cannot be read', async () => {
      const def = createMockParamDef({ requiresMotorStop: true });
      const item = createMockItem();
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      registerMappingService.getStatusWordMapping.mockResolvedValue({
        registerAddress: 8451,
        registerCount: 1,
        functionCode: 3,
        parameterName: 'status_word',
      } as never);

      // The status-word read fails -> we cannot confirm the motor is stopped
      mockAdapter.readRegister.mockRejectedValue(new Error('Modbus timeout'));

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(BadRequestException);

      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      expect(mockAdapter.writeRegister).not.toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - device offline', () => {
    it('should throw BadRequestException when device is not ACTIVE', async () => {
      const def = createMockParamDef();
      const item = createMockItem();
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice({ status: VfdDeviceStatus.OFFLINE });

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(BadRequestException);

      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      expect(mockAdapter.writeRegister).not.toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - read-back mismatch', () => {
    it('should mark item FAILED when verified value does not match requested', async () => {
      const def = createMockParamDef({ scalingFactor: 0.1 });
      const item = createMockItem({ requestedValue: 5.0 });
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      // Read current: raw 30
      // Read-back after write: raw 100 => engineering 10.0 (expected 5.0)
      mockAdapter.readRegister
        .mockResolvedValueOnce(uint16Buffer(30))
        .mockResolvedValueOnce(uint16Buffer(100));

      mockAdapter.writeRegister.mockResolvedValue({
        success: true,
        acknowledgedAt: new Date(),
        latencyMs: 5,
      } as VfdCommandResult);

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.FAILED);
      expect(item.status).toBe(VfdChangeSetItemStatus.FAILED);
      expect(item.errorMessage).toContain('Read-back mismatch');
      expect(item.errorMessage).toContain('expected 5');
    });
  });

  describe('applyChangeSet - best-effort rollback', () => {
    it('should rollback first item when second item fails', async () => {
      const def1 = createMockParamDef({
        id: 'def-1',
        parameterName: 'accel_time_1',
        registerAddress: 100,
        displayOrder: 0,
      });
      const def2 = createMockParamDef({
        id: 'def-2',
        parameterName: 'decel_time_1',
        registerAddress: 200,
        displayOrder: 1,
      });
      const def3 = createMockParamDef({
        id: 'def-3',
        parameterName: 'max_frequency',
        registerAddress: 300,
        displayOrder: 2,
      });

      const item1 = createMockItem({
        id: 'item-1',
        parameterDefinitionId: 'def-1',
        parameterName: 'accel_time_1',
        requestedValue: 5.0,
      });
      const item2 = createMockItem({
        id: 'item-2',
        parameterDefinitionId: 'def-2',
        parameterName: 'decel_time_1',
        requestedValue: 10.0,
      });
      const item3 = createMockItem({
        id: 'item-3',
        parameterDefinitionId: 'def-3',
        parameterName: 'max_frequency',
        requestedValue: 50.0,
      });

      const changeSet = createMockChangeSet({ items: [item1, item2, item3] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def1, def2, def3]);

      // Item 1: read=30, write success, verify=50 (matches 5.0)
      // Item 2: read=60, write FAILS
      // Item 3: read=400, write success, verify=500 (matches 50.0) — but second failed so it continues
      mockAdapter.readRegister
        .mockResolvedValueOnce(uint16Buffer(30))   // item1 read current
        .mockResolvedValueOnce(uint16Buffer(50))   // item1 verify
        .mockResolvedValueOnce(uint16Buffer(60));  // item2 read current

      let writeCallCount = 0;
      mockAdapter.writeRegister.mockImplementation(
        (_handle: VfdConnectionHandle, address: number, _value: number) => {
          writeCallCount++;
          if (address === 200) {
            // item2 write fails
            return Promise.reject(new Error('Communication timeout'));
          }
          // item1 write succeeds, rollback write succeeds
          return Promise.resolve({
            success: true,
            acknowledgedAt: new Date(),
            latencyMs: 5,
          } as VfdCommandResult);
        },
      );

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.FAILED);
      expect(item1.status).toBe(VfdChangeSetItemStatus.ROLLED_BACK);
      expect(item2.status).toBe(VfdChangeSetItemStatus.FAILED);
      expect(item2.errorMessage).toContain('Communication timeout');
    });
  });

  describe('applyChangeSet - audit log written', () => {
    it('should create audit log entries for each item', async () => {
      const def = createMockParamDef();
      const item = createMockItem({ requestedValue: 5.0 });
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      mockAdapter.readRegister
        .mockResolvedValueOnce(uint16Buffer(30))
        .mockResolvedValueOnce(uint16Buffer(50));

      mockAdapter.writeRegister.mockResolvedValue({
        success: true,
        acknowledgedAt: new Date(),
        latencyMs: 5,
      } as VfdCommandResult);

      await service.applyChangeSet(changeSet);

      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          vfdDeviceId: 'device-1',
          changeSetId: 'cs-1',
          parameterName: 'accel_time_1',
          action: VfdAuditAction.APPLY,
          performedBy: 'user-1',
        }),
      );
      expect(auditLogRepo.save).toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - communication retry', () => {
    it('should retry write and succeed on second attempt', async () => {
      const def = createMockParamDef();
      const item = createMockItem({ requestedValue: 5.0 });
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      mockAdapter.readRegister
        .mockResolvedValueOnce(uint16Buffer(30))
        .mockResolvedValueOnce(uint16Buffer(50));

      // First write fails, second succeeds
      mockAdapter.writeRegister
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce({
          success: true,
          acknowledgedAt: new Date(),
          latencyMs: 8,
        } as VfdCommandResult);

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.APPLIED);
      expect(item.status).toBe(VfdChangeSetItemStatus.APPLIED);
      expect(mockAdapter.writeRegister).toHaveBeenCalledTimes(2);
    });
  });

  describe('writeAuditLog', () => {
    it('should create and save an audit log entry', async () => {
      const savedEntry = {
        tenantId: 'tenant-1',
        vfdDeviceId: 'device-1',
        changeSetId: 'cs-1',
        parameterName: 'accel_time_1',
        previousValue: 3.0,
        newValue: 5.0,
        action: VfdAuditAction.APPLY,
        performedBy: 'user-1',
      };

      auditLogRepo.create.mockReturnValue(savedEntry as VfdParameterAuditLog);
      auditLogRepo.save.mockResolvedValue(savedEntry as VfdParameterAuditLog);

      const result = await service.writeAuditLog(
        'tenant-1',
        'device-1',
        'cs-1',
        'accel_time_1',
        3.0,
        5.0,
        VfdAuditAction.APPLY,
        'user-1',
      );

      expect(auditLogRepo.create).toHaveBeenCalledWith({
        tenantId: 'tenant-1',
        vfdDeviceId: 'device-1',
        changeSetId: 'cs-1',
        parameterName: 'accel_time_1',
        previousValue: 3.0,
        newValue: 5.0,
        action: VfdAuditAction.APPLY,
        performedBy: 'user-1',
        automationRuleId: undefined,
      });
      expect(result).toEqual(savedEntry);
    });
  });
});
