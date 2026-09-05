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
import { VfdEdgeReadService, VfdEdgeReadResult } from '../../../vfd/services/vfd-edge-read.service';
import {
  VfdEdgeWriteService,
  VfdEdgeWriteResult,
} from '../../../vfd/services/vfd-edge-write.service';
import { VfdDevice } from '../../../vfd/entities/vfd-device.entity';

// ---- Edge I/O result helpers ----
function readOk(rawValue: number): VfdEdgeReadResult {
  return { success: true, commandId: 'r-1', found: true, rawValue, latencyMs: 4 };
}
function readMiss(error: string): VfdEdgeReadResult {
  return { success: false, commandId: 'r-1', found: false, error };
}
function writeOk(): VfdEdgeWriteResult {
  return { success: true, commandId: 'w-1', latencyMs: 6 };
}
function writeFail(error: string): VfdEdgeWriteResult {
  return { success: false, commandId: 'w-1', error };
}

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
  // Edge-bound so the (real) edge primitives would dispatch; harmless for mocks.
  device.edgeDeviceId = 'edge-1';
  device.edgeModbusDeviceName = 'vfd-pump-1';
  device.createdAt = new Date();
  device.updatedAt = new Date();
  Object.assign(device, overrides);
  return device;
}

function createMockParamDef(
  overrides: Partial<VfdParameterDefinition> = {},
): VfdParameterDefinition {
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

describe('VfdParameterWriterService', () => {
  let service: VfdParameterWriterService;
  let changeSetRepo: jest.Mocked<Repository<VfdChangeSet>>;
  let changeSetItemRepo: jest.Mocked<Repository<VfdChangeSetItem>>;
  let auditLogRepo: jest.Mocked<Repository<VfdParameterAuditLog>>;
  let paramDefRepo: jest.Mocked<Repository<VfdParameterDefinition>>;
  let deviceService: jest.Mocked<VfdDeviceService>;
  let registerMappingService: jest.Mocked<VfdRegisterMappingService>;
  let edgeReadService: { readRegister: jest.Mock };
  let edgeWriteService: { writeRegister: jest.Mock };
  let eventEmitter: jest.Mocked<EventEmitter2>;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VfdParameterWriterService,
        {
          provide: getRepositoryToken(VfdChangeSet),
          useValue: {
            save: jest.fn().mockImplementation((entity: VfdChangeSet) => Promise.resolve(entity)),
            // Conditional claim (1818's one-active-per-device guard):
            // the happy path admits exactly one applier.
            update: jest.fn().mockResolvedValue({ affected: 1, generatedMaps: [] }),
            findByIds: jest.fn(),
          },
        },
        {
          provide: getRepositoryToken(VfdChangeSetItem),
          useValue: {
            save: jest
              .fn()
              .mockImplementation((entity: VfdChangeSetItem) => Promise.resolve(entity)),
          },
        },
        {
          provide: getRepositoryToken(VfdParameterAuditLog),
          useValue: {
            create: jest.fn().mockImplementation((data: Partial<VfdParameterAuditLog>) => data),
            save: jest
              .fn()
              .mockImplementation((entity: Partial<VfdParameterAuditLog>) =>
                Promise.resolve(entity),
              ),
          },
        },
        {
          provide: getRepositoryToken(VfdParameterDefinition),
          useValue: { findByIds: jest.fn() },
        },
        { provide: VfdDeviceService, useValue: { findById: jest.fn() } },
        { provide: VfdCommandService, useValue: {} },
        { provide: VfdRegisterMappingService, useValue: { getStatusWordMapping: jest.fn() } },
        { provide: VfdEdgeReadService, useValue: { readRegister: jest.fn() } },
        { provide: VfdEdgeWriteService, useValue: { writeRegister: jest.fn() } },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
      ],
    }).compile();

    service = module.get(VfdParameterWriterService);
    changeSetRepo = module.get(getRepositoryToken(VfdChangeSet));
    changeSetItemRepo = module.get(getRepositoryToken(VfdChangeSetItem));
    auditLogRepo = module.get(getRepositoryToken(VfdParameterAuditLog));
    paramDefRepo = module.get(getRepositoryToken(VfdParameterDefinition));
    deviceService = module.get(VfdDeviceService);
    registerMappingService = module.get(VfdRegisterMappingService);
    edgeReadService = module.get(VfdEdgeReadService);
    edgeWriteService = module.get(VfdEdgeWriteService);
    eventEmitter = module.get(EventEmitter2);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('applyChangeSet - successful apply', () => {
    it('reads current, edge-writes (readback-verified), and marks all items APPLIED', async () => {
      const def = createMockParamDef();
      const item = createMockItem({ requestedValue: 5.0 });
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      // scalingFactor 0.1 => current raw 30 => engineering 3.0; requested 5.0 => wire 50.
      edgeReadService.readRegister.mockResolvedValue(readOk(30));
      edgeWriteService.writeRegister.mockResolvedValue(writeOk());

      const result = await service.applyChangeSet(changeSet);

      // Edge readback-verified every write inline, so the set reaches VERIFIED.
      expect(result.status).toBe(VfdChangeSetStatus.VERIFIED);
      expect(item.previousValue).toBe(3.0);
      expect(item.appliedValue).toBe(5.0); // wire 50 * 0.1
      expect(item.status).toBe(VfdChangeSetItemStatus.APPLIED);
      // The edge received the exact wire value, not the engineering value.
      expect(edgeWriteService.writeRegister).toHaveBeenCalledWith(
        device,
        100,
        50,
        expect.any(String),
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith('vfd.changeset.applied', {
        changeSetId: 'cs-1',
      });
      expect(eventEmitter.emit).toHaveBeenCalledWith('vfd.changeset.verified', {
        changeSetId: 'cs-1',
      });
      expect(auditLogRepo.save).toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - write failure with rollback', () => {
    it('marks item FAILED and change set FAILED when the edge write throws', async () => {
      const def = createMockParamDef();
      const item = createMockItem();
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);
      edgeReadService.readRegister.mockResolvedValue(readOk(30));
      edgeWriteService.writeRegister.mockRejectedValue(new Error('Communication error'));

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
    it('aborts before any writes when the edge reports the motor running', async () => {
      const def = createMockParamDef({ requiresMotorStop: true });
      const changeSet = createMockChangeSet({ items: [createMockItem()] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);
      registerMappingService.getStatusWordMapping.mockResolvedValue({
        registerAddress: 8451,
        registerCount: 1,
        functionCode: 3,
        parameterName: 'status_word',
      } as never);
      // Status word 0x0007 → bit 2 set (operation enabled / running).
      edgeReadService.readRegister.mockResolvedValue(readOk(0x0007));

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(BadRequestException);
      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      expect(edgeWriteService.writeRegister).not.toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - motor state unverifiable (fail-closed)', () => {
    it('refuses the write when no status-word mapping exists for the brand', async () => {
      const def = createMockParamDef({ requiresMotorStop: true });
      const changeSet = createMockChangeSet({ items: [createMockItem()] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);
      registerMappingService.getStatusWordMapping.mockResolvedValue(null);

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(/cannot verify motor state/i);
      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      // Fail-closed: no read against the drive, no write attempted.
      expect(edgeReadService.readRegister).not.toHaveBeenCalled();
      expect(edgeWriteService.writeRegister).not.toHaveBeenCalled();
    });

    it('refuses the write when the status word cannot be read from the edge', async () => {
      const def = createMockParamDef({ requiresMotorStop: true });
      const changeSet = createMockChangeSet({ items: [createMockItem()] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);
      registerMappingService.getStatusWordMapping.mockResolvedValue({
        registerAddress: 8451,
        registerCount: 1,
        functionCode: 3,
        parameterName: 'status_word',
      } as never);
      // The edge could not read the status word → motor state unknowable.
      edgeReadService.readRegister.mockResolvedValue(readMiss('Modbus timeout'));

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(/cannot verify motor state/i);
      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      expect(edgeWriteService.writeRegister).not.toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - device offline', () => {
    it('throws BadRequestException when device is not ACTIVE', async () => {
      const def = createMockParamDef();
      const changeSet = createMockChangeSet({ items: [createMockItem()] });
      const device = createMockDevice({ status: VfdDeviceStatus.OFFLINE });

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);

      await expect(service.applyChangeSet(changeSet)).rejects.toThrow(BadRequestException);
      expect(changeSet.status).toBe(VfdChangeSetStatus.FAILED);
      expect(edgeWriteService.writeRegister).not.toHaveBeenCalled();
    });
  });

  describe('applyChangeSet - edge readback mismatch', () => {
    it('marks item FAILED when the edge write ack reports a readback mismatch', async () => {
      const def = createMockParamDef({ scalingFactor: 0.1 });
      const item = createMockItem({ requestedValue: 5.0 });
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);
      edgeReadService.readRegister.mockResolvedValue(readOk(30));
      // The edge's readback verify failed on the drive.
      edgeWriteService.writeRegister.mockResolvedValue(
        writeFail('readback mismatch for register 100: expected 50, got 100'),
      );

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.FAILED);
      expect(item.status).toBe(VfdChangeSetItemStatus.FAILED);
      expect(item.errorMessage).toContain('readback mismatch');
    });
  });

  describe('applyChangeSet - best-effort rollback', () => {
    it('rolls back the first item when a later item fails', async () => {
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

      // Current-value read per item, keyed by register address.
      edgeReadService.readRegister.mockImplementation((_device: VfdDevice, address: number) => {
        const raw = address === 100 ? 30 : address === 200 ? 60 : 400;
        return Promise.resolve(readOk(raw));
      });

      // item2's register (200) write fails; every other write (incl. rollback) succeeds.
      edgeWriteService.writeRegister.mockImplementation((_device: VfdDevice, address: number) => {
        if (address === 200) return Promise.reject(new Error('Communication timeout'));
        return Promise.resolve(writeOk());
      });

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.FAILED);
      expect(item1.status).toBe(VfdChangeSetItemStatus.ROLLED_BACK);
      expect(item2.status).toBe(VfdChangeSetItemStatus.FAILED);
      expect(item2.errorMessage).toContain('Communication timeout');
    });
  });

  describe('applyChangeSet - audit log written', () => {
    it('creates audit log entries for each item', async () => {
      const def = createMockParamDef();
      const changeSet = createMockChangeSet({ items: [createMockItem({ requestedValue: 5.0 })] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);
      edgeReadService.readRegister.mockResolvedValue(readOk(30));
      edgeWriteService.writeRegister.mockResolvedValue(writeOk());

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
    it('retries the edge write and succeeds on the second attempt', async () => {
      const def = createMockParamDef();
      const item = createMockItem({ requestedValue: 5.0 });
      const changeSet = createMockChangeSet({ items: [item] });
      const device = createMockDevice();

      deviceService.findById.mockResolvedValue(device);
      paramDefRepo.findByIds.mockResolvedValue([def]);
      edgeReadService.readRegister.mockResolvedValue(readOk(30));
      edgeWriteService.writeRegister
        .mockRejectedValueOnce(new Error('Transient error'))
        .mockResolvedValueOnce(writeOk());

      const result = await service.applyChangeSet(changeSet);

      expect(result.status).toBe(VfdChangeSetStatus.VERIFIED);
      expect(item.status).toBe(VfdChangeSetItemStatus.APPLIED);
      expect(edgeWriteService.writeRegister).toHaveBeenCalledTimes(2);
    });
  });

  describe('writeAuditLog', () => {
    it('creates and saves an audit log entry', async () => {
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
